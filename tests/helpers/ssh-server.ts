import { createHash } from "node:crypto";
import { type AddressInfo, createServer, type Server as NetServer, type Socket } from "node:net";
import { type AuthContext, type Connection, type ParsedKey, Server, utils } from "ssh2";

/**
 * An SSH server for tests (ssh2's own `Server`), on 127.0.0.1 with a fresh Ed25519 host key.
 * Records everything a client does, so tests can check that `SSH_CHECK` opened no session and
 * that a rejected host key got no credentials.
 */
export class TestSshServer {
	readonly hostKey = TestSshServer.newHostKey();
	/** `ssh-keygen -lf` of the host key, computed independently of the agent's code. */
	readonly fingerprint: string;

	/** Every authentication attempt, in order (`none`, `password`, …). */
	readonly authAttempts: Array<{ method: string; username: string }> = [];
	/** Session channels the client opened. `SSH_CHECK` must leave this at 0. */
	sessions = 0;
	/** Commands the client asked to run. */
	readonly execs: string[] = [];
	/** Any other channel or request the client tried (shells, forwarding, subsystems). */
	readonly otherRequests: string[] = [];
	/** TCP connections accepted. */
	connections = 0;

	private server: Server | null = null;
	private readonly allowedKeys: ParsedKey[];

	constructor(private readonly options: TestSshServer.Options) {
		const publicKey = utils.parseKey(this.hostKey.public);
		if (publicKey instanceof Error) throw publicKey;
		const blob = publicKey.getPublicSSH();
		this.fingerprint = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;

		this.allowedKeys = (options.publicKeys ?? []).map((text) => {
			const key = utils.parseKey(text);
			if (key instanceof Error) throw key;
			return key;
		});
	}

	/** ssh2 breaks about 1 Ed25519 key in 256 (see SshKeys.generate): take one that parses. */
	private static newHostKey() {
		for (;;) {
			const key = utils.generateKeyPairSync("ed25519");
			if (!(utils.parseKey(key.public) instanceof Error)) return key;
		}
	}

	get methods() {
		return this.options.methods ?? ["password", "publickey"];
	}

	start() {
		return new Promise<this>((resolve) => {
			this.server = new Server({ hostKeys: [this.hostKey.private] }, (connection) =>
				this.onConnection(connection),
			);
			this.server.listen(0, "127.0.0.1", () => resolve(this));
		});
	}

	get port() {
		return (this.server?.address() as AddressInfo | null)?.port ?? 0;
	}

	stop() {
		return new Promise<void>((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
			this.server = null;
		});
	}

	private onConnection(connection: Connection) {
		this.connections++;
		connection.on("error", () => {});

		connection.on("authentication", (ctx) => this.authenticate(ctx));

		connection.on("ready", () => {
			connection.on("session", (accept) => {
				this.sessions++;
				const session = accept();
				session.on("exec", (acceptExec, rejectExec, info) => {
					this.execs.push(info.command);
					const reply = this.options.exec?.(info.command) ?? { exitCode: 0 };
					if ("refuse" in reply) {
						rejectExec();
						return;
					}
					const stream = acceptExec();
					if ("hang" in reply) return;
					if ("drop" in reply) {
						// After the exec was accepted, like a machine that is going down.
						setTimeout(() => {
							if (reply.drop === "disconnect") connection.end();
							else TestSshServer.socketOf(connection)?.destroy();
						}, 20);
						return;
					}
					if (reply.stdout) stream.write(reply.stdout);
					if (reply.stderr) stream.stderr.write(reply.stderr);
					stream.exit(reply.exitCode);
					stream.end();
				});
				for (const event of ["pty", "shell", "subsystem", "env", "auth-agent", "x11"]) {
					session.on(event, (_accept: unknown, reject?: () => void) => {
						this.otherRequests.push(event);
						reject?.();
					});
				}
			});
			for (const event of ["tcpip", "openssh.streamlocal", "request"]) {
				connection.on(event as "tcpip", (_accept: unknown, reject?: () => void) => {
					this.otherRequests.push(event);
					if (typeof reject === "function") reject();
				});
			}
		});
	}

	private authenticate(ctx: AuthContext) {
		this.authAttempts.push({ method: ctx.method, username: ctx.username });
		const allowed = this.methods.filter((method) => method !== "none");
		const userOK = ctx.username === this.options.username;

		if (ctx.method === "password" && this.methods.includes("password")) {
			if (userOK && ctx.password === this.options.password) return ctx.accept();
			return ctx.reject(allowed);
		}

		if (ctx.method === "keyboard-interactive" && this.methods.includes("keyboard-interactive")) {
			ctx.prompt([{ prompt: "Password: ", echo: false }], "", "", (answers) => {
				if (userOK && answers[0] === this.options.password) ctx.accept();
				else ctx.reject(allowed);
			});
			return;
		}

		if (ctx.method === "publickey" && this.methods.includes("publickey")) {
			const key = this.allowedKeys.find((candidate) => candidate.getPublicSSH().equals(ctx.key.data));
			if (!userOK || !key) return ctx.reject(allowed);
			// Without a signature the client only asks whether the key would be accepted.
			if (!ctx.signature) return ctx.accept();
			if (key.verify(ctx.blob ?? Buffer.alloc(0), ctx.signature, ctx.hashAlgo) === true) {
				return ctx.accept();
			}
			return ctx.reject(allowed);
		}

		if (ctx.method === "none" && this.methods.includes("none")) return ctx.accept();
		ctx.reject(allowed);
	}

	/** ssh2 keeps the connection's socket private; tests use it to drop the connection. */
	private static socketOf(connection: Connection) {
		return (connection as unknown as { _sock?: Socket })._sock;
	}
}

export namespace TestSshServer {
	export type Method = "password" | "publickey" | "keyboard-interactive" | "none";

	export type ExecReply =
		| { exitCode: number; stdout?: string; stderr?: string }
		/** Accept the exec, then end the connection without an exit status. */
		| { drop: "disconnect" | "reset" }
		/** Accept the exec and never answer. */
		| { hang: true }
		/** Refuse the exec request. */
		| { refuse: true };

	export type Options = {
		username: string;
		password?: string;
		/** Public keys (`ssh-ed25519 AAAA…` or OpenSSH private/public key text) that may log in. */
		publicKeys?: string[];
		/** Methods the server offers. Default: password and publickey. */
		methods?: Method[];
		exec?: (command: string) => ExecReply;
	};
}

/**
 * A TCP server that is not an SSH server: it accepts connections and either says nothing or
 * sends garbage and closes.
 */
export class NotSshServer {
	private server: NetServer | null = null;
	private readonly sockets = new Set<Socket>();

	constructor(private readonly behavior: "silent" | "garbage") {}

	start() {
		return new Promise<this>((resolve) => {
			this.server = createServer((socket) => {
				this.sockets.add(socket);
				socket.on("error", () => {});
				socket.on("close", () => this.sockets.delete(socket));
				if (this.behavior === "garbage") socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			});
			this.server.listen(0, "127.0.0.1", () => resolve(this));
		});
	}

	get port() {
		return (this.server?.address() as AddressInfo | null)?.port ?? 0;
	}

	stop() {
		for (const socket of this.sockets) socket.destroy();
		return new Promise<void>((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
			this.server = null;
		});
	}
}

/** A port on 127.0.0.1 that nothing listens on (connections are refused). */
export async function closedPort() {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}
