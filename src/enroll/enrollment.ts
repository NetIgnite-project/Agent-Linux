import { z } from "zod";
import type { ServerUrl } from "../net/serverUrl";
import { AppConstants } from "../utils/constants";
import { AppError } from "../utils/errors";

/**
 * Enrollment (`pair`): the agent generates its own secret and redeems a single-use enrollment
 * token from the dashboard with `POST /api/v1/agents/enroll`. The server stores only the
 * secret's hash and answers with the token id the agent connects with.
 */
export class Enrollment {
	static readonly ENROLLMENT_TOKEN_PREFIX = `${AppConstants.APP_KEYS_PREFIX}_enroll_`;
	static readonly ENROLL_PATH = "/api/v1/agents/enroll";
	static readonly TIMEOUT_MS = 15_000;

	static readonly Response = z.object({
		success: z.literal(true),
		data: z.object({
			agent_id: z.number().int().positive(),
			kind: z.string(),
			token_id: z.string().min(1).max(256),
		}),
	});

	static readonly ErrorResponse = z.object({ message: z.string() });

	/** 32 random bytes as 64 hex characters (matches the server's `^[A-Za-z0-9_-]{32,128}$`). */
	static generateSecret() {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		return Buffer.from(bytes).toString("hex");
	}

	/** Whether a string looks like an enrollment token (`netignite_enroll_<id>:<base>`). */
	static isEnrollmentToken(token: string) {
		if (token.length > 256 || !token.startsWith(Enrollment.ENROLLMENT_TOKEN_PREFIX)) return false;
		return /^[^:\s]+:[^:\s]+$/.test(token.slice(Enrollment.ENROLLMENT_TOKEN_PREFIX.length));
	}

	static async enroll(
		server: ServerUrl,
		enrollmentToken: string,
		secret: string,
		fetchImpl: typeof fetch = fetch,
	): Promise<Enrollment.Result> {
		if (!Enrollment.isEnrollmentToken(enrollmentToken)) {
			throw new EnrollmentError(
				`That doesn't look like an enrollment token (they start with "${Enrollment.ENROLLMENT_TOKEN_PREFIX}"). Copy the pair command from the agent's page in the dashboard.`,
			);
		}

		const url = server.httpUrl(Enrollment.ENROLL_PATH);
		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"User-Agent": `${AppConstants.BINARY_NAME}/${AppConstants.version()}`,
				},
				body: JSON.stringify({ enrollment_token: enrollmentToken, secret }),
				signal: AbortSignal.timeout(Enrollment.TIMEOUT_MS),
				// A redirect would turn the POST into a GET; tell the user the right URL instead.
				redirect: "manual",
			});
		} catch (error) {
			const reason = error instanceof globalThis.Error ? error.message : String(error);
			throw new EnrollmentError(`Couldn't reach the server at ${server.toString()}: ${reason}`);
		}

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			throw new EnrollmentError(
				`The server redirects ${url} to ${location ?? "another address"}. Use the server's final URL (for example https:// instead of http://).`,
			);
		}

		const body: unknown = await response.json().catch(() => null);
		const message = Enrollment.ErrorResponse.safeParse(body).data?.message;

		if (response.status === 401) {
			throw new EnrollmentError(
				"The server rejected the enrollment token: it is unknown, already used or expired (tokens are valid for 15 minutes and work once). Create a new one in the dashboard.",
			);
		}
		if (response.status === 429) {
			throw new EnrollmentError("Too many enrollment attempts. Wait a few minutes and try again.");
		}
		if (response.status === 404) {
			throw new EnrollmentError(
				`No NetIgnite server answered at ${url} (404). Check the server URL, including any sub-path.`,
			);
		}
		if (!response.ok) {
			throw new EnrollmentError(
				`Enrollment failed (HTTP ${response.status})${message ? `: ${message}` : ""}`,
			);
		}

		const parsed = Enrollment.Response.safeParse(body);
		if (!parsed.success) {
			throw new EnrollmentError(`Unexpected answer from ${url}. Is this a NetIgnite v2 server?`);
		}

		const result = parsed.data.data;
		if (result.kind === "esp32") {
			throw new EnrollmentError(
				`Agent ${result.agent_id} is an ESP32 agent, so this enrollment token is for an ESP32, not for this Linux machine. ` +
					"The server already replaced that ESP32's credential: set it up again from the dashboard. " +
					"For this machine, create an agent of type Linux in the dashboard and use its pair command.",
			);
		}
		if (result.kind !== AppConstants.AGENT_KIND) {
			throw new EnrollmentError(
				`This enrollment token belongs to an agent of kind "${result.kind}", not "${AppConstants.AGENT_KIND}". ` +
					"Create an agent of type Linux in the dashboard and use its pair command.",
			);
		}

		return { agent_id: result.agent_id, kind: result.kind, token_id: result.token_id };
	}
}

export namespace Enrollment {
	export type Result = { agent_id: number; kind: string; token_id: string };
}

export class EnrollmentError extends AppError {}
