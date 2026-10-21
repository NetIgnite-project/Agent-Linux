import { connect, type Socket } from "node:net";
import type { AnyAuthMethod, AuthHandlerMiddleware, ClientChannel } from "ssh2";
import { Client } from "ssh2";
import type { AgentProtocol } from "../protocol/agentProtocol";
import { Logger } from "../utils/logger";
import { SshKeys } from "./sshKeys";

/**
 * Logs in to devices on the network over SSH with the agent's own keys (Wake-on-LAN mode):
 * `SSH_CHECK` and `SSH_POWER`. No credentials come from the server; it only says where.
 *
 * - The agent has one key for shutdown and one for reboot. The device allows each with a forced
 *   command in authorized_keys, so a key can do exactly its action.
 * - The host key is checked before a key is offered. With an expected key, a different one ends
 *   the handshake (ssh2's `hostVerifier` returns false).
 * - `SSH_CHECK` logs in with each key and disconnects. It never opens a session or channel, so the
 *   forced commands never run.
 * - `SSH_POWER` runs one of four fixed commands ({@link SshRemote.command}); nothing from the
 *   request ends up in it.
 * - At most {@link SshRemote.MAX_LOGINS_PER_MINUTE} logins a minute, so a compromised server can't
 *   use the agent to probe the network.
 * - Every login is answered within {@link SshRemote.BUDGET_MS}.
 */
export class SshRemote {
	/** One login, connect to answer. `SSH_CHECK` does two (the server waits 25 s). */
	static readonly BUDGET_MS = 8000;
	static readonly CONNECT_TIMEOUT_MS = 3000;
	/** `SSH_POWER`: how long to wait for the command's exit status (within the budget). */
	static readonly EXEC_WAIT_MS = 5000;
	/** How much of the command's error output goes into a failed `SSH_POWER`'s answer. */
	static readonly ERROR_OUTPUT_CHARS = 200;
	/** Output kept per stream; the rest is read and dropped. */
	static readonly OUTPUT_LIMIT_BYTES = 4096;
	/** After disconnecting, the socket is destroyed if the device doesn't close it. */
	static readonly CLOSE_GRACE_MS = 1000;
	/** SSH logins (one per connection) the agent makes per minute, at most. */
	static readonly MAX_LOGINS_PER_MINUTE = 10;

	private readonly loginTimes: number[] = [];

	constructor(
		private readonly keys: SshKeys.PrivateKeys,
		private readonly options: SshRemote.Options = {},
	) {}

	private get budgetMs() {
		return this.options.budgetMs ?? SshRemote.BUDGET_MS;
	}

	/** The command for an action. The only commands `SSH_POWER` ever runs. */
	static command(action: SshRemote.Action, os: SshRemote.OS, sudo: boolean) {
		if (os === "windows") return action === "shutdown" ? "shutdown /s /t 0" : "shutdown /r /t 0";
		const command = action === "shutdown" ? "shutdown -h now" : "shutdown -r now";
		return sudo ? `sudo -n ${command}` : command;
	}

	/** Takes `count` logins from the minute's budget, or says how long to wait. */
	private reserve(count: number): string | null {
		const now = (this.options.now ?? Date.now)();
		while (this.loginTimes.length > 0 && now - (this.loginTimes[0] as number) >= 60_000) {
			this.loginTimes.shift();
		}
		const limit = this.options.maxLoginsPerMinute ?? SshRemote.MAX_LOGINS_PER_MINUTE;
		if (this.loginTimes.length + count > limit) {
			const waitS = Math.ceil((60_000 - (now - (this.loginTimes[0] ?? now))) / 1000);
			return `Too many SSH logins (at most ${limit} a minute); try again in ${waitS} s`;
		}
		for (let i = 0; i < count; i++) this.loginTimes.push(now);
		return null;
	}

	/** `SSH_CHECK`: for each key, connect, verify the host key, authenticate, disconnect. */
	async check(request: AgentProtocol.SshCheckRequest): Promise<SshRemote.CheckOutcome> {
		const limited = this.reserve(2);
		if (limited) return { ok: false, error: limited };

		const target = SshRemote.describeTarget(request);
		const first = await this.login(request, "shutdown", Date.now() + this.budgetMs);
		if (first.type === "ready") SshRemote.disconnect(first);

		let result: AgentProtocol.SshCheckResult;
		if (first.type !== "ready" && first.type !== "auth_failed") {
			// Offline, another host key or not SSH: the second key would get the same answer.
			result = SshRemote.checkResult(first, null);
		} else {
			const second = await this.login(
				{ ...request, host_key: first.hostKey },
				"reboot",
				Date.now() + this.budgetMs,
			);
			if (second.type === "ready") SshRemote.disconnect(second);
			result = SshRemote.checkResult(first, second);
		}
		Logger.debug(`SSH check of ${target}: ${JSON.stringify(result)}`);
		return { ok: true, result };
	}

	/** Combines the shutdown key's login and the reboot key's into the answer. */
	static checkResult(
		shutdown: SshRemote.Login,
		reboot: SshRemote.Login | null,
	): AgentProtocol.SshCheckResult {
		switch (shutdown.type) {
			case "unreachable":
				return shutdown.error ? { online: false, error: shutdown.error } : { online: false };
			case "host_key_mismatch":
				return {
					online: true,
					host_key: shutdown.hostKey,
					shutdown: false,
					reboot: false,
					error: "host_key_mismatch",
				};
			case "failed":
				return {
					online: true,
					...(shutdown.hostKey ? { host_key: shutdown.hostKey } : {}),
					shutdown: false,
					reboot: false,
					error: shutdown.error,
				};
			case "auth_failed":
			case "ready": {
				const accepted = reboot?.type === "ready";
				return {
					online: true,
					host_key: shutdown.hostKey,
					shutdown: shutdown.type === "ready",
					reboot: accepted,
					// The reboot key's login failed for another reason than the key (a timeout, the
					// device changing its host key in between).
					...(reboot && reboot.type !== "ready" && reboot.type !== "auth_failed"
						? {
								error:
									reboot.type === "host_key_mismatch"
										? "host_key_mismatch"
										: reboot.type === "failed"
											? reboot.error
											: "The device stopped answering",
							}
						: {}),
				};
			}
		}
	}

	/** `SSH_POWER`: log in to the known host with the action's key and run the fixed command. */
	async power(request: AgentProtocol.SshPowerRequest): Promise<SshRemote.PowerResult> {
		const limited = this.reserve(1);
		if (limited) return { ok: false, error: limited };

		const deadline = Date.now() + this.budgetMs;
		const command = SshRemote.command(request.action, request.os, request.sudo);
		const target = SshRemote.describeTarget(request);

		Logger.info(`SSH: ${request.action} requested by the server, running "${command}" on ${target}`);
		const login = await this.login(request, request.action, deadline);

		let result: SshRemote.PowerResult;
		switch (login.type) {
			case "unreachable":
				result = {
					ok: false,
					error: login.error ?? `Couldn't connect to ${request.host} port ${request.port}`,
				};
				break;
			case "host_key_mismatch":
				result = { ok: false, error: "host key changed" };
				break;
			case "auth_failed":
				result = { ok: false, error: `the device didn't accept the agent's ${request.action} key` };
				break;
			case "failed":
				result = { ok: false, error: login.error };
				break;
			case "ready":
				result = await this.run(login, command, deadline);
				break;
		}

		if (result.ok) Logger.info(`SSH: "${command}" on ${target} done`);
		else Logger.warn(`SSH: "${command}" on ${target} failed: ${result.error}`);
		return result;
	}

	/** `user@host:port`, for log messages. */
	private static describeTarget(request: SshRemote.Target) {
		const host = request.host.includes(":") ? `[${request.host}]` : request.host;
		return `${request.username}@${host}:${request.port}`;
	}

	// --- Login ------------------------------------------------------------------------------------

	/** Connects, checks the host key and authenticates with `key`, all before `deadline`. */
	private async login(
		target: SshRemote.Target,
		key: SshKeys.Action,
		deadline: number,
	): Promise<SshRemote.Login> {
		const connectTimeout = Math.min(
			this.options.connectTimeoutMs ?? SshRemote.CONNECT_TIMEOUT_MS,
			Math.max(0, deadline - Date.now()),
		);
		const tcp = await (this.options.connect ?? SshRemote.tcpConnect)(
			target.host,
			target.port,
			connectTimeout,
		);
		if (!tcp.ok) return { type: "unreachable", error: tcp.error };
		return await SshRemote.handshake(tcp.socket, target, this.keys[key], deadline);
	}
	/**
	 * Opens the TCP connection. Refused, unreachable and timed out are all "unreachable"; only a
	 * host name that doesn't resolve gets an `error`.
	 */
	static tcpConnect(host: string, port: number, timeoutMs: number): Promise<SshRemote.TcpResult> {
		return new Promise((resolve) => {
			let settled = false;
			let socket: Socket;

			const finish = (result: SshRemote.TcpResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (!result.ok) socket.destroy();
				resolve(result);
			};
			const timer = setTimeout(() => finish({ ok: false }), timeoutMs);

			try {
				socket = connect({ host, port });
			} catch {
				clearTimeout(timer);
				resolve({ ok: false });
				return;
			}
			socket.once("connect", () => finish({ ok: true, socket }));
			socket.on("error", (error: NodeJS.ErrnoException) => {
				const unresolved = error.code === "ENOTFOUND" || error.code === "EAI_NONAME";
				finish(unresolved ? { ok: false, error: `Host name ${host} doesn't resolve` } : { ok: false });
			});
		});
	}

	/** Runs the SSH handshake and authentication with `privateKey` on a connected socket. */
	private static handshake(
		socket: Socket,
		target: SshRemote.Target,
		privateKey: string,
		deadline: number,
	): Promise<SshRemote.Login> {
		return new Promise((resolve) => {
			const client = new Client();
			/** The key the device presented, and once the key exchange proved it, the verified one. */
			let presentedKey: string | undefined;
			let verifiedKey: string | undefined;
			let mismatch = false;
			let settled = false;

			const finish = (login: SshRemote.Login) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (login.type !== "ready") socket.destroy();
				resolve(login);
			};

			const timer = setTimeout(
				() =>
					finish({
						type: "failed",
						error: verifiedKey ? "SSH login timed out" : "SSH handshake timed out",
						hostKey: verifiedKey,
					}),
				Math.max(0, deadline - Date.now()),
			);

			const fail = (error: (Error & { level?: string; code?: unknown }) | null) => {
				if (mismatch && presentedKey) {
					finish({ type: "host_key_mismatch", hostKey: presentedKey });
				} else if (verifiedKey && error && SshRemote.isAuthFailure(error)) {
					finish({ type: "auth_failed", hostKey: verifiedKey });
				} else {
					const message = error ? SshRemote.errorMessage(error) : "The device closed the connection";
					finish({ type: "failed", error: message, hostKey: verifiedKey });
				}
			};

			// Errors after the login settled (e.g. the device going down) must not crash the agent:
			// this listener stays, and `finish` ignores them.
			client.on("error", fail);
			client.on("close", () => fail(null));
			// Emitted after the key exchange, which includes checking the device's signature.
			client.on("handshake", () => {
				verifiedKey = presentedKey;
			});
			client.on("ready", () => {
				if (!verifiedKey) {
					finish({ type: "failed", error: "SSH handshake failed" });
					return;
				}
				finish({ type: "ready", client, socket, hostKey: verifiedKey });
			});

			try {
				client.connect({
					sock: socket,
					username: target.username,
					// The deadline above covers the whole login.
					readyTimeout: 0,
					keepaliveInterval: 0,
					hostVerifier: (blob: Buffer) => {
						const fingerprint = SshKeys.fingerprint(blob);
						// A second call (re-keying) must present the same key.
						if (presentedKey && presentedKey !== fingerprint) mismatch = true;
						presentedKey ??= fingerprint;
						if (target.host_key && fingerprint !== target.host_key) mismatch = true;
						return !mismatch;
					},
					authHandler: SshRemote.authHandler(target.username, privateKey),
				});
			} catch (error) {
				finish({ type: "failed", error: SshRemote.errorMessage(error) });
			}
		});
	}

	/**
	 * `none` (to learn the methods), then the agent's key if the device offers `publickey`. Never a
	 * password: the agent has none.
	 */
	static authHandler(username: string, privateKey: string): AuthHandlerMiddleware {
		const methods: AnyAuthMethod[] = [{ type: "publickey", username, key: privateKey }];

		let first = true;
		return (methodsLeft, _partialSuccess, next) => {
			// ssh2 also accepts `false` (no more methods), which its types leave out.
			const nextAuth = next as (method: AnyAuthMethod | false) => void;
			if (first) {
				first = false;
				nextAuth({ type: "none", username });
				return;
			}
			for (let method = methods.shift(); method; method = methods.shift()) {
				if (!methodsLeft || methodsLeft.includes(method.type)) {
					nextAuth(method);
					return;
				}
			}
			nextAuth(false);
		};
	}

	private static isAuthFailure(error: Error & { level?: string; code?: unknown }) {
		// ssh2 gives up ("All configured authentication methods failed"), or the device
		// disconnects (OpenSSH: "Too many authentication failures").
		return (
			error.level === "client-authentication" ||
			error.code === 14 ||
			/authentication failures/i.test(error.message)
		);
	}

	/** A short, single-line message for the answer. Never contains a key. */
	static errorMessage(error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return SshRemote.oneLine(message, SshRemote.ERROR_OUTPUT_CHARS) || "SSH error";
	}

	/** Collapses whitespace and control characters, then cuts to `limit` characters. */
	static oneLine(text: string, limit: number) {
		return text
			.replace(/[\s\p{Cc}]+/gu, " ")
			.trim()
			.slice(0, limit);
	}

	/** Disconnects cleanly; destroys the socket if the device doesn't close it in time. */
	private static disconnect(login: Extract<SshRemote.Login, { type: "ready" }>) {
		try {
			login.client.end();
		} catch {
			// Already gone.
		}
		const timer = setTimeout(() => login.socket.destroy(), SshRemote.CLOSE_GRACE_MS);
		timer.unref?.();
		login.socket.once("close", () => clearTimeout(timer));
	}

	// --- Power ------------------------------------------------------------------------------------

	/**
	 * Runs `command` and waits up to {@link SshRemote.EXEC_WAIT_MS} for its exit status:
	 *
	 * - exit status 0: done.
	 * - another exit status: failed, with the start of its error output.
	 * - the connection drops, or the command is killed by a signal, before an exit status
	 *   arrives: done (the machine is going down).
	 * - no exit status in time, but the command started: done (it is still running).
	 */
	private run(
		login: Extract<SshRemote.Login, { type: "ready" }>,
		command: string,
		deadline: number,
	): Promise<SshRemote.PowerResult> {
		const { client } = login;
		return new Promise((resolve) => {
			let settled = false;
			let started = false;
			let connectionClosed = false;
			let exitCode: number | null = null;
			const stdout = new SshRemote.Output();
			const stderr = new SshRemote.Output();

			const finish = (result: SshRemote.PowerResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				SshRemote.disconnect(login);
				resolve(result);
			};

			const conclude = () => {
				if (exitCode === null || exitCode === 0) {
					finish({ ok: true });
					return;
				}
				const output = stderr.text() || stdout.text();
				const detail = SshRemote.oneLine(output, SshRemote.ERROR_OUTPUT_CHARS);
				finish({
					ok: false,
					error: `"${command}" failed with exit code ${exitCode}${detail ? `: ${detail}` : ""}`,
				});
			};

			const waitMs = Math.min(
				this.options.execWaitMs ?? SshRemote.EXEC_WAIT_MS,
				Math.max(0, deadline - Date.now()),
			);
			const timer = setTimeout(() => {
				if (started) conclude();
				else finish({ ok: false, error: "Timed out before the command started" });
			}, waitMs);

			client.on("close", () => {
				connectionClosed = true;
			});

			const onChannel = (error: Error | undefined, stream: ClientChannel) => {
				if (error) {
					// ssh2 reports "Unable to exec" when the request was sent and the connection
					// dropped before the answer: the machine is probably going down already.
					if (connectionClosed && error.message === "Unable to exec") {
						started = true;
						conclude();
					} else if (connectionClosed) {
						finish({ ok: false, error: "The connection closed before the command started" });
					} else {
						finish({
							ok: false,
							error: `The device refused to run the command (${SshRemote.errorMessage(error)})`,
						});
					}
					return;
				}

				started = true;
				stream.on("exit", (code: number | null) => {
					if (typeof code === "number") exitCode = code;
				});
				stream.on("data", (chunk: Buffer) => stdout.add(chunk));
				stream.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
				// Let stderr's last data events through before concluding.
				stream.on("close", () => setImmediate(conclude));
				// The commands read nothing; EOF right away so nothing waits for input.
				stream.end();
			};

			try {
				client.exec(command, onChannel);
			} catch {
				finish({ ok: false, error: "The connection closed before the command started" });
			}
		});
	}
}

export namespace SshRemote {
	export type Action = AgentProtocol.SshPowerRequest["action"];
	export type OS = AgentProtocol.SshPowerRequest["os"];

	/** The connection fields `SSH_CHECK` and `SSH_POWER` share. */
	export type Target = Pick<
		AgentProtocol.SshCheckRequest,
		"host" | "port" | "username" | "host_key"
	>;

	export type Options = {
		budgetMs?: number;
		connectTimeoutMs?: number;
		execWaitMs?: number;
		maxLoginsPerMinute?: number;
		/** Replaces `Date.now` for the login limit (tests). */
		now?: () => number;
		/** Replaces {@link SshRemote.tcpConnect} (tests). */
		connect?: (host: string, port: number, timeoutMs: number) => Promise<TcpResult>;
	};

	export type TcpResult = { ok: true; socket: Socket } | { ok: false; error?: string };

	export type Login =
		| { type: "unreachable"; error?: string }
		| { type: "host_key_mismatch"; hostKey: string }
		| { type: "auth_failed"; hostKey: string }
		| { type: "failed"; error: string; hostKey?: string }
		| { type: "ready"; client: Client; socket: Socket; hostKey: string };

	export type CheckOutcome =
		| { ok: true; result: AgentProtocol.SshCheckResult }
		| { ok: false; error: string };

	export type PowerResult = { ok: true } | { ok: false; error: string };

	/** Keeps the first {@link SshRemote.OUTPUT_LIMIT_BYTES} of a stream. */
	export class Output {
		private readonly chunks: Buffer[] = [];
		private size = 0;

		add(chunk: Buffer) {
			const room = SshRemote.OUTPUT_LIMIT_BYTES - this.size;
			if (room <= 0) return;
			const part = chunk.subarray(0, room);
			this.chunks.push(part);
			this.size += part.length;
		}

		text() {
			return Buffer.concat(this.chunks).toString("utf8").trim();
		}
	}
}
