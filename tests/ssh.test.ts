import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ssh2";
import type { AgentProtocol } from "../src/protocol/agentProtocol";
import { SshKeys } from "../src/ssh/sshKeys";
import { SshRemote } from "../src/ssh/sshRemote";
import { Logger } from "../src/utils/logger";
import { closedPort, NotSshServer, TestSshServer } from "./helpers/ssh-server";

Logger.setLogLevel("critical");

const USER = "netignite";

/** The agent's own keys, as `pair` creates them. */
const agentKeys = SshKeys.generate(3);
const publicKeys = SshKeys.publicKeys(agentKeys);

/** A fingerprint no test server has. */
const OTHER_HOST_KEY = `SHA256:${"A".repeat(43)}`;

let servers: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(servers.map((server) => server.stop()));
	servers = [];
});

/** An SSH server that accepts both agent keys (or the ones given) for {@link USER}. */
async function startServer(options: Partial<TestSshServer.Options> = {}) {
	const server = await new TestSshServer({
		username: USER,
		publicKeys: [publicKeys.shutdown, publicKeys.reboot],
		methods: ["publickey"],
		...options,
	}).start();
	servers.push(server);
	return server;
}

function remote(options: SshRemote.Options = {}) {
	return new SshRemote(agentKeys, { maxLoginsPerMinute: 1000, ...options });
}

function checkRequest(
	port: number,
	overrides: Partial<AgentProtocol.SshCheckRequest> = {},
): AgentProtocol.SshCheckRequest {
	return { host: "127.0.0.1", port, username: USER, host_key: null, ...overrides };
}

function powerRequest(
	server: TestSshServer,
	overrides: Partial<AgentProtocol.SshPowerRequest> = {},
): AgentProtocol.SshPowerRequest {
	return {
		host: "127.0.0.1",
		port: server.port,
		username: USER,
		host_key: server.fingerprint,
		action: "shutdown",
		os: "posix",
		sudo: true,
		...overrides,
	};
}

async function check(ssh: SshRemote, request: AgentProtocol.SshCheckRequest) {
	const outcome = await ssh.check(request);
	if (!outcome.ok) throw new Error(`check refused: ${outcome.error}`);
	return outcome.result;
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

	test("generate makes two different unencrypted Ed25519 keys", () => {
		expect(agentKeys.shutdown).toStartWith("-----BEGIN OPENSSH PRIVATE KEY-----");
		expect(agentKeys.shutdown).not.toBe(agentKeys.reboot);
		expect(SshKeys.isUsablePrivateKey(agentKeys.shutdown)).toBe(true);
		expect(SshKeys.isUsablePrivateKey(agentKeys.reboot)).toBe(true);
		expect(publicKeys.shutdown).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/);
		expect(publicKeys.shutdown).not.toBe(publicKeys.reboot);
	});

	test("the public key is what ssh-keygen derives from the private key", () => {
		const keygen = Bun.which("ssh-keygen");
		if (!keygen) return;
		const dir = mkdtempSync(join(tmpdir(), "netignite-key-"));
		try {
			const file = join(dir, "id_ed25519");
			writeFileSync(file, agentKeys.shutdown, { mode: 0o600 });
			const derived = Bun.spawnSync([keygen, "-y", "-f", file]);
			// Windows' ssh-keygen refuses files whose ACL other users could read.
			if (derived.exitCode !== 0) return;
			expect(derived.stdout.toString().trim()).toBe(
				`${publicKeys.shutdown} netignite-agent-3-shutdown`,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("only unencrypted Ed25519 private keys are usable", () => {
		const ecdsa = utils.generateKeyPairSync("ecdsa", { bits: 256 });
		const encrypted = utils.generateKeyPairSync("ed25519", {
			passphrase: "secret",
			cipher: "aes256-cbc",
			rounds: 2,
		});
		expect(SshKeys.isUsablePrivateKey(ecdsa.private)).toBe(false);
		expect(SshKeys.isUsablePrivateKey(encrypted.private)).toBe(false);
		expect(SshKeys.isUsablePrivateKey(publicKeys.shutdown)).toBe(false);
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

	test("two logins fit the server's 25 s for a check, one its 15 s for a shutdown", () => {
		expect(SshRemote.BUDGET_MS * 2).toBeLessThan(25_000);
		expect(SshRemote.BUDGET_MS).toBeLessThan(15_000);
		expect(SshRemote.CONNECT_TIMEOUT_MS).toBeLessThan(SshRemote.BUDGET_MS);
		expect(SshRemote.EXEC_WAIT_MS).toBe(5000);
	});
});

describe("SSH_CHECK", () => {
	const ssh = remote();

	test("connection refused: offline", async () => {
		expect(await check(ssh, checkRequest(await closedPort()))).toEqual({ online: false });
	});

	test("connect timeout: offline, within the connect timeout", async () => {
		const hanging = remote({
			connectTimeoutMs: 200,
			// Like a SYN that never gets an answer.
			connect: (_host, _port, timeoutMs) =>
				new Promise((resolve) => setTimeout(() => resolve({ ok: false }), timeoutMs)),
		});
		const started = Date.now();
		expect(await check(hanging, checkRequest(22))).toEqual({ online: false });
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
		const result = await check(ssh, checkRequest(22, { host: "nonexistent.invalid" }));
		expect(result.online).toBe(false);
		expect(result.error).toContain("doesn't resolve");
	}, 10_000);

	test("both keys accepted, trust on first use reports the host key, no session", async () => {
		const server = await startServer();
		expect(await check(ssh, checkRequest(server.port))).toEqual({
			online: true,
			host_key: server.fingerprint,
			shutdown: true,
			reboot: true,
		});
		// One connection per key.
		expect(server.connections).toBe(2);
		expectNoSession(server);
	});

	test("the expected host key: both keys tried", async () => {
		const server = await startServer();
		const result = await check(ssh, checkRequest(server.port, { host_key: server.fingerprint }));
		expect(result).toEqual({
			online: true,
			host_key: server.fingerprint,
			shutdown: true,
			reboot: true,
		});
		expectNoSession(server);
	});

	test("only one key allowed: the check says which", async () => {
		const server = await startServer({ publicKeys: [publicKeys.reboot] });
		expect(await check(ssh, checkRequest(server.port))).toEqual({
			online: true,
			host_key: server.fingerprint,
			shutdown: false,
			reboot: true,
		});
		expectNoSession(server);
	});

	test("no key allowed, or another user: neither accepted", async () => {
		const server = await startServer({ publicKeys: [] });
		expect(await check(ssh, checkRequest(server.port))).toMatchObject({
			shutdown: false,
			reboot: false,
		});
		const other = await startServer();
		expect(await check(ssh, checkRequest(other.port, { username: "root" }))).toMatchObject({
			shutdown: false,
			reboot: false,
		});
	});

	test("a different host key: mismatch, and no key was offered", async () => {
		const server = await startServer();
		expect(await check(ssh, checkRequest(server.port, { host_key: OTHER_HOST_KEY }))).toEqual({
			online: true,
			host_key: server.fingerprint,
			shutdown: false,
			reboot: false,
			error: "host_key_mismatch",
		});
		expect(server.authAttempts).toEqual([]);
		// The second key isn't tried against a device that failed the host key check.
		expect(server.connections).toBe(1);
		expectNoSession(server);
	});

	test("a server that only takes passwords: no key offered, and never a password", async () => {
		const server = await startServer({
			methods: ["password", "keyboard-interactive"],
			password: "pw",
		});
		const result = await check(ssh, checkRequest(server.port));
		expect(result).toMatchObject({ online: true, shutdown: false, reboot: false });
		expect(new Set(server.authAttempts.map((attempt) => attempt.method))).toEqual(new Set(["none"]));
	});

	test("not an SSH server, silent: online, with a timeout error, within the budget", async () => {
		const server = await new NotSshServer("silent").start();
		servers.push(server);
		const started = Date.now();
		const result = await check(remote({ budgetMs: 400 }), checkRequest(server.port));
		expect(result).toEqual({
			online: true,
			shutdown: false,
			reboot: false,
			error: "SSH handshake timed out",
		});
		expect(Date.now() - started).toBeLessThan(1500);
	});

	test("not an SSH server, talking: online, with an error", async () => {
		const server = await new NotSshServer("garbage").start();
		servers.push(server);
		const result = await check(ssh, checkRequest(server.port));
		expect(result.online).toBe(true);
		expect(result.shutdown).toBe(false);
		expect(result.host_key).toBeUndefined();
		expect(result.error?.length).toBeGreaterThan(0);
		expect(result.error?.length).toBeLessThanOrEqual(SshRemote.ERROR_OUTPUT_CHARS);
	});

	test("checks run concurrently and independently", async () => {
		const server = await startServer();
		const results = await Promise.all([
			check(ssh, checkRequest(server.port)),
			check(ssh, checkRequest(server.port, { username: "root" })),
			check(ssh, checkRequest(server.port, { host_key: OTHER_HOST_KEY })),
		]);
		expect(results.map((result) => result.error ?? `${result.shutdown}`)).toEqual([
			"true",
			"false",
			"host_key_mismatch",
		]);
		expectNoSession(server);
	});
});

describe("SSH_POWER", () => {
	const ssh = remote();

	test("runs exactly the fixed command for each action, OS and sudo flag", async () => {
		const server = await startServer({ exec: () => ({ exitCode: 0 }) });
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
			expect(await ssh.power(powerRequest(server, { action, os, sudo }))).toEqual({ ok: true });
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

	test("logs in with the action's key", async () => {
		// The device only allows the reboot key.
		const server = await startServer({ publicKeys: [publicKeys.reboot] });
		expect(await ssh.power(powerRequest(server, { action: "shutdown" }))).toEqual({
			ok: false,
			error: "the device didn't accept the agent's shutdown key",
		});
		expect(await ssh.power(powerRequest(server, { action: "reboot" }))).toEqual({ ok: true });
		expect(server.execs).toEqual(["sudo -n shutdown -r now"]);
	});

	test("a non-zero exit status fails with the start of stderr", async () => {
		const server = await startServer({
			exec: () => ({ exitCode: 1, stderr: "sudo: a password is required\n" }),
		});
		const result = await ssh.power(powerRequest(server));
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
		const result = await ssh.power(powerRequest(server));
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
		const result = await ssh.power(powerRequest(server, { os: "windows" }));
		expect(result).toEqual({
			ok: false,
			error: '"shutdown /s /t 0" failed with exit code 5: Access is denied.(5)',
		});
	});

	test("the connection dropping before an exit status means the machine is going down", async () => {
		for (const drop of ["disconnect", "reset"] as const) {
			const server = await startServer({ exec: () => ({ drop }) });
			expect(await ssh.power(powerRequest(server))).toEqual({ ok: true });
			expect(server.execs).toEqual(["sudo -n shutdown -h now"]);
		}
	});

	test("no exit status within the wait: the command is still running", async () => {
		const server = await startServer({ exec: () => ({ hang: true }) });
		const started = Date.now();
		const result = await remote({ execWaitMs: 200 }).power(powerRequest(server));
		expect(result).toEqual({ ok: true });
		expect(Date.now() - started).toBeLessThan(2000);
	});

	test("the wait for the exit status stays within the budget", async () => {
		const server = await startServer({ exec: () => ({ hang: true }) });
		const started = Date.now();
		await remote({ budgetMs: 600, execWaitMs: 5000 }).power(powerRequest(server));
		expect(Date.now() - started).toBeLessThan(1500);
	});

	test("a refused exec request fails", async () => {
		const server = await startServer({ exec: () => ({ refuse: true }) });
		const result = await ssh.power(powerRequest(server));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("refused to run the command");
	});

	test("a changed host key: no key offered, no command", async () => {
		const server = await startServer();
		expect(await ssh.power(powerRequest(server, { host_key: OTHER_HOST_KEY }))).toEqual({
			ok: false,
			error: "host key changed",
		});
		expect(server.authAttempts).toEqual([]);
		expectNoSession(server);
	});

	test("an unreachable host fails", async () => {
		const port = await closedPort();
		const result = await ssh.power({ ...powerRequest(await startServer()), port });
		expect(result).toEqual({ ok: false, error: `Couldn't connect to 127.0.0.1 port ${port}` });
	});
});

describe("login limit", () => {
	test("at most 10 logins a minute: a check takes two, a shutdown one", async () => {
		let now = 1_000_000;
		const limited = new SshRemote(agentKeys, { now: () => now });
		const server = await startServer();

		for (let i = 0; i < 5; i++)
			expect((await limited.check(checkRequest(server.port))).ok).toBe(true);
		expect(await limited.check(checkRequest(server.port))).toEqual({
			ok: false,
			error: "Too many SSH logins (at most 10 a minute); try again in 60 s",
		});
		expect(await limited.power(powerRequest(server))).toMatchObject({ ok: false });
		// Refused requests don't connect.
		expect(server.connections).toBe(10);

		now += 60_000;
		expect(await limited.power(powerRequest(server, { action: "reboot" }))).toEqual({ ok: true });
	});
});

describe("keys stay out of the logs", () => {
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

	test("no part of a private key appears in any log line", async () => {
		const server = await startServer();
		const ssh = remote();
		await ssh.check(checkRequest(server.port));
		await ssh.check(checkRequest(server.port, { username: "root" }));
		await ssh.power(powerRequest(server));
		await ssh.power(powerRequest(server, { action: "reboot", sudo: false }));

		expect(lines.length).toBeGreaterThan(0);
		const keyLines = [agentKeys.shutdown, agentKeys.reboot].flatMap((key) =>
			key.split("\n").filter((line) => line.length > 0 && !line.startsWith("-----")),
		);
		for (const line of lines) {
			for (const keyLine of keyLines) expect(line).not.toContain(keyLine);
			expect(line).not.toContain("PRIVATE KEY");
		}
	});
});
