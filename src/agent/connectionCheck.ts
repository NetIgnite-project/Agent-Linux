import type { ServerUrl } from "../net/serverUrl";
import { AppConstants } from "../utils/constants";
import { AgentClient } from "./agentClient";

/** Quick checks for `status`: is the server reachable, and does it accept the credential? */
export class ConnectionCheck {
	static readonly TIMEOUT_MS = 5000;

	/** `GET /api/health` of the server. */
	static async health(server: ServerUrl): Promise<ConnectionCheck.Result> {
		const url = server.httpUrl("/api/health");
		try {
			const response = await fetch(url, {
				headers: { "User-Agent": `${AppConstants.BINARY_NAME}/${AppConstants.version()}` },
				signal: AbortSignal.timeout(ConnectionCheck.TIMEOUT_MS),
			});
			return response.ok
				? { ok: true, detail: "reachable" }
				: { ok: false, detail: `${url} answered HTTP ${response.status}` };
		} catch (error) {
			return { ok: false, detail: `unreachable (${error instanceof Error ? error.message : error})` };
		}
	}

	/**
	 * Sends the agent WebSocket handshake and drops the connection right away. Only for when the
	 * service isn't running: the server keeps one connection per agent and would drop the
	 * service's.
	 */
	static async credential(url: string, credential: string): Promise<ConnectionCheck.Result> {
		const status = await AgentClient.probeUpgrade(url, credential);
		if (status === 101) return { ok: true, detail: "accepted" };
		if (status === 401) {
			return {
				ok: false,
				detail: `rejected (HTTP 401): revoked, or the agent was deleted. Pair again: sudo ${AppConstants.BINARY_NAME} pair <server-url> <enrollment-token>`,
			};
		}
		if (status === null) return { ok: false, detail: "no answer" };
		return {
			ok: false,
			detail: `HTTP ${status} on ${url}: is this a NetIgnite v2 server (and does a proxy pass WebSockets through)?`,
		};
	}
}

export namespace ConnectionCheck {
	export type Result = { ok: boolean; detail: string };
}
