import { isIP } from "node:net";
import { z } from "zod";
import { MacAddress } from "../net/macAddress";

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
	/** Wake-on-LAN mode: wakes and checks other devices on the network. */
	export const WOL_CAPABILITIES = [
		"wake",
		"status.link_local",
		"status.ip",
		"status.host",
		"status.tcp",
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

	export const HostControlRequest = z.object({
		action: z.enum(["shutdown", "reboot"], { error: "Unknown action" }),
	});
	export type HostControlRequest = z.infer<typeof HostControlRequest>;

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
