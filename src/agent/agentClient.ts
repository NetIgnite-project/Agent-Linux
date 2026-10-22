import { AgentProtocol } from "../protocol/agentProtocol";
import { AppConstants } from "../utils/constants";
import { Logger } from "../utils/logger";
import type { RequestHandler } from "./requestHandler";

/**
 * The agent's connection to the server: one WebSocket to `/ws/agent`, HELLO first, then requests
 * answered by id (concurrently).
 *
 * - Reconnects with exponential backoff, {@link AgentClient.RECONNECT_MIN_MS} up to
 *   {@link AgentClient.RECONNECT_MAX_MS}. The backoff resets once the server sends a frame.
 * - Treats {@link AgentClient.SILENCE_TIMEOUT_MS} without any frame from the server as a dead
 *   connection (the server sends PING every 30 s).
 * - Stops for good when the server no longer accepts the credential: HTTP 401 on the upgrade,
 *   or close code 4003 (revoked) / 4004 (agent deleted). Retrying can't fix that; the agent has
 *   to be paired again. {@link AgentClient.finished} tells the caller.
 */
export class AgentClient {
	static readonly RECONNECT_MIN_MS = 5_000;
	static readonly RECONNECT_MAX_MS = 60_000;
	static readonly SILENCE_TIMEOUT_MS = 100_000;
	static readonly HOST_STATUS_INTERVAL_MS = 5 * 60_000;
	static readonly MAX_CONCURRENT_REQUESTS = 32;
	static readonly STOP_TIMEOUT_MS = 2_000;
	static readonly PROBE_TIMEOUT_MS = 5_000;

	/** The server's close codes (`server/lib/agents/registry.ts`). */
	static readonly CloseCodes = {
		/** Another connection with the same credential took over. */
		REPLACED: 4000,
		/** The server didn't accept the HELLO. */
		INVALID_HELLO: 4001,
		/** The server got no answer to its keep-alive. */
		UNRESPONSIVE: 4002,
		/** The credential was revoked (the agent was paired again, or reset in the dashboard). */
		CREDENTIAL_REVOKED: 4003,
		/** The agent was deleted in the dashboard. */
		DELETED: 4004,
	} as const;

	private socket: WebSocket | null = null;
	/** Incremented for every socket; events of older sockets are ignored. */
	private generation = 0;
	private started = false;
	private stopped = false;
	/** Connections in a row that ended before the server sent anything. */
	private failures = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private watchdogTimer: ReturnType<typeof setInterval> | null = null;
	private hostStatusTimer: ReturnType<typeof setInterval> | null = null;
	private lastFrameAt = 0;
	private inFlight = 0;

	private resolveFinished: (result: AgentClient.Result) => void = () => {};
	/** Resolves once the client stopped: through {@link stop}, or because the server rejected it. */
	readonly finished: Promise<AgentClient.Result>;

	constructor(private readonly options: AgentClient.Options) {
		this.finished = new Promise((resolve) => {
			this.resolveFinished = resolve;
		});
	}

	private get reconnectMinMs() {
		return this.options.reconnectMinMs ?? AgentClient.RECONNECT_MIN_MS;
	}

	private get reconnectMaxMs() {
		return this.options.reconnectMaxMs ?? AgentClient.RECONNECT_MAX_MS;
	}

	private get silenceTimeoutMs() {
		return this.options.silenceTimeoutMs ?? AgentClient.SILENCE_TIMEOUT_MS;
	}

	get isConnected() {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	/** The delay before reconnect attempt number `failures` (1-based): min, 2×min, … up to max. */
	static backoffDelay(failures: number, minMs: number, maxMs: number) {
		const exponent = Math.max(0, Math.min(failures - 1, 16));
		return Math.min(minMs * 2 ** exponent, maxMs);
	}

	start() {
		if (this.started) return;
		this.started = true;
		this.connect();
	}

	/** Closes the connection cleanly and stops reconnecting. */
	async stop() {
		if (this.stopped) return;
		this.halt();

		const socket = this.socket;
		this.socket = null;
		if (socket && socket.readyState !== WebSocket.CLOSED) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					socket.terminate();
					resolve();
				}, AgentClient.STOP_TIMEOUT_MS);
				socket.addEventListener("close", () => {
					clearTimeout(timer);
					resolve();
				});
				socket.close(1000, "Agent stopping");
			});
		}

		this.resolveFinished({ type: "stopped" });
	}

	/** Stops timers and reconnects; events of the current socket are ignored from now on. */
	private halt() {
		this.stopped = true;
		this.generation++;
		this.clearTimers();
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}

	/** Gives up for good: the server won't accept this credential again. */
	private reject(reason: AgentClient.RejectReason, detail: string) {
		if (this.stopped) return;
		this.halt();
		this.socket = null;

		const message = AgentClient.rejectMessage(reason);
		Logger.error(`${message} (${detail})`);
		this.resolveFinished({ type: "rejected", reason, message });
	}

	static rejectMessage(reason: AgentClient.RejectReason) {
		switch (reason) {
			case "revoked":
				return "The server revoked this agent's credential (it was paired again, or reset in the dashboard)";
			case "deleted":
				return "The agent was deleted in the dashboard";
			case "unauthorized":
				return "The server doesn't accept this agent's credential (HTTP 401): it was revoked, or the agent was deleted";
		}
	}

	private connect() {
		const generation = ++this.generation;
		Logger.info(`Connecting to ${this.options.url}`);

		let socket: WebSocket;
		try {
			socket = new WebSocket(this.options.url, {
				headers: {
					Authorization: `Bearer ${this.options.credential}`,
					"User-Agent": AgentClient.userAgent(),
				},
			});
		} catch (error) {
			Logger.error("Couldn't open the WebSocket:", error);
			this.scheduleReconnect(this.nextDelay());
			return;
		}
		this.socket = socket;

		let opened = false;
		const current = () => generation === this.generation;

		socket.addEventListener("open", () => {
			if (!current()) return;
			opened = true;
			void this.onOpen(socket, generation);
		});

		socket.addEventListener("message", (event) => {
			if (!current()) return;
			this.lastFrameAt = Date.now();
			// The server talks to us, so the session works: start the backoff from the bottom again.
			this.failures = 0;
			if (typeof event.data === "string") this.onText(socket, generation, event.data);
		});

		socket.addEventListener("error", (event) => {
			if (!current()) return;
			const message = (event as ErrorEvent).message;
			Logger.debug(`WebSocket error${message ? `: ${message}` : ""}`);
		});

		socket.addEventListener("close", (event) => {
			if (!current()) return;
			this.socket = null;
			this.clearTimers();
			if (opened) {
				this.onClose(event.code, event.reason);
			} else {
				void this.onUpgradeFailed(generation, event.code, event.reason);
			}
		});
	}

	private async onOpen(socket: WebSocket, generation: number) {
		this.lastFrameAt = Date.now();

		let hello: AgentProtocol.Hello;
		try {
			hello = await this.options.hello();
		} catch (error) {
			Logger.error("Couldn't build the HELLO:", error);
			socket.close(1011, "Agent error");
			return;
		}
		if (generation !== this.generation || socket.readyState !== WebSocket.OPEN) return;

		socket.send(AgentProtocol.encodeEvent("HELLO", hello));
		Logger.info(
			`Connected to the server (agent ${this.options.agentID ?? "?"}, capabilities: ${hello.capabilities.join(", ")})`,
		);

		const sendHostStatus = () => {
			if (generation !== this.generation || socket.readyState !== WebSocket.OPEN) return;
			socket.send(AgentProtocol.encodeEvent("HOST_STATUS", this.options.hostStatus()));
		};
		sendHostStatus();
		this.hostStatusTimer = setInterval(
			sendHostStatus,
			this.options.hostStatusIntervalMs ?? AgentClient.HOST_STATUS_INTERVAL_MS,
		);

		const checkEvery = Math.min(5_000, Math.max(20, Math.floor(this.silenceTimeoutMs / 4)));
		this.watchdogTimer = setInterval(() => {
			if (Date.now() - this.lastFrameAt <= this.silenceTimeoutMs) return;

			Logger.warn(
				`No message from the server for ${Math.round(this.silenceTimeoutMs / 1000)} s, reconnecting`,
			);
			// The connection is dead even if TCP doesn't know yet: drop it without a close handshake.
			this.generation++;
			this.socket = null;
			this.clearTimers();
			socket.terminate();
			this.scheduleReconnect(this.nextDelay());
		}, checkEvery);
	}

	private onClose(code: number, reason: string) {
		const detail = `code ${code}${reason ? `, ${reason}` : ""}`;
		const codes = AgentClient.CloseCodes;

		switch (code) {
			case codes.CREDENTIAL_REVOKED:
				this.reject("revoked", detail);
				return;
			case codes.DELETED:
				this.reject("deleted", detail);
				return;
			case codes.REPLACED:
				// Another agent uses the same credential (e.g. `run` started by hand next to the
				// service). Reconnecting right away would only take turns kicking each other out.
				Logger.error(
					`Another connection with this agent's credential replaced this one (${detail}). Is the agent running twice?`,
				);
				this.failures++;
				this.scheduleReconnect(this.reconnectMaxMs);
				return;
			case codes.INVALID_HELLO:
				Logger.error(`The server didn't accept the HELLO (${detail}). Is the agent up to date?`);
				break;
			default:
				Logger.warn(`Disconnected from the server (${detail})`);
		}

		this.scheduleReconnect(this.nextDelay());
	}

	/**
	 * The upgrade failed. Bun's WebSocket doesn't expose the HTTP status, so a second handshake
	 * tells a rejected credential (401: stop) from anything else (retry).
	 */
	private async onUpgradeFailed(generation: number, code: number, reason: string) {
		const probe = this.options.probeUpgrade ?? AgentClient.probeUpgrade;
		const status = await probe(this.options.url, this.options.credential);
		if (generation !== this.generation || this.stopped) return;

		if (status === 401) {
			this.reject("unauthorized", `HTTP 401 on ${this.options.url}`);
			return;
		}

		const detail = status !== null && status !== 101 ? `HTTP ${status}` : reason || `code ${code}`;
		Logger.warn(`Couldn't connect to the server (${detail})`);
		this.scheduleReconnect(this.nextDelay());
	}

	/**
	 * Sends a WebSocket handshake with the credential and returns the HTTP status (101 if the
	 * upgrade would succeed; the connection is dropped right away), or null if the server can't
	 * be reached.
	 */
	static async probeUpgrade(wsUrl: string, credential: string): Promise<number | null> {
		const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), AgentClient.PROBE_TIMEOUT_MS);
		try {
			const response = await fetch(wsUrl.replace(/^ws/, "http"), {
				headers: {
					Authorization: `Bearer ${credential}`,
					Connection: "Upgrade",
					Upgrade: "websocket",
					"Sec-WebSocket-Version": "13",
					"Sec-WebSocket-Key": key,
					"User-Agent": AgentClient.userAgent(),
				},
				redirect: "manual",
				signal: controller.signal,
			});
			return response.status;
		} catch (error) {
			Logger.debug("Upgrade probe failed:", error);
			return null;
		} finally {
			clearTimeout(timer);
			// After a 101 the upgraded connection stays open (on Linux it kept `status` alive until
			// the timeout): close it.
			controller.abort();
		}
	}

	private static userAgent() {
		return `${AppConstants.BINARY_NAME}/${AppConstants.version()}`;
	}

	private nextDelay() {
		this.failures++;
		return AgentClient.backoffDelay(this.failures, this.reconnectMinMs, this.reconnectMaxMs);
	}

	private scheduleReconnect(delay: number) {
		if (this.stopped || this.reconnectTimer) return;

		Logger.info(`Reconnecting in ${Math.round(delay / 100) / 10} s`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.stopped) this.connect();
		}, delay);
	}

	private clearTimers() {
		if (this.watchdogTimer) clearInterval(this.watchdogTimer);
		if (this.hostStatusTimer) clearInterval(this.hostStatusTimer);
		this.watchdogTimer = null;
		this.hostStatusTimer = null;
	}

	private onText(socket: WebSocket, generation: number, text: string) {
		const decoded = AgentProtocol.decode(text);
		if (!decoded.ok) {
			Logger.warn(`Ignored a frame from the server: ${decoded.error}`);
			return;
		}

		const { frame } = decoded;
		if (frame.t !== "req") {
			Logger.debug(`Ignored a ${frame.t} frame from the server`);
			return;
		}

		void this.handleRequest(socket, generation, frame);
	}

	private async handleRequest(
		socket: WebSocket,
		generation: number,
		frame: AgentProtocol.RequestFrame,
	) {
		const send = (text: string) => {
			if (generation !== this.generation || socket.readyState !== WebSocket.OPEN) {
				Logger.debug(`Dropped the answer to request ${frame.id}: the connection is gone`);
				return false;
			}
			socket.send(text);
			return true;
		};

		if (this.inFlight >= AgentClient.MAX_CONCURRENT_REQUESTS) {
			send(AgentProtocol.encodeError(frame.id, "Too many requests at once"));
			return;
		}

		Logger.debug(`Request ${frame.id}: ${frame.cmd}`);
		this.inFlight++;
		let outcome: RequestHandler.Outcome;
		try {
			outcome = await this.options.handler.handle(frame.cmd, frame.p);
		} catch (error) {
			Logger.error(`Request ${frame.id} (${frame.cmd}) failed:`, error);
			outcome = { ok: false, err: "Internal agent error" };
		} finally {
			this.inFlight--;
		}

		if (!outcome.ok) {
			Logger.debug(`Request ${frame.id} (${frame.cmd}) rejected: ${outcome.err}`);
			send(AgentProtocol.encodeError(frame.id, outcome.err));
			return;
		}

		if (send(AgentProtocol.encodeResponse(frame.id, outcome.p))) {
			outcome.afterSend?.();
		}
	}
}

export namespace AgentClient {
	export type Options = {
		/** `wss://…/ws/agent` */
		url: string;
		/** `netignite_agent_<token_id>:<secret>` */
		credential: string;
		/** Only for log messages. */
		agentID?: number;
		hello: () => Promise<AgentProtocol.Hello>;
		hostStatus: () => AgentProtocol.HostStatus;
		handler: Pick<RequestHandler, "handle">;
		reconnectMinMs?: number;
		reconnectMaxMs?: number;
		silenceTimeoutMs?: number;
		hostStatusIntervalMs?: number;
		/** Replaces {@link AgentClient.probeUpgrade} (tests). */
		probeUpgrade?: (url: string, credential: string) => Promise<number | null>;
	};

	/**
	 * - `revoked`: close code 4003
	 * - `deleted`: close code 4004
	 * - `unauthorized`: HTTP 401 on the upgrade
	 */
	export type RejectReason = "revoked" | "deleted" | "unauthorized";

	export type Result =
		| { type: "stopped" }
		| { type: "rejected"; reason: RejectReason; message: string };
}
