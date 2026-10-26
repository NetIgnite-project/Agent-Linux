import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentConfig } from "../src/config/agentConfig";
import { SystemFiles } from "../src/install/systemFiles";
import { AppConstants } from "../src/utils/constants";
import { Platform } from "../src/utils/platform";
import { finishCLI, makeTempDir, removeTempDir, runCLI, spawnCLI } from "./helpers/cli";
import { FakeNetIgniteServer } from "./helpers/fake-server";

/**
 * The CLI as a separate process (`bun src/index.ts …`) against the fake server: argument
 * handling, exit codes and output, end to end. HOST_CONTROL is never sent here, because the
 * process would run the real systemctl.
 */

const posixOnly = test.skipIf(process.platform === "win32");
const linuxOnly = test.skipIf(process.platform !== "linux");
const windowsOnly = test.skipIf(process.platform !== "win32");

let server: FakeNetIgniteServer;
let dir: string;

beforeAll(async () => {
	// Upper case in the base path: the CLI must keep it (@cleverjs/cli lower-cases by default).
	server = new FakeNetIgniteServer("/NetIgnite").start();
	dir = await makeTempDir();
});

afterAll(async () => {
	await server.stop();
	await removeTempDir(dir);
});

function configPath(name: string) {
	return join(dir, name, "agent.json");
}

async function exists(path: string) {
	return await stat(path).then(
		() => true,
		() => false,
	);
}

async function pairNew(name: string, agentID: number, extra: string[] = []) {
	const token = server.addEnrollment(agentID);
	const path = configPath(name);
	const result = await runCLI(["pair", server.url, token, "--config", path, ...extra]);
	return { token, path, result };
}

describe("pair", () => {
	test("enrolls with a generated secret and stores the config", async () => {
		const { token, path, result } = await pairNew("pair-ok", 12);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Paired as agent 12");

		const config = await AgentConfig.load(path);
		const request = server.enrollRequests.find((r) => r.enrollment_token === token);
		expect(config.server).toBe(server.url);
		expect(config.agent_id).toBe(12);
		expect(config.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(config.secret).toBe(request?.secret as string);
		expect(config.wol.enabled).toBe(false);

		// Neither the secret nor the enrollment token is printed.
		expect(result.output).not.toContain(config.secret);
		expect(result.output).not.toContain(token.split(":")[1] as string);
		expect(result.output).not.toContain(config.token_id);
	});

	posixOnly("the config is written with mode 0600", async () => {
		const { path } = await pairNew("pair-mode", 13);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	linuxOnly("creates the agent's SSH keys, and pairing again keeps them", async () => {
		const { path } = await pairNew("pair-keys", 16);
		const first = await AgentConfig.load(path);
		expect(first.ssh_keys).toBeDefined();
		expect(first.ssh_keys?.shutdown).not.toBe(first.ssh_keys?.reboot);

		const token = server.addEnrollment(17);
		expect((await runCLI(["pair", server.url, token, "--config", path])).exitCode).toBe(0);
		const second = await AgentConfig.load(path);
		expect(second.agent_id).toBe(17);
		// Devices that allow the keys keep working after pairing again.
		expect(second.ssh_keys).toEqual(first.ssh_keys);
	});

	// The keys exist for Wake-on-LAN mode's SSH logins, which need Linux.
	test.skipIf(process.platform === "linux")(
		"no SSH keys where Wake-on-LAN mode can't run",
		async () => {
			const { path } = await pairNew("pair-keys-elsewhere", 18);
			expect((await AgentConfig.load(path)).ssh_keys).toBeUndefined();
		},
	);

	linuxOnly("--wol turns on Wake-on-LAN mode", async () => {
		const { path, result } = await pairNew("pair-wol", 14, ["--wol"]);
		expect(result.exitCode).toBe(0);
		expect((await AgentConfig.load(path)).wol.enabled).toBe(true);
	});

	// The config says what the machine runs, not what was asked for.
	test.skipIf(process.platform === "linux")(
		"--wol stays off where Wake-on-LAN mode can't run",
		async () => {
			const { path, result } = await pairNew("pair-wol-elsewhere", 19, ["--wol"]);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Wake-on-LAN mode needs Linux");
			expect((await AgentConfig.load(path)).wol.enabled).toBe(false);
		},
	);

	test("an ESP32 token fails clearly and writes nothing", async () => {
		const token = server.addEnrollment(15, "esp32");
		const path = configPath("pair-esp32");
		const result = await runCLI(["pair", server.url, token, "--config", path]);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("ESP32 agent");
		expect(await exists(path)).toBe(false);
	});

	test("a used token is rejected", async () => {
		const { token } = await pairNew("pair-first", 16);
		const result = await runCLI(["pair", server.url, token, "--config", configPath("pair-again")]);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("already used or expired");
	});

	test("something that isn't a token is refused before contacting the server", async () => {
		const before = server.enrollRequests.length;
		const result = await runCLI([
			"pair",
			server.url,
			"netignite_agent_abc:def",
			"--config",
			configPath("pair-bad"),
		]);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("doesn't look like an enrollment token");
		expect(server.enrollRequests.length).toBe(before);
	});

	test("an invalid server URL is refused", async () => {
		const token = server.addEnrollment(17);
		const result = await runCLI([
			"pair",
			"https://user:pw@example.com",
			token,
			"--config",
			configPath("pair-url"),
		]);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("user name or password");
		expect(result.output).not.toContain(token.split(":")[1] as string);
	});
});

describe("run", () => {
	test("connects, says HELLO and answers PING; exits 78 when the credential is revoked", async () => {
		const { path } = await pairNew("run-revoke", 20);
		const child = spawnCLI(["run", "--config", path]);
		try {
			const connection = await server.waitForConnection(server.connections.length);
			const hello = await connection.hello();
			expect(hello.kind).toBe(AppConstants.AGENT_KIND);
			expect(hello.capabilities).toEqual(["host.status", "host.control"]);
			expect(await connection.request("PING")).toMatchObject({ ok: true, p: {} });

			server.revoke(20);
			const result = await finishCLI(child);
			expect(result.exitCode).toBe(SystemFiles.EXIT_CREDENTIAL_REJECTED);
			expect(result.output).toContain("revoked");
			expect(result.output).toContain("pair");
			expect(result.output).not.toContain((await AgentConfig.load(path)).secret);
		} finally {
			child.kill();
		}
	});

	test("exits 78 when the server answers 401 on the upgrade", async () => {
		const path = configPath("run-401");
		await AgentConfig.save(path, {
			server: server.url,
			agent_id: 21,
			token_id: "unknown",
			secret: "a".repeat(64),
			wol: { enabled: false },
		});
		const child = spawnCLI(["run", "--config", path]);
		const timer = setTimeout(() => child.kill(), 15_000);
		const result = await finishCLI(child);
		clearTimeout(timer);
		expect(result.exitCode).toBe(SystemFiles.EXIT_CREDENTIAL_REJECTED);
		expect(result.output).toContain("401");
	});

	linuxOnly("--wol turns on Wake-on-LAN mode for the run", async () => {
		const { path } = await pairNew("run-wol", 22);
		const child = spawnCLI(["run", "--wol", "--config", path]);
		try {
			const connection = await server.waitForConnection(server.connections.length);
			expect((await connection.hello()).capabilities).toContain("wake");
		} finally {
			child.kill();
			await child.exited;
		}
	});

	posixOnly("stops cleanly on SIGTERM", async () => {
		const { path } = await pairNew("run-sigterm", 23);
		const child = spawnCLI(["run", "--config", path]);
		const connection = await server.waitForConnection(server.connections.length);
		await connection.hello();

		child.kill("SIGTERM");
		const result = await finishCLI(child);
		expect(result.exitCode).toBe(0);
		expect((await connection.waitForClose()).code).toBe(1000);
	});

	test("without a config it explains how to pair", async () => {
		const result = await runCLI(["run", "--config", configPath("run-missing")]);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("Pair the agent first");
	});
});

describe("other commands", () => {
	test("status shows the pairing and checks the server, without the secret", async () => {
		const { path } = await pairNew("status", 30);
		const config = await AgentConfig.load(path);

		const result = await runCLI(["status", "--config", path]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain(`Server:       ${server.url}`);
		expect(result.output).toContain("Agent:        30");
		expect(result.output).toContain("Wake-on-LAN:  off");
		expect(result.output).toContain("Server check: reachable");
		expect(result.output).toContain("Service:");
		expect(result.output).not.toContain(config.secret);
		expect(result.output).not.toContain(config.token_id);
		expect(result.output).toContain("Credential:   accepted");
	});

	test("status tells a revoked credential apart", async () => {
		const { path } = await pairNew("status-revoked", 32);
		server.revoke(32);
		const result = await runCLI(["status", "--config", path]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Credential:   rejected (HTTP 401)");
	});

	test("status without a config fails", async () => {
		const result = await runCLI(["status", "--config", configPath("status-missing")]);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("Pair the agent first");
	});

	test("version", async () => {
		const result = await runCLI(["version"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("NetIgnite Agent");
	});

	test("the global --log-level flag goes before the command", async () => {
		const quiet = await runCLI(["--log-level", "error", "version"]);
		expect(quiet.exitCode).toBe(0);
		expect(quiet.stdout).not.toContain("NetIgnite Agent");

		const invalid = await runCLI(["--log-level", "loud", "version"]);
		expect(invalid.exitCode).toBe(1);
	});

	linuxOnly("install --dry-run prints the systemd plan and changes nothing", async () => {
		const watched = [
			SystemFiles.UNIT_PATH,
			...SystemFiles.powerUnitPaths(),
			"/usr/local/bin/netignite-agent",
		];
		const before = await Promise.all(watched.map(exists));

		const result = await runCLI(["install", "--dry-run"]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Dry run, nothing is changed");
		expect(result.output).toContain("useradd --system");
		expect(result.output).toContain(`write  ${SystemFiles.UNIT_PATH}`);
		expect(result.output).toContain("| User=netignite");
		expect(result.output).toContain(`write  ${SystemFiles.powerUnitPaths()[0]}`);
		expect(result.output).toContain("| PathExists=/run/netignite-agent/shutdown");
		expect(result.output).toContain("| ExecStart=systemctl --no-block poweroff");
		expect(result.output).toContain("systemctl enable netignite-agent");
		expect(await Promise.all(watched.map(exists))).toEqual(before);
	});

	windowsOnly("install --dry-run prints the Task Scheduler plan and changes nothing", async () => {
		const { path } = await pairNew("install-windows", 41);
		const result = await runCLI(["install", "--dry-run", "--config", path]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Dry run, nothing is changed");
		expect(result.output).toContain("icacls");
		expect(result.output).toContain("*S-1-5-19:(OI)(CI)RX");
		expect(result.output).toContain("schtasks /Create /TN NetIgnite Agent /XML");
		expect(result.output).toContain("<UserId>S-1-5-19</UserId>");
		expect(result.output).toContain("<BootTrigger>");
		expect(await exists(join(dirname(path), "task.xml"))).toBe(false);
	});

	linuxOnly("uninstall --purge --dry-run prints the systemd plan", async () => {
		const result = await runCLI(["uninstall", "--purge", "--dry-run"]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("systemctl disable --now netignite-agent");
		expect(result.output).toContain("remove /etc/netignite/agent.json");
	});

	windowsOnly("uninstall --purge --dry-run prints the Task Scheduler plan", async () => {
		const result = await runCLI(["uninstall", "--purge", "--dry-run"]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("schtasks /Delete /TN NetIgnite Agent /F");
		expect(result.output).toContain(`remove ${AppConstants.DEFAULT_CONFIG_PATH}`);
	});

	test("install without --dry-run needs root or an administrator", async () => {
		// Root, or an elevated Windows prompt (like GitHub's Windows runners), gets past the check.
		if (process.getuid?.() === 0 || Platform.isAdmin()) return;
		const result = await runCLI(["install"]);
		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(/must run as root|must run as an administrator/);
	});

	test("wol-mode on is refused where Wake-on-LAN mode can't run", async () => {
		if (process.platform === "linux") return;
		const { path } = await pairNew("wol-mode-elsewhere", 33);
		const result = await runCLI(["wol-mode", "on", "--config", path]);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("needs Linux");
		expect((await AgentConfig.load(path)).wol.enabled).toBe(false);
	});

	linuxOnly("wol-mode on adds SSH keys to a config from 1.0.0 or older", async () => {
		const { path } = await pairNew("wol-mode-keys", 32);
		const { ssh_keys: _, ...old } = JSON.parse(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify(old));
		expect((await runCLI(["wol-mode", "on", "--config", path])).exitCode).toBe(0);
		const config = await AgentConfig.load(path);
		expect(config.wol.enabled).toBe(true);
		expect(config.ssh_keys).toBeDefined();
	});

	linuxOnly("wol-mode switches Wake-on-LAN mode in the config", async () => {
		const { path } = await pairNew("wol-mode", 31);
		expect((await runCLI(["wol-mode", "on", "--config", path])).exitCode).toBe(0);
		expect((await AgentConfig.load(path)).wol.enabled).toBe(true);
		expect((await runCLI(["wol-mode", "off", "--config", path])).exitCode).toBe(0);
		expect(JSON.parse(await readFile(path, "utf8")).wol).toEqual({ enabled: false });
	});

	test("wol refuses an invalid MAC address", async () => {
		const result = await runCLI(["wol", "not-a-mac"]);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("is not a MAC address");
	});
});
