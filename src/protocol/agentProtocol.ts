import { isIP } from "node:net";
import { z } from "zod";
import { MacAddress } from "../net/macAddress";
import { SshKeys } from "../ssh/sshKeys";

/**
 * NetIgnite agent protocol, version 2 — the agent's side of the server's
 * `server/lib/agents/protocol.ts`.
 *
 * One WebSocket to `/ws/agent` (`Authorization: Bearer netignite_agent_<token_id>:<secret>`),
 * JSON text frames:
 *
 * - `{ "t": "req", "id": <u32>, "cmd": "WAKE", "p": { ... } }`: a request (server → agent)
 * - `{ "t": "res", "id": <u32>, "ok": true, "p": { ... } }`: the answer, same `id`
 * - `{ "t": "res", "id": <u32>, "ok": false, "err": "..." }`: a failed request
 * - `{ "t": "evt", "cmd": "HELLO", "p": { ... } }`: an event without an answer (agent → server)
 *
 * The first frame the agent sends is `HELLO`.
 */
export namespace AgentProtocol {
	export const VERSION = 2;

	/** The agent WebSocket, below the server's base path. */
	export const WS_PATH = "/ws/agent";

	/** Largest frame the server accepts from an agent. */
	export const MAX_FRAME_BYTES = 64 * 1024;

	/** The agent runs on the machine it reports and controls (always on). */
	export const HOST_CAPABILITIES = ["host.status", "host.control"] as const;
	/**
	 * Wake-on-LAN mode: wakes and checks other devices on the network, and logs in to them over
	 * SSH (`SSH_CHECK`, `SSH_EXEC`).
	 */
	export const WOL_CAPABILITIES = [
		"wake",
		"status.link_local",
		"status.ip",
		"status.host",
		"status.tcp",
		"ssh",
	] as const;
	export type Capability = (typeof HOST_CAPABILITIES)[number] | (typeof WOL_CAPABILITIES)[number];

	export function capabilities(wolEnabled: boolean): Capability[] {
		return wolEnabled ? [...HOST_CAPABILITIES, ...WOL_CAPABILITIES] : [...HOST_CAPABILITIES];
	}

	const U32 = z.number().int().min(0).max(0xffffffff);
	const Payload = z.record(z.string(), z.unknown());

	/** Same schema as the server's. */
	export const Frame = z.discriminatedUnion("t", [
		z.object({
			t: z.literal("req"),
			id: U32,
			cmd: z.string().min(1).max(64),
			p: Payload.default({}),
		}),
		z.object({
			t: z.literal("res"),
			id: U32,
			ok: z.boolean(),
			p: Payload.optional(),
			err: z.string().max(1024).optional(),
		}),
		z.object({ t: z.literal("evt"), cmd: z.string().min(1).max(64), p: Payload.default({}) }),
	]);
	export type Frame = z.infer<typeof Frame>;
	export type RequestFrame = Extract<Frame, { t: "req" }>;

	export const Hello = z.object({
		protocol: z.literal(VERSION),
		kind: z.literal("linux"),
		version: z.string().min(1).max(64),
		capabilities: z.array(z.string().max(64)).max(64),
		info: z.record(z.string(), z.unknown()).optional(),
	});
	export type Hello = z.infer<typeof Hello>;

	/** Sent after HELLO and then periodically (`host.status`). */
	export const HostStatus = z.object({
		hostname: z.string().max(255).optional(),
		uptime_s: z.number().nonnegative().optional(),
	});
	export type HostStatus = z.infer<typeof HostStatus>;

	// --- Frames -----------------------------------------------------------------------------------

	export type DecodeResult = { ok: true; frame: Frame } | { ok: false; error: string };

	export function decode(text: string): DecodeResult {
		if (text.length > MAX_FRAME_BYTES) return { ok: false, error: "frame too large" };

		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			return { ok: false, error: "not JSON" };
		}

		const parsed = Frame.safeParse(json);
		if (!parsed.success) return { ok: false, error: "invalid frame" };
		return { ok: true, frame: parsed.data };
	}

	export function encodeResponse(id: number, payload: Record<string, unknown> = {}) {
		return JSON.stringify({ t: "res", id, ok: true, p: payload } satisfies Frame);
	}

	export function encodeError(id: number, error: string) {
		return JSON.stringify({ t: "res", id, ok: false, err: error.slice(0, 1024) } satisfies Frame);
	}

	export function encodeEvent(cmd: string, payload: Record<string, unknown>) {
		return JSON.stringify({ t: "evt", cmd, p: payload } satisfies Frame);
	}

	// --- Requests ---------------------------------------------------------------------------------

	const Port = z
		.number({ error: "Invalid port" })
		.int("Invalid port")
		.min(1, "Invalid port")
		.max(65535, "Invalid port");

	const Mac = z
		.string({ error: "Invalid MAC address" })
		.max(64, "Invalid MAC address")
		.refine((value) => MacAddress.parse(value) !== null, "Invalid MAC address");

	/** An IP address literal; IPv6 may carry a zone (`fe80::1%eth0`). */
	const IPAddress = z
		.string({ error: "Invalid IP address" })
		.max(253, "Invalid IP address")
		.refine((value) => {
			const [address = "", zone, ...rest] = value.split("%");
			if (rest.length > 0) return false;
			if (zone !== undefined && (isIP(address) !== 6 || !/^[A-Za-z0-9_.-]{1,64}$/.test(zone))) {
				return false;
			}
			return isIP(address) !== 0;
		}, "Invalid IP address");

	const HostName = z
		.string({ error: "Invalid host name" })
		.min(1, "Invalid host name")
		.max(253, "Invalid host name")
		.regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/, "Invalid host name");

	export const WakeRequest = z.object({ mac: Mac, port: Port });
	export type WakeRequest = z.infer<typeof WakeRequest>;

	export const StatusTarget = z.discriminatedUnion(
		"type",
		[
			z.object({ type: z.literal("link_local"), mac: Mac }),
			z.object({ type: z.literal("ip"), address: IPAddress }),
			z.object({ type: z.literal("host"), host: HostName }),
		],
		{ error: "Unknown status target" },
	);
	export type StatusTarget = z.infer<typeof StatusTarget>;

	export const StatusRequest = z
		.object({
			target: StatusTarget,
			icmp: z.boolean({ error: "Invalid icmp flag" }).default(true),
			tcp_port: Port.nullish(),
		})
		.refine((request) => request.icmp || request.tcp_port, "No probe requested");
	export type StatusRequest = z.infer<typeof StatusRequest>;

	const Action = z.enum(["shutdown", "reboot"], { error: "Unknown action" });

	export const HostControlRequest = z.object({ action: Action });
	export type HostControlRequest = z.infer<typeof HostControlRequest>;

	// --- SSH (Wake-on-LAN mode) -------------------------------------------------------------------

	/** An IP literal or a host name. */
	const SshHost = z
		.string({ error: "Invalid host" })
		.max(253, "Invalid host")
		.refine(
			(value) => IPAddress.safeParse(value).success || HostName.safeParse(value).success,
			"Invalid host",
		);

	/** Linux and Windows user names (`DOMAIN\user`, `user@domain`, spaces), no control characters. */
	const SshUsername = z
		.string({ error: "Invalid username" })
		.min(1, "Invalid username")
		.max(255, "Invalid username")
		.refine((value) => !/\p{Cc}/u.test(value), "Invalid username");

	/** The credentials. Held for the request only; never logged or stored. */
	const SshAuth = z.discriminatedUnion(
		"type",
		[
			z.object({
				type: z.literal("password"),
				password: z.string({ error: "Invalid password" }).max(1024, "Invalid password"),
			}),
			z.object({
				type: z.literal("key"),
				private_key: z
					.string({ error: "Invalid private key" })
					.refine((key) => SshKeys.isUsablePrivateKey(key), "Invalid private key"),
			}),
		],
		{ error: "Unknown auth type" },
	);
	export type SshAuth = z.infer<typeof SshAuth>;

	/** `SHA256:<base64 without padding>`, like `ssh-keygen -lf`. */
	const HostKey = z
		.string({ error: (issue) => (issue.input == null ? "Missing host key" : "Invalid host key") })
		.regex(SshKeys.FINGERPRINT_PATTERN, "Invalid host key");

	const SshTarget = {
		host: SshHost,
		port: Port,
		username: SshUsername,
		auth: SshAuth,
	};

	/**
	 * Logs in and out again, without opening a session: is the device up, is it the one we know
	 * (host key), do the credentials work? `host_key` null: trust on first use (the answer reports
	 * the device's key).
	 */
	export const SshCheckRequest = z.object({ ...SshTarget, host_key: HostKey.nullish() });
	export type SshCheckRequest = z.infer<typeof SshCheckRequest>;

	/** Logs in (only to a known host key) and runs the fixed shutdown or reboot command. */
	export const SshExecRequest = z.object({
		...SshTarget,
		host_key: HostKey,
		action: Action,
		os: z.enum(["posix", "windows"], { error: "Unknown OS" }),
		sudo: z.boolean({ error: "Invalid sudo flag" }),
	});
	export type SshExecRequest = z.infer<typeof SshExecRequest>;

	/**
	 * The answer to SSH_CHECK:
	 *
	 * - `{ online: false }`: no TCP connection (refused, unreachable, timed out). With `error`
	 *   only when the host name doesn't resolve.
	 * - `{ online: true, host_key, authenticated: true }`: logged in.
	 * - `{ online: true, host_key, authenticated: false, error: "host_key_mismatch" }`: the device
	 *   presented `host_key` instead of the expected one; no credentials were sent.
	 * - `{ online: true, host_key, authenticated: false, error: "auth_failed" }`
	 * - `{ online: true, host_key?, authenticated: false, error: "<short message>" }`: anything
	 *   else (not SSH, handshake failure, timeout). `host_key` once the handshake got that far.
	 */
	export type SshCheckResult = {
		online: boolean;
		host_key?: string;
		authenticated?: boolean;
		error?: string;
	};

	/** Validates a request payload; the error is the first problem, for the `err` of the answer. */
	export function parseRequest<T extends z.ZodType>(
		schema: T,
		payload: unknown,
	): { ok: true; data: z.infer<T> } | { ok: false; error: string } {
		const parsed = schema.safeParse(payload);
		if (parsed.success) return { ok: true, data: parsed.data };
		return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request" };
	}
}
