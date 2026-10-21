import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentClient } from "../src/agent/agentClient";
import type { HostControl } from "../src/agent/hostControl";
import { RunCMD } from "../src/commands/run-cmd";
import type { AgentConfig } from "../src/config/agentConfig";
import { StatusProbe } from "../src/net/statusProbe";
import { SshKeys } from "../src/ssh/sshKeys";
import { Logger } from "../src/utils/logger";
import { FakeNetIgniteServer } from "./helpers/fake-server";
import { ServerProtocol } from "./helpers/server-protocol";
import { TestSshServer } from "./helpers/ssh-server";

Logger.setLogLevel("critical");

const AGENT_ID = 5;
/** Short timings, so reconnects happen within a test. */
const FAST = { reconnectMinMs: 50, reconnectMaxMs: 400, silenceTimeoutMs: 5_000 };

let server: FakeNetIgniteServer;
let clients: AgentClient[];

beforeEach(() => {
	server = new FakeNetIgniteServer().start();
	clients = [];
});

afterEach(async () => {
	await Promise.all(clients.map((client) => client.stop()));
	await server.stop();
});

function configFor(tokenID: string, secret: string): AgentConfig.Data {
	return {
		server: server.url,
		agent_id: AGENT_ID,
		token_id: tokenID,
		secret,
		wol: { enabled: false },
	};
}

function startAgent(options: RunCMD.ClientOptions = {}, config?: AgentConfig.Data) {
	const { tokenID, secret } = server.addCredential(AGENT_ID);
	const client = RunCMD.createClient(config ?? configFor(tokenID, secret), {
		hostControl: async () => {},
		hostControlDelayMs: 50,
		...options,
		client: { ...FAST, ...options.client },
	});
	clients.push(client);
	client.start();
	return client;
}

/** Fails the test if the client finishes within `ms`; returns the attempts seen meanwhile. */
async function expectNoReconnect(ms: number) {
	const before = server.upgradeAttempts.length;
	await Bun.sleep(ms);
	expect(server.upgradeAttempts.length).toBe(before);
}

describe("connecting", () => {
	test("sends a HELLO the server accepts as its first frame, then HOST_STATUS", async () => {
		startAgent();
		const connection = await server.waitForConnection(0);
		const hello = await connection.hello();

		expect(connection.frames[0]?.frame).toMatchObject({ t: "evt", cmd: "HELLO" });
		expect(hello.protocol).toBe(2);
		expect(hello.kind).toBe("linux");
		expect(hello.version.length).toBeGreaterThan(0);
		expect(hello.capabilities).toEqual(["host.status", "host.control"]);
		expect(hello.info).toMatchObject({ hostname: expect.any(String), arch: process.arch });

		const { frame } = await connection.waitForFrame((f) => f.t === "evt" && f.cmd === "HOST_STATUS");
		expect(frame.t === "evt" && ServerProtocol.HostStatus.safeParse(frame.p).success).toBe(true);
	});

	test("Wake-on-LAN mode adds the WOL capabilities", async () => {
		startAgent({ wol: true });
		const hello = await (await server.waitForConnection(0)).hello();
		expect(hello.capabilities).toEqual(
			expect.arrayContaining([
				"host.status",
				"host.control",
				"wake",
				"status.ip",
				"status.host",
				"status.tcp",
			]),
		);
	});

	test("uses the base path and the bearer credential", async () => {
		const { tokenID, secret } = server.addCredential(AGENT_ID);
		const client = RunCMD.createClient(configFor(tokenID, secret), { client: FAST });
		clients.push(client);
		client.start();
		const connection = await server.waitForConnection(0);
		expect(connection.agentID).toBe(AGENT_ID);
		expect(server.basePath).toBe("/netignite");
	});

	test("stop() closes with 1000 and resolves finished", async () => {
		const client = startAgent();
		const connection = await server.waitForConnection(0);
		await connection.hello();

		await client.stop();
		expect(await client.finished).toEqual({ type: "stopped" });
		expect((await connection.waitForClose()).code).toBe(1000);
		await expectNoReconnect(200);
	});
});

describe("requests", () => {
	test("PING", async () => {
		startAgent();
		const connection = await server.waitForConnection(0);
		await connection.hello();

		const answer = await connection.request("PING");
		expect(answer).toMatchObject({ t: "res", ok: true, p: {} });
	});

	test("unknown commands and bad parameters get ok:false", async () => {
		startAgent({ wol: true });
		const connection = await server.waitForConnection(0);
		await connection.hello();

		expect(await connection.request("REBOOT_EVERYTHING")).toMatchObject({
			ok: false,
			err: "Unknown command REBOOT_EVERYTHING",
		});
		expect(await connection.request("WAKE", { mac: "nope", port: 9 })).toMatchObject({
			ok: false,
			err: "Invalid MAC address",
		});
		expect(await connection.request("HOST_CONTROL", { action: "format" })).toMatchObject({
			ok: false,
			err: "Unknown action",
		});
	});

	test("WAKE and STATUS are refused outside Wake-on-LAN mode", async () => {
		const woken: string[] = [];
		startAgent({
			wol: false,
			wake: async (mac) => {
				woken.push(mac.toString());
			},
		});
		const connection = await server.waitForConnection(0);
		await connection.hello();

		const wake = await connection.request("WAKE", { mac: "AA:BB:CC:DD:EE:FF", port: 9 });
		const status = await connection.request("STATUS", {
			target: { type: "ip", address: "127.0.0.1" },
			icmp: true,
		});
		expect(wake.ok).toBe(false);
		expect(wake.err).toContain("Wake-on-LAN mode is off");
		expect(status.ok).toBe(false);
		expect(woken).toEqual([]);
	});

	test("WAKE in Wake-on-LAN mode", async () => {
		const woken: Array<[string, number]> = [];
		startAgent({
			wol: true,
			wake: async (mac, port) => {
				woken.push([mac.toString(), port]);
			},
		});
		const connection = await server.waitForConnection(0);
		await connection.hello();

		expect(await connection.request("WAKE", { mac: "aa:bb:cc:dd:ee:ff", port: 9 })).toMatchObject({
			ok: true,
			p: {},
		});
		expect(woken).toEqual([["AA:BB:CC:DD:EE:FF", 9]]);
	});

	test("STATUS in Wake-on-LAN mode, with a real TCP probe", async () => {
		startAgent({ wol: true, statusProbe: new StatusProbe() });
		const connection = await server.waitForConnection(0);
		await connection.hello();

		// The fake server's own port answers; ICMP is off so the test doesn't need ping.
		const answer = await connection.request("STATUS", {
			target: { type: "ip", address: "127.0.0.1" },
			icmp: false,
			tcp_port: server.port,
		});
		expect(answer).toMatchObject({ ok: true, p: { online: true } });
		expect(answer.elapsedMs).toBeLessThan(4500);
	});

	test("STATUS answers within the server's timeout even if probes hang", async () => {
		startAgent({
			wol: true,
			statusProbe: { check: (request) => new StatusProbe(hangingDeps()).check(request, 300) },
		});
		const connection = await server.waitForConnection(0);
		await connection.hello();

		const answer = await connection.request("STATUS", {
			target: { type: "host", host: "slow.lan" },
			icmp: true,
		});
		expect(answer).toMatchObject({ ok: true, p: { online: false } });
	});

	test("requests run concurrently: PING doesn't wait for a slow STATUS", async () => {
		startAgent({
			wol: true,
			statusProbe: {
				check: async () => {
					await Bun.sleep(300);
					return true;
				},
			},
		});
		const connection = await server.waitForConnection(0);
		await connection.hello();

		const [status, ping] = await Promise.all([
			connection.request("STATUS", { target: { type: "ip", address: "10.0.0.1" }, icmp: true }),
			connection.request("PING"),
		]);
		expect(status.ok && ping.ok).toBe(true);
		expect(ping.receivedAt).toBeLessThan(status.receivedAt);
	});

	test("HOST_CONTROL answers ok first, then calls the executor", async () => {
		const calls: Array<{ action: HostControl.Action; at: number }> = [];
		startAgent({
			hostControl: async (action) => {
				calls.push({ action, at: Date.now() });
			},
			hostControlDelayMs: 100,
		});
		const connection = await server.waitForConnection(0);
		await connection.hello();

		const answer = await connection.request("HOST_CONTROL", { action: "reboot" });
		expect(answer).toMatchObject({ ok: true, p: {} });
		expect(calls).toEqual([]);

		await Bun.sleep(250);
		expect(calls.map((call) => call.action)).toEqual(["reboot"]);
		expect(calls[0]?.at ?? 0).toBeGreaterThanOrEqual(answer.receivedAt + 50);
	});

	test("every answer matches the server's frame schema", async () => {
		startAgent({ wol: true });
		const connection = await server.waitForConnection(0);
		await connection.hello();
		await connection.request("PING");
		await connection.request("NOPE");
		expect(connection.frames.every((entry) => entry.frame !== null)).toBe(true);
	});
});

describe("SSH requests", () => {
	const keys = SshKeys.generate(AGENT_ID);
	const publicKeys = SshKeys.publicKeys(keys);
	let ssh: TestSshServer;

	beforeEach(async () => {
		ssh = await new TestSshServer({
			username: "netignite",
			publicKeys: [publicKeys.shutdown, publicKeys.reboot],
			methods: ["publickey"],
			exec: (command) =>
				command.includes("-r")
					? { exitCode: 1, stderr: "sudo: a password is required\n" }
					: { exitCode: 0 },
		}).start();
	});

	afterEach(async () => {
		await ssh.stop();
	});

	function target(overrides: Record<string, unknown> = {}) {
		return { host: "127.0.0.1", port: ssh.port, username: "netignite", host_key: null, ...overrides };
	}

	/** An agent in Wake-on-LAN mode with SSH keys; the fake server has no TLS, so tests allow that. */
	async function sshAgent(
		config: Partial<AgentConfig.Data> = {},
		options: RunCMD.ClientOptions = {},
	) {
		const { tokenID, secret } = server.addCredential(AGENT_ID);
		startAgent(
			{ sshRequiresTls: false, ...options },
			{ ...configFor(tokenID, secret), wol: { enabled: true }, ssh_keys: keys, ...config },
		);
		const connection = await server.waitForConnection(0);
		return { connection, hello: await connection.hello() };
	}

	test("HELLO offers ssh.power with the public keys, never the private ones", async () => {
		const { connection, hello } = await sshAgent();
		expect(hello.capabilities).toContain("ssh.power");
		expect(hello.ssh_keys).toEqual(publicKeys);
		const helloText = JSON.stringify(connection.frames.map((entry) => entry.frame));
		expect(helloText).not.toContain("PRIVATE KEY");
	});

	test("SSH_CHECK: trust on first use, then a check against the stored key", async () => {
		const { connection } = await sshAgent();

		const first = await connection.request("SSH_CHECK", target(), 25_000);
		expect(first).toMatchObject({
			ok: true,
			p: { online: true, host_key: ssh.fingerprint, shutdown: true, reboot: true },
		});

		const second = await connection.request(
			"SSH_CHECK",
			target({ host_key: first.p?.host_key }),
			25_000,
		);
		expect(second.p).toEqual({
			online: true,
			host_key: ssh.fingerprint,
			shutdown: true,
			reboot: true,
		});

		// Two logins per check and never a session.
		expect(ssh.connections).toBe(4);
		expect(ssh.sessions).toBe(0);
		expect(ssh.execs).toEqual([]);
	});

	test("SSH_CHECK reports a changed host key", async () => {
		const { connection } = await sshAgent();
		const mismatch = await connection.request(
			"SSH_CHECK",
			target({ host_key: `SHA256:${"B".repeat(43)}` }),
			25_000,
		);
		expect(mismatch.p).toEqual({
			online: true,
			host_key: ssh.fingerprint,
			shutdown: false,
			reboot: false,
			error: "host_key_mismatch",
		});
		expect(ssh.authAttempts).toEqual([]);
	});

	test("SSH_POWER runs the fixed command and reports failures", async () => {
		const { connection } = await sshAgent();
		const power = (overrides: Record<string, unknown>) =>
			connection.request(
				"SSH_POWER",
				target({ host_key: ssh.fingerprint, os: "posix", sudo: true, ...overrides }),
				15_000,
			);

		expect(await power({ action: "shutdown" })).toMatchObject({ ok: true, p: {} });

		const reboot = await power({ action: "reboot" });
		expect(reboot.ok).toBe(false);
		expect(reboot.err).toContain("sudo: a password is required");

		expect(await power({ action: "shutdown", host_key: null })).toMatchObject({
			ok: false,
			err: "Missing host key",
		});
		expect(await power({ action: "shutdown", host_key: `SHA256:${"C".repeat(43)}` })).toMatchObject({
			ok: false,
			err: "host key changed",
		});
		expect(ssh.execs).toEqual(["sudo -n shutdown -h now", "sudo -n shutdown -r now"]);
	});

	test("without TLS to the server: no ssh.power, no keys, and requests are refused", async () => {
		const { connection, hello } = await sshAgent({}, { sshRequiresTls: true });
		expect(hello.capabilities).not.toContain("ssh.power");
		expect(hello.ssh_keys).toBeUndefined();
		const check = await connection.request("SSH_CHECK", target());
		expect(check).toMatchObject({
			ok: false,
			err: "SSH needs an https:// server address (the agent connects without TLS)",
		});
		expect(ssh.connections).toBe(0);
	});

	test("without SSH keys (a config from before 1.0.0): no ssh.power, and the error says what to do", async () => {
		const { connection, hello } = await sshAgent({ ssh_keys: undefined });
		expect(hello.capabilities).not.toContain("ssh.power");
		const check = await connection.request("SSH_CHECK", target());
		expect(check.ok).toBe(false);
		expect(check.err).toContain("no SSH keys yet");
		expect(check.err).toContain("install");
		expect(ssh.connections).toBe(0);
	});

	test("outside Wake-on-LAN mode SSH requests are refused and nothing connects", async () => {
		const { connection, hello } = await sshAgent({ wol: { enabled: false } });
		expect(hello.capabilities).not.toContain("ssh.power");
		expect(hello.ssh_keys).toBeUndefined();

		const check = await connection.request("SSH_CHECK", target());
		const power = await connection.request(
			"SSH_POWER",
			target({ host_key: ssh.fingerprint, action: "shutdown", os: "posix", sudo: false }),
		);
		expect(check.ok).toBe(false);
		expect(check.err).toContain("Wake-on-LAN mode is off");
		expect(power.ok).toBe(false);
		expect(ssh.connections).toBe(0);
	});
});

describe("reconnecting", () => {
	test("reconnects after the server closes the connection", async () => {
		startAgent();
		const first = await server.waitForConnection(0);
		await first.hello();
		first.close(1001, "Server shutting down");

		const second = await server.waitForConnection(1);
		expect((await second.hello()).kind).toBe("linux");
	});

	test("silence makes the agent drop the connection and reconnect", async () => {
		startAgent({ client: { silenceTimeoutMs: 300 } });
		const first = await server.waitForConnection(0);
		await first.hello();

		// The fake server sends nothing, like a server that died without closing the socket.
		const second = await server.waitForConnection(1, 3000);
		await second.hello();
		await first.waitForClose(2000);
		expect(first.isClosed).toBe(true);
	});

	test("traffic from the server keeps the connection alive", async () => {
		startAgent({ client: { silenceTimeoutMs: 300 } });
		const connection = await server.waitForConnection(0);
		await connection.hello();

		for (let i = 0; i < 6; i++) {
			await Bun.sleep(100);
			expect((await connection.request("PING")).ok).toBe(true);
		}
		expect(server.connections).toHaveLength(1);
	});

	test("4000 (replaced) waits the longest backoff before reconnecting", async () => {
		startAgent();
		const first = await server.waitForConnection(0);
		await first.hello();

		const closedAt = Date.now();
		first.close(4000, "Replaced by a new connection");
		await server.waitForConnection(1, 3000);
		expect(Date.now() - closedAt).toBeGreaterThanOrEqual(FAST.reconnectMaxMs - 20);
	});

	test("an upgrade failure other than 401 is retried", async () => {
		server.failNextUpgrades(502, 2);
		startAgent();
		const connection = await server.waitForConnection(0, 3000);
		await connection.hello();
		expect(server.upgradeAttempts.map((attempt) => attempt.status)).toEqual([502, 502, 101]);
	});

	test("backoff doubles from the minimum up to the maximum", () => {
		const delays = [1, 2, 3, 4, 5, 6, 50].map((n) => AgentClient.backoffDelay(n, 5_000, 60_000));
		expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
		expect(AgentClient.RECONNECT_MIN_MS).toBe(5_000);
		expect(AgentClient.RECONNECT_MAX_MS).toBe(60_000);
		expect(AgentClient.SILENCE_TIMEOUT_MS).toBe(100_000);
	});
});

describe("giving up", () => {
	test("close code 4003 (credential revoked) stops the reconnect loop", async () => {
		const client = startAgent();
		const connection = await server.waitForConnection(0);
		await connection.hello();

		server.revoke(AGENT_ID);
		const result = await client.finished;
		expect(result).toMatchObject({ type: "rejected", reason: "revoked" });
		expect((await connection.waitForClose()).code).toBe(4003);
		await expectNoReconnect(FAST.reconnectMaxMs * 2);
	});

	test("close code 4004 (agent deleted) stops the reconnect loop", async () => {
		const client = startAgent();
		const connection = await server.waitForConnection(0);
		await connection.hello();

		server.deleteAgent(AGENT_ID);
		expect(await client.finished).toMatchObject({ type: "rejected", reason: "deleted" });
		await expectNoReconnect(FAST.reconnectMaxMs * 2);
	});

	test("HTTP 401 on the upgrade stops the reconnect loop", async () => {
		const client = RunCMD.createClient(configFor("unknown-token", "s".repeat(64)), {
			client: FAST,
		});
		clients.push(client);
		client.start();

		const result = await client.finished;
		expect(result).toMatchObject({ type: "rejected", reason: "unauthorized" });
		if (result.type === "rejected") expect(result.message).toContain("401");
		// The WebSocket attempt plus the probe that found out it was a 401.
		expect(server.upgradeAttempts.map((attempt) => attempt.status)).toEqual([401, 401]);
		await expectNoReconnect(FAST.reconnectMaxMs * 2);
	});

	test("4002 (unresponsive) is not fatal", async () => {
		const client = startAgent();
		const first = await server.waitForConnection(0);
		await first.hello();
		first.close(4002, "No answer to keep-alive");

		await (await server.waitForConnection(1)).hello();
		const finishedEarly = await Promise.race([
			client.finished.then(() => true),
			Bun.sleep(50).then(() => false),
		]);
		expect(finishedEarly).toBe(false);
	});
});

function hangingDeps(): StatusProbe.Deps {
	const never = () => new Promise<never>(() => {});
	return {
		ping: never,
		tcp: never,
		lookup: never,
		neighbors: async () => [],
		interfaces: () => ({}),
	};
}
