import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstallPlan } from "../src/install/installPlan";
import { MacFiles } from "../src/install/macos/macFiles";
import { MacPlan } from "../src/install/macos/macPlan";
import type { WindowsFacts } from "../src/install/windows/windowsFacts";
import { WindowsFiles } from "../src/install/windows/windowsFiles";
import { WindowsPlan } from "../src/install/windows/windowsPlan";
import { WindowsPolicy } from "../src/install/windows/windowsPolicy";
import { makeTempDir, removeTempDir } from "./helpers/cli";

const runArgv = (steps: InstallPlan.Step[]) =>
	steps.flatMap((step) => (step.type === "run" ? [step.argv.join(" ")] : []));
const written = (steps: InstallPlan.Step[], path: string) => {
	const step = steps.find((s) => s.type === "write" && s.path === path);
	return step?.type === "write" ? step : null;
};

describe("Windows", () => {
	const options = {
		binaryPath: "C:\\Program Files\\NetIgnite\\netignite-agent.exe",
		configPath: "C:\\ProgramData\\NetIgnite\\agent.json",
	};

	test("the task runs at boot as LOCAL SERVICE, restarts, never times out", () => {
		const xml = WindowsFiles.taskXml(options);
		expect(xml).toContain("<UserId>S-1-5-19</UserId>");
		expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
		expect(xml).toContain("<BootTrigger>");
		expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
		expect(xml).toContain("<Count>999</Count>");
		expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
		expect(xml).toContain("<Command>C:\\Program Files\\NetIgnite\\netignite-agent.exe</Command>");
		expect(xml).toContain(
			"<Arguments>run --config &quot;C:\\ProgramData\\NetIgnite\\agent.json&quot; --log-file &quot;C:\\ProgramData\\NetIgnite\\logs\\agent.log&quot;</Arguments>",
		);
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
	});

	test("refuses paths that would break the task's command line", () => {
		for (const configPath of [
			'C:\\Net"Ignite\\agent.json',
			"agent.json",
			"\\\\server\\share\\agent.json",
		]) {
			expect(() => WindowsFiles.taskXml({ ...options, configPath })).toThrow("absolute Windows path");
		}
	});

	test("ACLs by SID: config for SYSTEM, Administrators and (read) LOCAL SERVICE, nothing inherited", () => {
		expect(WindowsFiles.configAcl("C:\\ProgramData\\NetIgnite")).toEqual([
			"icacls",
			"C:\\ProgramData\\NetIgnite",
			"/inheritance:r",
			"/grant:r",
			"*S-1-5-18:(OI)(CI)F",
			"*S-1-5-32-544:(OI)(CI)F",
			"*S-1-5-19:(OI)(CI)RX",
		]);
		expect(WindowsFiles.configAclAdminsOnly("C:\\x").join(" ")).not.toContain("S-1-5-19");
		expect(WindowsFiles.logAcl("C:\\x\\logs")).toEqual([
			"icacls",
			"C:\\x\\logs",
			"/grant:r",
			"*S-1-5-19:(OI)(CI)M",
		]);
	});

	test("shutdown.exe with fixed arguments", () => {
		const [exe, ...shutdown] = WindowsFiles.shutdownCommand("shutdown");
		expect(exe).toMatch(/\\System32\\shutdown\.exe$/i);
		expect(shutdown).toEqual(["/s", "/t", "0", "/d", "p:0:0"]);
		expect(WindowsFiles.shutdownCommand("reboot").slice(1)).toEqual(["/r", "/t", "0", "/d", "p:0:0"]);
	});

	test("install: stop, copy, ACLs, register the task (UTF-16), start", () => {
		const steps = WindowsPlan.install({
			binarySource: "C:\\Users\\me\\Downloads\\netignite-agent-windows-x64.exe",
			binaryTarget: options.binaryPath,
			configPath: options.configPath,
		});
		const commands = runArgv(steps);
		expect(commands[0]).toBe("schtasks /End /TN NetIgnite Agent");
		expect(commands).toContain(
			"schtasks /Create /TN NetIgnite Agent /XML C:\\ProgramData\\NetIgnite\\task.xml /F",
		);
		expect(commands.at(-1)).toBe("schtasks /Run /TN NetIgnite Agent");
		// The running agent is stopped before its binary is replaced.
		const copyIndex = steps.findIndex((s) => s.type === "copy");
		expect(copyIndex).toBeGreaterThan(steps.findIndex((s) => s.type === "run"));
		const task = written(steps, "C:\\ProgramData\\NetIgnite\\task.xml");
		expect(task?.encoding).toBe("utf16le-bom");
		expect(steps).toContainEqual({ type: "remove", path: "C:\\ProgramData\\NetIgnite\\task.xml" });
	});

	test("secedit INF: merge grants the shutdown right, split takes it back", () => {
		const INF = [
			"[Unicode]",
			"Unicode=yes",
			'[Version]\nsignature="$CHICAGO$"\n',
			"[Privilege Rights]",
			"SeShutdownPrivilege = *S-1-5-32-544,*S-1-5-32-551",
			"SeRemoteShutdownPrivilege = *S-1-5-32-544",
			"",
		].join("\n");
		const merged = WindowsPolicy.merge(INF);
		expect(merged).toContain("SeShutdownPrivilege = *S-1-5-32-544,*S-1-5-32-551,*S-1-5-19");
		// Only that one line changed.
		expect(merged!.split("\n").filter((l) => l.includes("*S-1-5-19")).length).toBe(1);

		// Already there: nothing to do. (Same without ours, which split returns null for too.)
		expect(WindowsPolicy.merge(merged!)).toBeNull();
		expect(WindowsPolicy.split(INF)).toBeNull();

		// split takes only our SID back and leaves the others.
		const split = WindowsPolicy.split(merged!);
		expect(split).toContain("SeShutdownPrivilege = *S-1-5-32-544,*S-1-5-32-551");
		expect(split!.replace(/S-1-5-(32-)?(544|551|19)/g, "")).not.toContain("519");

		// Without the section, or without the right in it: the line is added.
		const withoutSection = WindowsPolicy.merge('[Version]\nsignature="$CHICAGO$"\n');
		expect(withoutSection).toContain("[Privilege Rights]\r\nSeShutdownPrivilege = *S-1-5-19");
		const withoutRight = WindowsPolicy.merge(
			"[Privilege Rights]\nSeMachineAccountPrivilege = *S-1-5-32-550",
		);
		expect(withoutRight).toBe(
			"[Privilege Rights]\r\nSeShutdownPrivilege = *S-1-5-19\r\nSeMachineAccountPrivilege = *S-1-5-32-550",
		);

		// Our SID alone means the line goes away.
		const oursOnly = WindowsPolicy.split(
			"[Privilege Rights]\nSeShutdownPrivilege = *S-1-5-19\nSeRemoteShutdownPrivilege = *S-1-5-32-544",
		);
		expect(oursOnly).not.toContain("SeShutdownPrivilege");
		expect(oursOnly).toContain("SeRemoteShutdownPrivilege = *S-1-5-32-544");
	});

	test("secedit INF: reads UTF-16 and ASCII exports", () => {
		// secedit writes UTF-16 with BOM.
		const decoded = WindowsPolicy.decode(
			Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("[Privilege Rights]", "utf16le")]),
		);
		expect(decoded.encoding).toBe("utf16le-bom");
		expect(WindowsPolicy.merge(decoded.text)).toContain("*S-1-5-19");
		const ascii = WindowsPolicy.decode(Buffer.from("SeShutdownPrivilege ="));
		expect(ascii.encoding).toBeUndefined();
		expect(WindowsPolicy.merge(ascii.text)).toContain("SeShutdownPrivilege = *S-1-5-19");
	});

	test("install grants and uninstall takes back the shutdown right, when the policy was read", () => {
		const policy: WindowsFacts.Policy = {
			text: "[Privilege Rights]\nSeShutdownPrivilege = *S-1-5-32-544",
		};
		const plan = WindowsPlan.install({
			binarySource: options.binaryPath,
			binaryTarget: options.binaryPath,
			configPath: options.configPath,
			policy,
		});
		const exports = runArgv(plan).filter((command) => command.startsWith("secedit /export"));
		expect(exports).toHaveLength(1);
		const inf = exports[0]?.split(" ").at(-1) ?? "";
		expect(inf).toContain("netignite-secedit-");
		const write = plan.find((s) => s.type === "write" && s.path === inf);
		expect(write?.type === "write" ? write.content : null).toBe(
			"[Privilege Rights]\r\nSeShutdownPrivilege = *S-1-5-32-544,*S-1-5-19",
		);
		expect(runArgv(plan)).toContain(
			`secedit /configure /db ${inf.replace(/\.inf$/, ".sdb")} /cfg ${inf} /quiet`,
		);

		const takenBack = WindowsPlan.uninstall({
			binaryTarget: options.binaryPath,
			configPath: options.configPath,
			purge: false,
			// What install left: our SID is in the right.
			policy: {
				text:
					"[Privilege Rights]" +
					String.fromCharCode(10) +
					"SeShutdownPrivilege = *S-1-5-32-544,*S-1-5-19",
			},
		});
		const exportLines = runArgv(takenBack).filter((command) => command.startsWith("secedit /export"));
		const unInf = exportLines[0]?.split(" ").at(-1) ?? "";
		const unWrite = takenBack.find((s) => s.type === "write" && s.path === unInf);
		expect(unWrite?.type === "write" ? unWrite.content : null).toBe(
			"[Privilege Rights]\r\nSeShutdownPrivilege = *S-1-5-32-544",
		);

		// Without the exported policy (a non-admin --dry-run), the right isn't touched.
		const noPolicy = WindowsPlan.install({
			binarySource: options.binaryPath,
			binaryTarget: options.binaryPath,
			configPath: options.configPath,
		});
		expect(runArgv(noPolicy).join("\n")).not.toContain("secedit");
	});

	test("uninstall keeps the config for administrators only, --purge deletes it", () => {
		const kept = WindowsPlan.uninstall({
			binaryTarget: options.binaryPath,
			configPath: options.configPath,
			purge: false,
		});
		expect(runArgv(kept)).toContain("schtasks /Delete /TN NetIgnite Agent /F");
		expect(runArgv(kept).at(-1)).toContain("/inheritance:r");
		expect(kept).not.toContainEqual({ type: "remove", path: options.configPath });
		const purged = WindowsPlan.uninstall({
			binaryTarget: options.binaryPath,
			configPath: options.configPath,
			purge: true,
		});
		expect(purged).toContainEqual({ type: "remove", path: options.configPath });
	});
});

describe("macOS", () => {
	const options = {
		binaryPath: "/usr/local/bin/netignite-agent",
		configPath: "/usr/local/etc/netignite/agent.json",
	};

	test("the agent's daemon runs as _netignite and logs to its own file", () => {
		const plist = MacFiles.agentPlist(options);
		expect(plist).toContain("<key>UserName</key>\n\t<string>_netignite</string>");
		expect(plist).toContain("<key>Label</key>\n\t<string>dev.netignite.agent</string>");
		expect(plist).toContain(
			[
				"<array>",
				"\t\t<string>/usr/local/bin/netignite-agent</string>",
				"\t\t<string>run</string>",
				"\t\t<string>--config</string>",
				"\t\t<string>/usr/local/etc/netignite/agent.json</string>",
				"\t\t<string>--log-file</string>",
				"\t\t<string>/usr/local/var/log/netignite-agent/agent.log</string>",
				"\t</array>",
			].join("\n"),
		);
		expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
		expect(() =>
			MacFiles.agentPlist({ ...options, configPath: "/Library/Application Support/agent.json" }),
		).toThrow("must be absolute");
	});

	test("one root daemon per action, started when its request directory fills", () => {
		const plist = MacFiles.powerPlist("reboot");
		expect(plist).toContain("<string>dev.netignite.agent.reboot</string>");
		expect(plist).toContain(
			"<key>QueueDirectories</key>\n\t<array>\n\t\t<string>/usr/local/var/netignite-agent/reboot</string>",
		);
		expect(plist).not.toContain("UserName");
		expect(MacFiles.powerScript("reboot")).toContain("exec /sbin/shutdown -r now");
		expect(MacFiles.powerScript("shutdown")).toContain("exec /sbin/shutdown -h now");
		expect(MacFiles.powerScript("shutdown")).not.toContain("cat ");
	});

	test("install creates the user with a free id, owns the request directories, loads the daemons", () => {
		const steps = MacPlan.install({
			binarySource: "/tmp/netignite-agent-macos-arm64",
			binaryTarget: options.binaryPath,
			configPath: options.configPath,
			facts: { userId: null, groupId: null, freeId: 401 },
		});
		const commands = runArgv(steps);
		expect(commands).toContain("dscl . -create /Users/_netignite UniqueID 401");
		expect(commands).toContain("dscl . -create /Groups/_netignite PrimaryGroupID 401");
		expect(commands).toContain("dscl . -create /Users/_netignite UserShell /usr/bin/false");
		expect(commands).toContain("chown 401:401 /usr/local/var/netignite-agent/shutdown");
		expect(commands).toContain("chown 401:401 /usr/local/etc/netignite/agent.json");
		// The root daemons are loaded before the agent, so its first request is picked up.
		const bootstraps = commands.filter((c) => c.startsWith("launchctl bootstrap"));
		expect(bootstraps.at(-1)).toBe(
			"launchctl bootstrap system /Library/LaunchDaemons/dev.netignite.agent.plist",
		);
		expect(bootstraps).toHaveLength(3);

		const existing = MacPlan.install({
			binarySource: options.binaryPath,
			binaryTarget: options.binaryPath,
			configPath: options.configPath,
			facts: { userId: 402, groupId: 403, freeId: 404 },
		});
		expect(runArgv(existing).some((c) => c.startsWith("dscl"))).toBe(false);
		expect(runArgv(existing)).toContain("chown 402:403 /usr/local/etc/netignite/agent.json");
	});

	test("uninstall unloads everything, removes the user, keeps the config root-only", () => {
		const steps = MacPlan.uninstall({
			binaryTarget: options.binaryPath,
			configPath: options.configPath,
			purge: false,
			facts: { userId: 401, groupId: 401 },
		});
		const commands = runArgv(steps);
		expect(commands.filter((c) => c.startsWith("launchctl bootout"))).toHaveLength(3);
		expect(commands).toContain("dscl . -delete /Users/_netignite");
		expect(commands).toContain("chown 0:0 /usr/local/etc/netignite/agent.json");
	});

	test("freeId skips the ids users and groups have", () => {
		const users = "root 0\n_spotlight 89\n_netignite 400\nlinus 501";
		const groups = "wheel 0\nadmin 80\nsomething 401";
		expect(MacPlan.freeId(users, groups)).toBe(402);
		expect(MacPlan.freeId("", "")).toBe(400);
	});
});

describe("macOS power script", () => {
	const sh = Bun.which("sh");
	let dir: string;

	beforeAll(async () => {
		dir = await makeTempDir();
	});
	afterAll(async () => {
		await removeTempDir(dir);
	});

	/** Runs the root daemon's script with a fake shutdown that records its arguments. */
	function runScript(name: string, setup: (requests: string) => void) {
		const requests = join(dir, name);
		mkdirSync(requests);
		setup(requests);
		const marker = join(dir, `${name}.called`);
		const fakeShutdown = join(dir, `${name}-shutdown.sh`);
		writeFileSync(fakeShutdown, `#!/bin/sh\necho "$@" > "${marker.replaceAll("\\", "/")}"\n`, {
			mode: 0o755,
		});
		const script = MacFiles.powerScript("shutdown", {
			dir: requests.replaceAll("\\", "/"),
			shutdown: `sh "${fakeShutdown.replaceAll("\\", "/")}"`,
		});
		const result = Bun.spawnSync([sh as string, "-c", script]);
		return {
			exitCode: result.exitCode,
			called: existsSync(marker) ? (Bun.file(marker).size > 0 ? "yes" : "empty") : "no",
			left: readdirSync(requests),
		};
	}

	test.skipIf(!sh)("a fresh request shuts down and empties the directory", () => {
		const result = runScript("fresh", (requests) => writeFileSync(join(requests, "request"), "x"));
		expect(result).toEqual({ exitCode: 0, called: "yes", left: [] });
	});

	test.skipIf(!sh)("an old request (power cut) is only removed", () => {
		const result = runScript("old", (requests) => {
			const file = join(requests, "request");
			writeFileSync(file, "x");
			const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
			utimesSync(file, tenMinutesAgo, tenMinutesAgo);
		});
		expect(result).toEqual({ exitCode: 0, called: "no", left: [] });
	});

	test.skipIf(!sh)("anything else in the directory is removed and doesn't count", () => {
		const result = runScript("other", (requests) => {
			writeFileSync(join(requests, "something"), "x");
			writeFileSync(join(requests, ".hidden"), "x");
			mkdirSync(join(requests, "sub"));
			writeFileSync(join(requests, "sub", "file"), "x");
		});
		expect(result).toEqual({ exitCode: 0, called: "no", left: [] });
	});
});
