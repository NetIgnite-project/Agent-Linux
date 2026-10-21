import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InstallPlan } from "../src/install/installPlan";
import { PlanRunner } from "../src/install/planRunner";
import { SystemFiles } from "../src/install/systemFiles";
import { Logger } from "../src/utils/logger";
import { makeTempDir, removeTempDir } from "./helpers/cli";

Logger.setLogLevel("critical");

const FACTS: InstallPlan.Facts = {
	userExists: false,
	groupExists: false,
	nologinShell: "/usr/sbin/nologin",
};

const INSTALL: InstallPlan.InstallOptions = {
	binarySource: "/tmp/download/netignite-agent-linux-x64",
	binaryTarget: "/usr/local/bin/netignite-agent",
	configPath: "/etc/netignite/agent.json",
	user: "netignite",
	wol: false,
	facts: FACTS,
};

function lines(text: string) {
	return text.split("\n");
}

function runArgv(steps: InstallPlan.Step[]) {
	return steps.flatMap((step) => (step.type === "run" ? [step.argv.join(" ")] : []));
}

function written(steps: InstallPlan.Step[], path: string) {
	const step = steps.find((s) => s.type === "write" && s.path === path);
	return step?.type === "write" ? step : null;
}

describe("SystemFiles.unit", () => {
	const unit = SystemFiles.unit({
		binaryPath: "/usr/local/bin/netignite-agent",
		configPath: "/etc/netignite/agent.json",
		user: "netignite",
		wol: false,
	});

	test("runs the agent as the service user and always restarts it", () => {
		expect(lines(unit)).toEqual(
			expect.arrayContaining([
				"[Service]",
				"User=netignite",
				"Group=netignite",
				"ExecStart=/usr/local/bin/netignite-agent run --config /etc/netignite/agent.json",
				"Restart=always",
				"RestartSec=5",
				"WantedBy=multi-user.target",
				"After=network-online.target",
				"Wants=network-online.target",
			]),
		);
	});

	test("doesn't restart after the server rejected the credential", () => {
		expect(lines(unit)).toContain(`RestartPreventExitStatus=${SystemFiles.EXIT_CREDENTIAL_REJECTED}`);
		expect(SystemFiles.EXIT_CREDENTIAL_REJECTED).toBe(78);
	});

	test("is hardened", () => {
		expect(lines(unit)).toEqual(
			expect.arrayContaining([
				"NoNewPrivileges=yes",
				"ProtectSystem=strict",
				"ProtectHome=yes",
				"PrivateTmp=yes",
				"PrivateDevices=yes",
				"ReadOnlyPaths=/etc/netignite",
				"ProtectKernelTunables=yes",
				"ProtectKernelModules=yes",
				"ProtectControlGroups=yes",
				"RestrictNamespaces=yes",
				"RestrictSUIDSGID=yes",
				"LockPersonality=yes",
				"SystemCallArchitectures=native",
				"RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
			]),
		);
		// Bun's JIT needs writable + executable memory.
		expect(unit).not.toContain("MemoryDenyWriteExecute");
	});

	test("host mode has no capabilities, Wake-on-LAN mode only CAP_NET_RAW (ping)", () => {
		expect(lines(unit)).toContain("CapabilityBoundingSet=");
		expect(unit).not.toContain("AmbientCapabilities");

		const wolUnit = SystemFiles.unit({
			binaryPath: "/usr/local/bin/netignite-agent",
			configPath: "/etc/netignite/agent.json",
			user: "netignite",
			wol: true,
		});
		expect(lines(wolUnit)).toEqual(
			expect.arrayContaining(["CapabilityBoundingSet=CAP_NET_RAW", "AmbientCapabilities=CAP_NET_RAW"]),
		);
	});

	test("gets a runtime directory only its user can write to, for shutdown and reboot requests", () => {
		expect(lines(unit)).toEqual(
			expect.arrayContaining(["RuntimeDirectory=netignite-agent", "RuntimeDirectoryMode=0700"]),
		);
		expect(SystemFiles.RUNTIME_DIR).toBe("/run/netignite-agent");
	});

	test("refuses odd user names", () => {
		const base = {
			binaryPath: "/usr/local/bin/netignite-agent",
			configPath: "/etc/netignite/agent.json",
			wol: false,
		};
		expect(() => SystemFiles.unit({ ...base, user: "x\nExecStartPre=/bin/sh" })).toThrow(
			"Invalid user name",
		);
		expect(() => SystemFiles.unit({ ...base, user: "Root" })).toThrow("Invalid user name");
	});

	test("the config path can be read back from the unit", () => {
		expect(SystemFiles.unitConfigPath(unit)).toBe("/etc/netignite/agent.json");
		expect(SystemFiles.unitConfigPath("[Service]\nExecStart=/bin/true\n")).toBeNull();
	});

	test("refuses paths that would break the unit file or that the service can't see", () => {
		const base = { binaryPath: "/usr/local/bin/netignite-agent", user: "netignite", wol: false };
		for (const configPath of [
			"etc/agent.json",
			"/etc/net ignite/agent.json",
			"/etc/netignite/agent.json\nExecStartPre=/bin/sh",
			"/etc/../root/agent.json",
			"C:\\agent.json",
		]) {
			expect(() => SystemFiles.unit({ ...base, configPath })).toThrow("must be absolute");
		}
		for (const configPath of [
			"/home/linus/agent.json",
			"/root/agent.json",
			"/run/user/1000/a.json",
		]) {
			expect(() => SystemFiles.unit({ ...base, configPath })).toThrow("ProtectHome");
		}
	});
});

describe("SystemFiles power units", () => {
	test("a request file in the runtime directory starts the matching root unit", () => {
		expect(lines(SystemFiles.powerPathUnit("shutdown"))).toEqual(
			expect.arrayContaining([
				"[Path]",
				"PathExists=/run/netignite-agent/shutdown",
				"Unit=netignite-agent-shutdown.service",
				"WantedBy=multi-user.target",
			]),
		);
		expect(lines(SystemFiles.powerPathUnit("reboot"))).toEqual(
			expect.arrayContaining([
				"PathExists=/run/netignite-agent/reboot",
				"Unit=netignite-agent-reboot.service",
			]),
		);
		// Removing the file (or the directory, when the agent stops) must not trigger anything.
		expect(SystemFiles.powerPathUnit("shutdown")).not.toMatch(/^Path(Changed|Modified)=/m);
	});

	test("the root unit removes the request, then powers off or reboots, and does nothing else", () => {
		const execs = (action: "shutdown" | "reboot") =>
			lines(SystemFiles.powerServiceUnit(action)).filter((line) => line.startsWith("Exec"));
		expect(execs("shutdown")).toEqual([
			"ExecStart=rm -f /run/netignite-agent/shutdown",
			"ExecStart=systemctl --no-block poweroff",
		]);
		expect(execs("reboot")).toEqual([
			"ExecStart=rm -f /run/netignite-agent/reboot",
			"ExecStart=systemctl --no-block reboot",
		]);
		expect(lines(SystemFiles.powerServiceUnit("shutdown"))).toContain("Type=oneshot");
		expect(SystemFiles.powerServiceUnit("shutdown")).not.toContain("User=");
	});

	test("unit file paths", () => {
		expect(SystemFiles.powerUnitPaths()).toEqual([
			"/etc/systemd/system/netignite-agent-shutdown.path",
			"/etc/systemd/system/netignite-agent-shutdown.service",
			"/etc/systemd/system/netignite-agent-reboot.path",
			"/etc/systemd/system/netignite-agent-reboot.service",
		]);
	});
});

describe("InstallPlan.install", () => {
	test("creates the user, installs binary, config permissions and units, then starts", () => {
		const steps = InstallPlan.install(INSTALL);

		expect(runArgv(steps)).toEqual([
			"useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group netignite",
			"chown root:netignite /etc/netignite",
			"chmod 0750 /etc/netignite",
			"chown netignite:netignite /etc/netignite/agent.json",
			"chmod 0600 /etc/netignite/agent.json",
			"systemctl daemon-reload",
			"systemctl enable --now netignite-agent-shutdown.path netignite-agent-reboot.path",
			"systemctl enable netignite-agent",
			"systemctl restart netignite-agent",
		]);

		expect(steps).toContainEqual({
			type: "copy",
			from: INSTALL.binarySource,
			to: "/usr/local/bin/netignite-agent",
			mode: 0o755,
		});

		const unit = written(steps, "/etc/systemd/system/netignite-agent.service");
		expect(unit?.mode).toBe(0o644);
		expect(unit?.content).toContain("User=netignite");

		expect(written(steps, "/etc/systemd/system/netignite-agent-shutdown.path")?.content).toBe(
			SystemFiles.powerPathUnit("shutdown"),
		);
		expect(written(steps, "/etc/systemd/system/netignite-agent-reboot.service")?.content).toBe(
			SystemFiles.powerServiceUnit("reboot"),
		);
		for (const path of SystemFiles.powerUnitPaths()) expect(written(steps, path)?.mode).toBe(0o644);

		// polkit rules of earlier versions go away.
		const removed = steps.flatMap((s) => (s.type === "remove" ? [s.path] : []));
		expect(removed).toEqual([...SystemFiles.LEGACY_POLKIT_FILES]);
		expect(steps.some((s) => s.type === "write" && s.path.includes("polkit"))).toBe(false);

		// The unit is in place before systemd reloads and starts it.
		const unitIndex = steps.indexOf(unit as InstallPlan.Step);
		const startIndex = steps.findIndex((s) => s.type === "run" && s.argv.includes("restart"));
		expect(unitIndex).toBeLessThan(startIndex);
	});

	test("reuses an existing user and group and an installed binary", () => {
		const steps = InstallPlan.install({
			...INSTALL,
			binarySource: INSTALL.binaryTarget,
			facts: { ...FACTS, userExists: true, groupExists: true },
		});
		expect(runArgv(steps).some((argv) => argv.startsWith("useradd"))).toBe(false);
		expect(steps.some((s) => s.type === "copy")).toBe(false);

		const withGroup = InstallPlan.install({ ...INSTALL, facts: { ...FACTS, groupExists: true } });
		expect(runArgv(withGroup)[0]).toContain("--gid netignite netignite");
	});

	test("writes a Wake-on-LAN unit in Wake-on-LAN mode", () => {
		const steps = InstallPlan.install({ ...INSTALL, wol: true });
		expect(written(steps, SystemFiles.UNIT_PATH)?.content).toContain(
			"AmbientCapabilities=CAP_NET_RAW",
		);
	});
});

describe("InstallPlan.uninstall", () => {
	const options: InstallPlan.UninstallOptions = {
		binaryTarget: "/usr/local/bin/netignite-agent",
		configPath: "/etc/netignite/agent.json",
		user: "netignite",
		purge: false,
		facts: { userExists: true },
	};

	test("reverses install and keeps the config root-only", () => {
		const steps = InstallPlan.uninstall(options);
		expect(runArgv(steps)).toEqual([
			"systemctl disable --now netignite-agent",
			"systemctl disable --now netignite-agent-shutdown.path netignite-agent-reboot.path",
			"systemctl daemon-reload",
			"chown root:root /etc/netignite",
			"chmod 0700 /etc/netignite",
			"chown root:root /etc/netignite/agent.json",
			"chmod 0600 /etc/netignite/agent.json",
			"userdel netignite",
		]);
		const removed = steps.flatMap((s) => (s.type === "remove" ? [s.path] : []));
		expect(removed).toEqual([
			SystemFiles.UNIT_PATH,
			...SystemFiles.powerUnitPaths(),
			...SystemFiles.LEGACY_POLKIT_FILES,
			"/usr/local/bin/netignite-agent",
		]);
		expect(removed).not.toContain("/etc/netignite/agent.json");
	});

	test("--purge deletes the config too", () => {
		const steps = InstallPlan.uninstall({ ...options, purge: true, facts: { userExists: false } });
		expect(steps).toContainEqual({ type: "remove", path: "/etc/netignite/agent.json" });
		expect(steps).toContainEqual({ type: "rmdir", path: "/etc/netignite" });
		expect(runArgv(steps).some((argv) => argv.startsWith("userdel"))).toBe(false);
	});
});

describe("PlanRunner", () => {
	let dir: string;

	beforeAll(async () => {
		dir = await makeTempDir();
	});

	afterAll(async () => {
		await removeTempDir(dir);
	});

	test("a dry run changes nothing and runs no command", async () => {
		const source = join(dir, "source-binary");
		await writeFile(source, "binary");
		const marker = join(dir, "marker");
		await writeFile(marker, "keep me");

		const steps: InstallPlan.Step[] = [
			{ type: "run", argv: ["this-command-does-not-exist-netignite"] },
			{ type: "write", path: join(dir, "unit.service"), content: "x", mode: 0o644 },
			{ type: "copy", from: source, to: join(dir, "copied"), mode: 0o755 },
			{ type: "mkdir", path: join(dir, "new-dir"), mode: 0o755 },
			{ type: "remove", path: marker },
			{ type: "rmdir", path: dir },
		];
		await PlanRunner.run(steps, { dryRun: true });

		expect((await readdir(dir)).sort()).toEqual(["marker", "source-binary"]);
		expect(await readFile(marker, "utf8")).toBe("keep me");
	});

	test("the full install plan as a dry run touches nothing either", async () => {
		const before = await Promise.all(
			[
				SystemFiles.UNIT_PATH,
				"/etc/systemd/system/netignite-agent-shutdown.path",
				"/usr/local/bin/netignite-agent",
			].map((path) =>
				stat(path).then(
					() => true,
					() => false,
				),
			),
		);
		await PlanRunner.run(InstallPlan.install(INSTALL), { dryRun: true });
		const after = await Promise.all(
			[
				SystemFiles.UNIT_PATH,
				"/etc/systemd/system/netignite-agent-shutdown.path",
				"/usr/local/bin/netignite-agent",
			].map((path) =>
				stat(path).then(
					() => true,
					() => false,
				),
			),
		);
		expect(after).toEqual(before);
	});

	test("executes file steps", async () => {
		const source = join(dir, "exec-source");
		await writeFile(source, "binary v2");
		const target = join(dir, "exec-target");
		await writeFile(target, "binary v1");

		await PlanRunner.run(
			[
				{ type: "mkdir", path: join(dir, "exec-dir"), mode: 0o755 },
				{ type: "write", path: join(dir, "exec-dir", "file"), content: "content\n", mode: 0o644 },
				{ type: "copy", from: source, to: target, mode: 0o755 },
				{ type: "remove", path: join(dir, "missing-is-fine") },
				{ type: "rmdir", path: join(dir, "exec-dir") },
			],
			{ dryRun: false },
		);

		expect(await readFile(join(dir, "exec-dir", "file"), "utf8")).toBe("content\n");
		expect(await readFile(target, "utf8")).toBe("binary v2");
		expect((await readdir(dir)).some((name) => name.includes("netignite-tmp"))).toBe(false);
	});

	test("a failing command stops the plan unless it may fail", async () => {
		const path = join(dir, "after-failure");
		await expect(
			PlanRunner.run(
				[
					{ type: "run", argv: ["this-command-does-not-exist-netignite"] },
					{ type: "write", path, content: "x", mode: 0o644 },
				],
				{ dryRun: false },
			),
		).rejects.toThrow("Couldn't run this-command-does-not-exist-netignite");
		expect(
			await stat(path).then(
				() => true,
				() => false,
			),
		).toBe(false);

		await PlanRunner.run(
			[
				{ type: "run", argv: ["this-command-does-not-exist-netignite"], ignoreFailure: true },
				{ type: "write", path, content: "x", mode: 0o644 },
			],
			{ dryRun: false },
		);
		expect(await readFile(path, "utf8")).toBe("x");
	});
});
