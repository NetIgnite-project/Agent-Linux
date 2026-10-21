import { randomBytes } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import { AppConstants } from "../../src/utils/constants";
import { ServerProtocol } from "./server-protocol";

type SocketData = { connection: FakeAgentConnection };

/**
 * A stand-in for the NetIgnite server, with the same answers as the real one
 * (`server/lib/api/versions/v1/routes/agents/index.ts`, `server/lib/agents/*`):
 *
 * - `POST <base>/api/v1/agents/enroll` redeems a single-use enrollment token. Enrolling again
 *   revokes the agent's previous credential (open connections are closed with 4003).
 * - `GET <base>/api/health`
 * - `<base>/ws/agent`: bearer authentication on the upgrade (401 otherwise), one connection per
 *   agent (an older one is closed with 4000).
 *
 * The server never sends anything on its own: tests drive requests and closes explicitly.
 */
export class FakeNetIgniteServer {
	private server: Server<SocketData> | null = null;
	private readonly enrollments = new Map<string, { agentID: number; kind: string; used: boolean }>();
	private readonly credentials = new Map<string, { agentID: number; secret: string }>();
	private readonly connectionWaiters: Array<() => void> = [];
	/** Statuses the next upgrade attempts get regardless of the credential (e.g. a proxy's 502). */
	private readonly forcedUpgradeStatuses: number[] = [];

	/** Every enrollment request body, to check what the agent sent. */
	readonly enrollRequests: Array<{ enrollment_token: string; secret: string }> = [];
	/** Every accepted WebSocket, in order. */
	readonly connections: FakeAgentConnection[] = [];
	/** WebSocket upgrade attempts (including the agent's 401 probe), accepted or not. */
	readonly upgradeAttempts: Array<{ at: number; status: number }> = [];

	constructor(readonly basePath = "/netignite") {}

	start() {
		this.server = Bun.serve<SocketData>({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (request, server) => this.fetch(request, server),
			websocket: {
				open: (ws) => this.opened(ws),
				message: (ws, message) => ws.data.connection.receive(String(message)),
				close: (ws, code, reason) => ws.data.connection.closed(code, reason),
			},
		});
		return this;
	}

	async stop() {
		this.server?.stop(true);
		this.server = null;
	}

	get port() {
		return this.server?.port ?? 0;
	}

	get url() {
		return `http://127.0.0.1:${this.port}${this.basePath}`;
	}

	/** Creates a single-use enrollment token like the dashboard does. */
	addEnrollment(agentID: number, kind: string = AppConstants.AGENT_KIND) {
		const token = `netignite_enroll_${randomBytes(16).toString("hex")}:${randomBytes(32).toString("hex")}`;
		this.enrollments.set(token, { agentID, kind, used: false });
		return token;
	}

	/** Registers a credential directly (as if the agent had enrolled) and returns it. */
	addCredential(agentID: number, tokenID = randomBytes(16).toString("hex")) {
		const secret = randomBytes(32).toString("hex");
		this.credentials.set(tokenID, { agentID, secret });
		return { tokenID, secret, credential: `netignite_agent_${tokenID}:${secret}` };
	}

	/** Like the dashboard's "reset credential": the old one stops working, connections get 4003. */
	revoke(agentID: number) {
		this.forget(agentID);
		this.closeAgent(agentID, 4003, "Credential revoked");
	}

	/** Like deleting the agent in the dashboard: connections get 4004. */
	deleteAgent(agentID: number) {
		this.forget(agentID);
		this.closeAgent(agentID, 4004, "Agent deleted");
	}

	/** The next `count` upgrade attempts fail with `status`, as if a proxy in front had a problem. */
	failNextUpgrades(status: number, count: number) {
		for (let i = 0; i < count; i++) this.forcedUpgradeStatuses.push(status);
	}

	/** Open connections of an agent. */
	openConnections(agentID: number) {
		return this.connections.filter((c) => c.agentID === agentID && !c.isClosed);
	}

	/** Resolves with connection number `index` (0-based) once it is open. */
	waitForConnection(index = this.connections.length, timeoutMs = 10_000) {
		return new Promise<FakeAgentConnection>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`No agent connection #${index} within ${timeoutMs} ms`)),
				timeoutMs,
			);
			const check = () => {
				const connection = this.connections[index];
				if (connection?.isOpen) {
					clearTimeout(timer);
					resolve(connection);
				} else {
					this.connectionWaiters.push(check);
				}
			};
			check();
		});
	}

	private forget(agentID: number) {
		for (const [tokenID, credential] of this.credentials) {
			if (credential.agentID === agentID) this.credentials.delete(tokenID);
		}
	}

	private closeAgent(agentID: number, code: number, reason: string) {
		for (const connection of this.openConnections(agentID)) connection.close(code, reason);
	}

	private opened(ws: ServerWebSocket<SocketData>) {
		const connection = ws.data.connection;
		// One connection per agent, like AgentRegistry.register().
		for (const previous of this.openConnections(connection.agentID)) {
			if (previous !== connection) previous.close(4000, "Replaced by a new connection");
		}
		connection.attach(ws);
		for (const waiter of this.connectionWaiters.splice(0)) waiter();
	}

	private fetch(request: Request, server: Server<SocketData>) {
		const path = new URL(request.url).pathname;

		if (path === `${this.basePath}/api/v1/agents/enroll` && request.method === "POST") {
			return this.enroll(request);
		}

		if (path === `${this.basePath}/api/health`) {
			return Response.json({ success: true, code: 200, message: "API is running", data: null });
		}

		if (path === `${this.basePath}/ws/agent`) {
			if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
				return new Response("Upgrade Required", { status: 426 });
			}

			const forced = this.forcedUpgradeStatuses.shift();
			if (forced !== undefined) {
				this.upgradeAttempts.push({ at: Date.now(), status: forced });
				return new Response("Forced failure", { status: forced });
			}

			const agentID = this.authenticate(request.headers.get("authorization"));
			if (agentID === null) {
				this.upgradeAttempts.push({ at: Date.now(), status: 401 });
				return new Response("Missing or invalid agent credentials", { status: 401 });
			}

			// Listed before upgrade(): Bun may run the `open` handler inside it.
			const connection = new FakeAgentConnection(agentID);
			this.connections.push(connection);
			if (server.upgrade(request, { data: { connection } })) {
				this.upgradeAttempts.push({ at: Date.now(), status: 101 });
				return undefined;
			}
			this.connections.pop();
			return new Response("Upgrade failed", { status: 400 });
		}

		return Response.json({ success: false, code: 404, message: "Not found" }, { status: 404 });
	}

	private async enroll(request: Request) {
		const body = (await request.json().catch(() => null)) as {
			enrollment_token?: unknown;
			secret?: unknown;
		} | null;

		const token = body?.enrollment_token;
		const secret = body?.secret;
		if (typeof token !== "string" || typeof secret !== "string") {
			return Response.json(
				{ success: false, code: 400, message: "Your input is invalid" },
				{ status: 400 },
			);
		}
		this.enrollRequests.push({ enrollment_token: token, secret });

		if (!ServerProtocol.SECRET_PATTERN.test(secret)) {
			return Response.json(
				{
					success: false,
					code: 400,
					message: "The secret must be 32–128 characters of A-Z, a-z, 0-9, _ and -",
				},
				{ status: 400 },
			);
		}

		const enrollment = this.enrollments.get(token);
		if (!enrollment || enrollment.used) {
			return Response.json(
				{ success: false, code: 401, message: "Unknown, used or expired enrollment token" },
				{ status: 401 },
			);
		}

		enrollment.used = true;
		// Enrolling replaces the agent's credential (AgentAuth.enroll).
		this.revoke(enrollment.agentID);
		const tokenID = randomBytes(16).toString("hex");
		this.credentials.set(tokenID, { agentID: enrollment.agentID, secret });

		return Response.json({
			success: true,
			code: 200,
			message: "Agent enrolled",
			data: { agent_id: enrollment.agentID, kind: enrollment.kind, token_id: tokenID },
		});
	}

	private authenticate(header: string | null) {
		const prefix = "Bearer netignite_agent_";
		if (!header?.startsWith(prefix)) return null;

		const [tokenID, secret, ...rest] = header.slice(prefix.length).split(":");
		if (!tokenID || !secret || rest.length > 0) return null;

		const credential = this.credentials.get(tokenID);
		return credential && credential.secret === secret ? credential.agentID : null;
	}
}

/** One agent WebSocket on the fake server. */
export class FakeAgentConnection {
	private ws: ServerWebSocket<SocketData> | null = null;
	private nextID = 1000;
	private readonly frameWaiters: Array<() => void> = [];
	private closeInfo: { code: number; reason: string } | null = null;
	private readonly closeWaiters: Array<(info: { code: number; reason: string }) => void> = [];

	/** Every frame the agent sent, parsed with the server's schema (invalid ones as `null`). */
	readonly frames: Array<{ at: number; raw: string; frame: ServerProtocol.Frame | null }> = [];

	constructor(readonly agentID: number) {}

	attach(ws: ServerWebSocket<SocketData>) {
		this.ws = ws;
	}

	receive(raw: string) {
		let frame: ServerProtocol.Frame | null = null;
		try {
			const parsed = ServerProtocol.Frame.safeParse(JSON.parse(raw));
			frame = parsed.success ? parsed.data : null;
		} catch {
			frame = null;
		}
		this.frames.push({ at: Date.now(), raw, frame });
		for (const waiter of this.frameWaiters.splice(0)) waiter();
	}

	closed(code: number, reason: string) {
		this.closeInfo = { code, reason };
		for (const waiter of this.closeWaiters.splice(0)) waiter(this.closeInfo);
		for (const waiter of this.frameWaiters.splice(0)) waiter();
	}

	get isOpen() {
		return this.ws !== null && this.closeInfo === null;
	}

	get isClosed() {
		return this.closeInfo !== null;
	}

	/** Resolves with the first frame (sent so far or later) that matches. */
	waitForFrame(match: (frame: ServerProtocol.Frame) => boolean, timeoutMs = 10_000) {
		return new Promise<{ at: number; frame: ServerProtocol.Frame }>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Frame didn't arrive in time")), timeoutMs);
			const check = () => {
				const found = this.frames.find((entry) => entry.frame && match(entry.frame));
				if (found?.frame) {
					clearTimeout(timer);
					resolve({ at: found.at, frame: found.frame });
				} else {
					this.frameWaiters.push(check);
				}
			};
			check();
		});
	}

	/** The agent's HELLO payload, validated with the server's schema. */
	async hello() {
		const { frame } = await this.waitForFrame((f) => f.t === "evt" && f.cmd === "HELLO");
		if (frame.t !== "evt") throw new Error("unreachable");
		return ServerProtocol.Hello.parse(frame.p);
	}

	/** Sends a request and waits for its answer, like the server's AgentConnection.request(). */
	async request(cmd: string, payload: Record<string, unknown> = {}, timeoutMs = 5000) {
		const id = this.nextID++;
		const sentAt = Date.now();
		this.send(JSON.stringify({ t: "req", id, cmd, p: payload }));

		const { at, frame } = await this.waitForFrame((f) => f.t === "res" && f.id === id, timeoutMs);
		if (frame.t !== "res") throw new Error("unreachable");
		return { ...frame, receivedAt: at, elapsedMs: at - sentAt };
	}

	send(text: string) {
		this.ws?.send(text);
	}

	close(code = 1000, reason = "") {
		this.ws?.close(code, reason);
	}

	waitForClose(timeoutMs = 10_000) {
		if (this.closeInfo) return Promise.resolve(this.closeInfo);
		return new Promise<{ code: number; reason: string }>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Connection didn't close in time")), timeoutMs);
			this.closeWaiters.push((info) => {
				clearTimeout(timer);
				resolve(info);
			});
		});
	}
}
