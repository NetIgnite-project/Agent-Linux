import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { utils } from "ssh2";
import type { AgentProtocol } from "../src/protocol/agentProtocol";
import { SshKeys } from "../src/ssh/sshKeys";
import { SshRemote } from "../src/ssh/sshRemote";
import { Logger } from "../src/utils/logger";
import { closedPort, NotSshServer, TestSshServer } from "./helpers/ssh-server";

Logger.setLogLevel("critical");

const USER = "admin";
const PASSWORD = "correct horse battery staple";

const keys = {
	ed25519: utils.generateKeyPairSync("ed25519"),
	ecdsa: utils.generateKeyPairSync("ecdsa", { bits: 256 }),
	rsa: utils.generateKeyPairSync("rsa", { bits: 2048 }),
	stranger: utils.generateKeyPairSync("ed25519"),
};

/** A fingerprint no test server has. */
const OTHER_HOST_KEY = `SHA256:${"A".repeat(43)}`;

let servers: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(servers.map((server) => server.stop()));
	servers = [];
});

async function startServer(options: Partial<TestSshServer.Options> = {}) {
	const server = await new TestSshServer({
		username: USER,
		password: PASSWORD,
		publicKeys: [keys.ed25519.public, keys.ecdsa.public, keys.rsa.public],
		...options,
	}).start();
	servers.push(server);
	return server;
}

function checkRequest(
	port: number,
	overrides: Partial<AgentProtocol.SshCheckRequest> = {},
): AgentProtocol.SshCheckRequest {
	return {
		host: "127.0.0.1",
		port,
		username: USER,
		auth: { type: "password", password: PASSWORD },
		host_key: null,
		...overrides,
	};
}

function execRequest(
	server: TestSshServer,
	overrides: Partial<AgentProtocol.SshExecRequest> = {},
): AgentProtocol.SshExecRequest {
	return {
		host: "127.0.0.1",
		port: server.port,
		username: USER,
		auth: { type: "key", private_key: keys.ed25519.private },
		host_key: server.fingerprint,
		action: "shutdown",
		os: "posix",
		sudo: true,
		...overrides,
	};
}

/** Nothing but authentication happened: no session, channel or global request. */
function expectNoSession(server: TestSshServer) {
	expect(server.sessions).toBe(0);
	expect(server.execs).toEqual([]);
	expect(server.otherRequests).toEqual([]);
}

describe("SshKeys", () => {
	test("fingerprints match ssh-keygen -lf", () => {
		// Keys and `ssh-keygen -lf` output from OpenSSH 10.0 (Debian 13).
		const vectors = [
			[
				"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHASx8h7U+pCt2tdb/sSKWIOpb/KcQGnSoSxVll/38Xn",
				"SHA256:DcMC1wdAY3Z/tgRBo2BNYADDzJ63IywaXdcFMUjqjC8",
			],
			[
				"ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHszvSv1Lr/4MaSMXUAr1D0loemOeO1fGyAbZDGmmWoAFgaY01i4NWvm/H0r8/bMI0cxmBpDhYg1Qhx/Hh1VTLM=",
				"SHA256:yhobIKHdrAiswv771Hw6Blksv5SQJ2fCst3c6fS+UW0",
			],
		] as const;
		for (const [publicKey, fingerprint] of vectors) {
			const blob = Buffer.from(publicKey.split(" ")[1] ?? "", "base64");
			expect(SshKeys.fingerprint(blob)).toBe(fingerprint);
			expect(SshKeys.FINGERPRINT_PATTERN.test(fingerprint)).toBe(true);
		}
	});

	test("the fingerprint pattern wants SHA256 and 43 base64 characters without padding", () => {
		const valid = "SHA256:DcMC1wdAY3Z/tgRBo2BNYADDzJ63IywaXdcFMUjqjC8";
		expect(SshKeys.FINGERPRINT_PATTERN.test(valid)).toBe(true);
		for (const invalid of [
			`${valid}=`,
			valid.slice(0, -1),
			valid.replace("SHA256", "sha256"),
			valid.replace("SHA256:", "MD5:"),
			"MD5:16:27:ac:a5:76:28:2d:36:63:1b:56:4d:eb:df:a6:48",
			`${valid}\n`,
			"",
		]) {
			expect(SshKeys.FINGERPRINT_PATTERN.test(invalid)).toBe(false);
		}
	});

	test("accepts unencrypted private keys only", () => {
		expect(SshKeys.isUsablePrivateKey(keys.ed25519.private)).toBe(true);
		expect(SshKeys.isUsablePrivateKey(keys.ecdsa.private)).toBe(true);
		expect(SshKeys.isUsablePrivateKey(keys.rsa.private)).toBe(true);
		expect(keys.ed25519.private).toStartWith("-----BEGIN OPENSSH PRIVATE KEY-----");

		const encrypted = utils.generateKeyPairSync("ed25519", {
			passphrase: "secret",
			cipher: "aes256-cbc",
			rounds: 2,
		});
		expect(SshKeys.isUsablePrivateKey(encrypted.private)).toBe(false);
		expect(SshKeys.isUsablePrivateKey(keys.ed25519.public)).toBe(false);
		expect(SshKeys.isUsablePrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n")).toBe(false);
		expect(SshKeys.isUsablePrivateKey("")).toBe(false);
		expect(SshKeys.isUsablePrivateKey("x".repeat(SshKeys.MAX_PRIVATE_KEY_LENGTH + 1))).toBe(false);
	});
});

describe("SshRemote.command", () => {
	test("only the fixed commands, for every action, OS and sudo flag", () => {
		const cases: Array<[SshRemote.Action, SshRemote.OS, boolean, string]> = [
			["shutdown", "posix", false, "shutdown -h now"],
			["reboot", "posix", false, "shutdown -r now"],
			["shutdown", "posix", true, "sudo -n shutdown -h now"],
			["reboot", "posix", true, "sudo -n shutdown -r now"],
			["shutdown", "windows", false, "shutdown /s /t 0"],
			["reboot", "windows", false, "shutdown /r /t 0"],
			// No sudo on Windows.
			["shutdown", "windows", true, "shutdown /s /t 0"],
			["reboot", "windows", true, "shutdown /r /t 0"],
		];
		for (const [action, os, sudo, command] of cases) {
			expect(SshRemote.command(action, os, sudo)).toBe(command);
		}
	});

	test("the time limits fit the server's 10 s", () => {
		expect(SshRemote.BUDGET_MS).toBeLessThanOrEqual(8000);
		expect(SshRemote.CONNECT_TIMEOUT_MS).toBeLessThan(SshRemote.BUDGET_MS);
		expect(SshRemote.EXEC_WAIT_MS).toBe(5000);
	});
});

describe("SSH_CHECK", () => {
	const remote = new SshRemote();

	test("connection refused: offline", async () => {
		expect(await remote.check(checkRequest(await closedPort()))).toEqual({ online: false });
	});

	test("connect timeout: offline, within the connect timeout", async () => {
		const hanging = new SshRemote({
			connectTimeoutMs: 200,
			// Like a SYN that never gets an answer.
			connect: (_host, _port, timeoutMs) =>
				new Promise((resolve) => setTimeout(() => resolve({ ok: false }), timeoutMs)),
		});
		const started = Date.now();
		expect(await hanging.check(checkRequest(22))).toEqual({ online: false });
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test("the real connect gives up after the connect timeout", async () => {
		const started = Date.now();
		// 192.0.2.0/24 (TEST-NET-1) is never routed: either unreachable at once or no answer.
		const result = await SshRemote.tcpConnect("192.0.2.1", 22, 300);
		expect(result).toEqual({ ok: false });
		expect(Date.now() - started).toBeLessThan(1500);
	});

	test("a host name that doesn't resolve: offline, with an error", async () => {
		const result = await remote.check(checkRequest(22, { host: "nonexistent.invalid" }));
		expect(result.online).toBe(false);
		expect(result.error).toContain("doesn't resolve");
	}, 10_000);

	test("password: trust on first use reports the host key", async () => {
		const server = await startServer();
		expect(await remote.check(checkRequest(server.port))).toEqual({
			online: true,
			host_key: server.fingerprint,
			authenticated: true,
		});
		expectNoSession(server);
	});

	test("the expected host key: logged in", async () => {
		const server = await startServer();
		expect(await remote.check(checkRequest(server.port, { host_key: server.fingerprint }))).toEqual({
			online: true,
			host_key: server.fingerprint,
			authenticated: true,
		});
		expectNoSession(server);
	});

	test("a different host key: mismatch, and no credentials were sent", async () => {
		const server = await startServer();
		expect(await remote.check(checkRequest(server.port, { host_key: OTHER_HOST_KEY }))).toEqual({
			online: true,
			host_key: server.fingerprint,
			authenticated: false,
			error: "host_key_mismatch",
		});
		expect(server.authAttempts).toEqual([]);
		expectNoSession(server);
	});

	test("a wrong password: auth_failed", async () => {
		const server = await startServer();
		const result = await remote.check(
			checkRequest(server.port, {
				host_key: server.fingerprint,
				auth: { type: "password", password: "wrong" },
			}),
		);
		expect(result).toEqual({
			online: true,
			host_key: server.fingerprint,
			authenticated: false,
			error: "auth_failed",
		});
		expect(server.authAttempts.map((attempt) => attempt.method)).toContain("password");
		expectNoSession(server);
	});

	test("a wrong user: auth_failed", async () => {
		const server = await startServer();
		const result = await remote.check(checkRequest(server.port, { username: "root" }));
		expect(result.error).toBe("auth_failed");
	});

	for (const type of ["ed25519", "ecdsa", "rsa"] as const) {
		test(`${type} key: logged in`, async () => {
			const server = await startServer({ methods: ["publickey"] });
			const result = await remote.check(
				checkRequest(server.port, { auth: { type: "key", private_key: keys[type].private } }),
			);
			expect(result).toEqual({ online: true, host_key: server.fingerprint, authenticated: true });
			expect(server.authAttempts.at(-1)?.method).toBe("publickey");
			expectNoSession(server);
		});
	}

	test("an unknown key: auth_failed", async () => {
		const server = await startServer({ methods: ["publickey"] });
		const result = await remote.check(
			checkRequest(server.port, { auth: { type: "key", private_key: keys.stranger.private } }),
		);
		expect(result).toEqual({
			online: true,
			host_key: server.fingerprint,
			authenticated: false,
			error: "auth_failed",
		});
	});

	test("a password only offered as keyboard-interactive still works", async () => {
		const server = await startServer({ methods: ["keyboard-interactive"] });
		expect((await remote.check(checkRequest(server.port))).authenticated).toBe(true);
		// The method the server doesn't offer isn't tried.
		expect(server.authAttempts.map((attempt) => attempt.method)).toEqual([
			"none",
			"keyboard-interactive",
		]);
		expectNoSession(server);
	});

	test("a key isn't offered to a server that only takes passwords", async () => {
		const server = await startServer({ methods: ["password"] });
		const result = await remote.check(
			checkRequest(server.port, { auth: { type: "key", private_key: keys.ed25519.private } }),
		);
		expect(result.error).toBe("auth_failed");
		expect(server.authAttempts.map((attempt) => attempt.method)).toEqual(["none"]);
	});

	test("not an SSH server, silent: online, with a timeout error, within the budget", async () => {
		const server = await new NotSshServer("silent").start();
		servers.push(server);
		const started = Date.now();
		const result = await new SshRemote({ budgetMs: 400 }).check(checkRequest(server.port));
		expect(result).toEqual({
			online: true,
			authenticated: false,
			error: "SSH handshake timed out",
		});
		expect(Date.now() - started).toBeLessThan(1500);
	});

	test("not an SSH server, talking: online, with an error", async () => {
		const server = await new NotSshServer("garbage").start();
		servers.push(server);
		const result = await remote.check(checkRequest(server.port));
		expect(result.online).toBe(true);
		expect(result.authenticated).toBe(false);
		expect(result.host_key).toBeUndefined();
		expect(result.error?.length).toBeGreaterThan(0);
		expect(result.error?.length).toBeLessThanOrEqual(SshRemote.ERROR_OUTPUT_CHARS);
	});

	test("checks run concurrently and independently", async () => {
		const server = await startServer();
		const results = await Promise.all([
			remote.check(checkRequest(server.port)),
			remote.check(checkRequest(server.port, { auth: { type: "password", password: "no" } })),
			remote.check(checkRequest(server.port, { host_key: OTHER_HOST_KEY })),
		]);
		expect(results.map((result) => result.error ?? "ok")).toEqual([
			"ok",
			"auth_failed",
			"host_key_mismatch",
		]);
		expectNoSession(server);
	});
});

describe("SSH_EXEC", () => {
	const remote = new SshRemote();

	test("runs exactly the fixed command for each action, OS and sudo flag", async () => {
		const server = await startServer();
		const combinations: Array<[SshRemote.Action, SshRemote.OS, boolean]> = [
			["shutdown", "posix", false],
			["reboot", "posix", false],
			["shutdown", "posix", true],
			["reboot", "posix", true],
			["shutdown", "windows", false],
			["reboot", "windows", false],
			["shutdown", "windows", true],
		];
		for (const [action, os, sudo] of combinations) {
			expect(await remote.exec(execRequest(server, { action, os, sudo }))).toEqual({ ok: true });
		}
		expect(server.execs).toEqual([
			"shutdown -h now",
			"shutdown -r now",
			"sudo -n shutdown -h now",
			"sudo -n shutdown -r now",
			"shutdown /s /t 0",
			"shutdown /r /t 0",
			"shutdown /s /t 0",
		]);
		// One session per request, and nothing else (no pty, shell, env or forwarding).
		expect(server.sessions).toBe(combinations.length);
		expect(server.otherRequests).toEqual([]);
	});

	test("with a password", async () => {
		const server = await startServer();
		const result = await remote.exec(
			execRequest(server, { auth: { type: "password", password: PASSWORD }, action: "reboot" }),
		);
		expect(result).toEqual({ ok: true });
		expect(server.execs).toEqual(["sudo -n shutdown -r now"]);
	});

	test("a non-zero exit status fails with the start of stderr", async () => {
		const server = await startServer({
			exec: () => ({ exitCode: 1, stderr: "sudo: a password is required\n" }),
		});
		const result = await remote.exec(execRequest(server));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("sudo: a password is required");
		expect(result.error).toContain("exit code 1");
		expect(result.error).toContain("sudo -n shutdown -h now");
	});

	test("only the first 200 characters of stderr, on one line", async () => {
		const server = await startServer({
			exec: () => ({ exitCode: 5, stderr: `line one\r\nline two\t${"x".repeat(5000)}` }),
		});
		const result = await remote.exec(execRequest(server));
		if (result.ok) throw new Error("expected a failure");
		expect(result.error).toContain("line one line two xxx");
		const detail = result.error.slice(result.error.indexOf(": ") + 2);
		expect(detail).toHaveLength(SshRemote.ERROR_OUTPUT_CHARS);
		expect(result.error).not.toMatch(/[\r\n\t]/);
	});

	test("without stderr, stdout explains the failure (Windows tools write there)", async () => {
		const server = await startServer({
			exec: () => ({ exitCode: 5, stdout: "Access is denied.(5)\r\n" }),
		});
		const result = await remote.exec(execRequest(server, { os: "windows" }));
		expect(result).toEqual({
			ok: false,
			error: '"shutdown /s /t 0" failed with exit code 5: Access is denied.(5)',
		});
	});

	test("the connection dropping before an exit status means the machine is going down", async () => {
		for (const drop of ["disconnect", "reset"] as const) {
			const server = await startServer({ exec: () => ({ drop }) });
			expect(await remote.exec(execRequest(server))).toEqual({ ok: true });
			expect(server.execs).toEqual(["sudo -n shutdown -h now"]);
		}
	});

	test("no exit status within the wait: the command is still running", async () => {
		const server = await startServer({ exec: () => ({ hang: true }) });
		const started = Date.now();
		const result = await new SshRemote({ execWaitMs: 200 }).exec(execRequest(server));
		expect(result).toEqual({ ok: true });
		expect(Date.now() - started).toBeLessThan(2000);
	});

	test("the wait for the exit status stays within the budget", async () => {
		const server = await startServer({ exec: () => ({ hang: true }) });
		const started = Date.now();
		await new SshRemote({ budgetMs: 600, execWaitMs: 5000 }).exec(execRequest(server));
		expect(Date.now() - started).toBeLessThan(1500);
	});

	test("a refused exec request fails", async () => {
		const server = await startServer({ exec: () => ({ refuse: true }) });
		const result = await remote.exec(execRequest(server));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("refused to run the command");
	});

	test("a changed host key: no credentials, no command", async () => {
		const server = await startServer();
		expect(await remote.exec(execRequest(server, { host_key: OTHER_HOST_KEY }))).toEqual({
			ok: false,
			error: "host key changed",
		});
		expect(server.authAttempts).toEqual([]);
		expectNoSession(server);
	});

	test("wrong credentials: no command", async () => {
		const server = await startServer();
		expect(
			await remote.exec(
				execRequest(server, { auth: { type: "key", private_key: keys.stranger.private } }),
			),
		).toEqual({ ok: false, error: "authentication failed" });
		expect(
			await remote.exec(execRequest(server, { auth: { type: "password", password: "nope" } })),
		).toEqual({ ok: false, error: "authentication failed" });
		expectNoSession(server);
	});

	test("an unreachable host fails", async () => {
		const port = await closedPort();
		const result = await remote.exec({ ...execRequest(await startServer()), port });
		expect(result).toEqual({ ok: false, error: `Couldn't connect to 127.0.0.1 port ${port}` });
	});
});

describe("credentials stay out of the logs", () => {
	const lines: string[] = [];
	const original = { ...console };

	beforeAll(() => {
		Logger.setLogLevel("debug");
		for (const method of ["debug", "info", "warn", "error", "log"] as const) {
			console[method] = (...args: unknown[]) => {
				lines.push(args.map(String).join(" "));
			};
		}
	});

	afterAll(() => {
		Object.assign(console, original);
		Logger.setLogLevel("critical");
	});

	test("neither the password nor the key appears in any log line", async () => {
		const server = await startServer();
		const remote = new SshRemote();
		await remote.check(checkRequest(server.port));
		await remote.check(checkRequest(server.port, { auth: { type: "password", password: "nope" } }));
		await remote.exec(execRequest(server));
		await remote.exec(
			execRequest(server, { auth: { type: "password", password: PASSWORD }, sudo: false }),
		);

		expect(lines.length).toBeGreaterThan(0);
		const keyBody = keys.ed25519.private.split("\n")[1] ?? "";
		for (const line of lines) {
			expect(line).not.toContain(PASSWORD);
			expect(line).not.toContain("nope");
			expect(line).not.toContain(keyBody);
			expect(line).not.toContain("PRIVATE KEY");
		}
	});
});
