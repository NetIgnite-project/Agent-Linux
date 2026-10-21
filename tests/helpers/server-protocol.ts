import { z } from "zod";

/**
 * The server's schemas, copied from the NetIgnite server's `server/lib/agents/protocol.ts`
 * (protocol 2). Tests validate what the agent sends against these, not against the agent's own
 * schemas, so a drift on the agent's side shows up.
 */
export namespace ServerProtocol {
	export const VERSION = 2;

	const Kind = z.enum(["esp32", "linux"]);
	const U32 = z.number().int().min(0).max(0xffffffff);
	const Payload = z.record(z.string(), z.unknown());

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

	export const Hello = z.object({
		protocol: z.literal(VERSION),
		kind: Kind,
		version: z.string().min(1).max(64),
		capabilities: z.array(z.string().max(64)).max(64),
		info: z.record(z.string(), z.unknown()).optional(),
	});
	export type Hello = z.infer<typeof Hello>;

	export const HostStatus = z.object({
		hostname: z.string().max(255).optional(),
		uptime_s: z.number().nonnegative().optional(),
	});

	/** `server/lib/agents/auth.ts` */
	export const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
}
