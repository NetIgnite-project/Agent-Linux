/**
 * End-to-end check of `install` on a real machine: pairs the compiled agent with a fake server,
 * installs the service (systemd, launchd or the Windows task), checks that it connects, that a
 * shutdown or reboot request reaches the part that would do it, and that `uninstall` cleans up.
 * Nothing is powered off: Linux and macOS get a fake `shutdown` for the test, Windows only checks
 * that LOCAL SERVICE may shut down.
 *
 * It changes the system (user, service, files): run it on a throwaway machine such as a CI runner,
 * as root (`sudo`) or an elevated administrator.
 *
 *   bun tests/e2e/service-check.ts <compiled agent binary>
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MacFiles } from "../../src/install/macos/macFiles";
import { SystemFiles } from "../../src/install/systemFiles";
import { WindowsFiles } from "../../src/install/windows/windowsFiles";
import { AppConstants } from "../../src/utils/constants";
import { Platform } from "../../src/utils/platform";
import { FakeNetIgniteServer } from "../helpers/fake-server";

const binary = process.argv[2];
if (!binary) {
	console.error("Usage: bun tests/e2e/service-check.ts <compiled agent binary>");
	process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
	const suffix =
		ok || detail === undefined
			? ""
			: `\n      -> ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${suffix}`);
	if (!ok) failures++;
}

/** Runs a command without blocking the fake server in this process. */
async function run(argv: string[]) {
	const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, out: stdout + stderr };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await Bun.sleep(200);
	}
	return await predicate();
}

const fake = new FakeNetIgniteServer("/netignite").start();
const agentID = 9;

// --- pair and install ------------------------------------------------------------------------
const pair = await run([binary, "pair", fake.url, fake.addEnrollment(agentID)]);
check("pair", pair.code === 0, pair.out);

// Linux: the root units run a fake `systemctl poweroff|reboot` for this test.
const linuxMarker = (action: string) => `/run/netignite-e2e-${action}`;
if (Platform.isLinux()) {
	for (const action of SystemFiles.actions()) {
		const dropin = `/etc/systemd/system/${SystemFiles.powerUnitName(action)}.service.d`;
		mkdirSync(dropin, { recursive: true });
		writeFileSync(
			`${dropin}/zz-e2e.conf`,
			`[Service]\nExecStart=\nExecStart=rm -f ${SystemFiles.requestPath(action)}\nExecStart=touch ${linuxMarker(action)}\n`,
		);
	}
}

const install = await run([binary, "install"]);
check("install", install.code === 0, install.out);

const connection = await fake.waitForConnection(0, 30_000).catch(() => null);
check("the service connected to the server", connection !== null);
if (connection) {
	const hello = await connection.hello();
	check(`HELLO as kind ${AppConstants.AGENT_KIND}`, hello.kind === AppConstants.AGENT_KIND, hello);
	check(
		"it offers shutdown and reboot",
		hello.capabilities.includes("host.control"),
		hello.capabilities,
	);
}

const status = await run([binary, "status"]);
check(
	"status shows the running service",
	/Service:\s+(active|running|Running)/.test(status.out),
	status.out,
);

// --- shutdown and reboot, without powering off ------------------------------------------------
if (Platform.isLinux() && connection) {
	const answer = await connection.request("HOST_CONTROL", { action: "reboot" }, 15_000);
	check("HOST_CONTROL reboot accepted", answer.ok === true, answer);
	check("the root unit ran", await waitFor(() => existsSync(linuxMarker("reboot")), 10_000));
}

if (Platform.isMac() && connection) {
	// The real shutdown daemon drops a stale request (a power cut right after it) without acting.
	const stale = MacFiles.requestPath("shutdown");
	writeFileSync(stale, "x");
	const old = new Date(Date.now() - 10 * 60_000);
	utimesSync(stale, old, old);
	check(
		"the shutdown daemon removes a stale request and does nothing else",
		await waitFor(() => readdirSync(MacFiles.requestDir("shutdown")).length === 0, 20_000),
	);

	// The reboot daemon with a fake shutdown, for a fresh request through the agent.
	const marker = "/tmp/netignite-e2e-reboot";
	const fakeShutdown = "/tmp/netignite-e2e-shutdown.sh";
	writeFileSync(fakeShutdown, `#!/bin/sh\necho "$@" > ${marker}\n`, { mode: 0o755 });
	const label = MacFiles.powerLabel("reboot");
	const plistPath = MacFiles.plistPath(label);
	const realPlist = readFileSync(plistPath, "utf8");
	await run(["launchctl", "bootout", `system/${label}`]);
	writeFileSync(
		plistPath,
		realPlist.replace(
			MacFiles.powerScript("reboot")
				.replaceAll("&", "&amp;")
				.replaceAll("<", "&lt;")
				.replaceAll(">", "&gt;"),
			MacFiles.powerScript("reboot", {
				dir: MacFiles.requestDir("reboot"),
				shutdown: `/bin/sh ${fakeShutdown}`,
			})
				.replaceAll("&", "&amp;")
				.replaceAll("<", "&lt;")
				.replaceAll(">", "&gt;"),
		),
	);
	await run(["launchctl", "bootstrap", "system", plistPath]);
	const answer = await connection.request("HOST_CONTROL", { action: "reboot" }, 15_000);
	check("HOST_CONTROL reboot accepted", answer.ok === true, answer);
	check(
		"the reboot daemon ran (fake shutdown -r now)",
		await waitFor(
			() => existsSync(marker) && readFileSync(marker, "utf8").trim() === "-r now",
			20_000,
		),
		existsSync(marker) ? readFileSync(marker, "utf8") : "no marker",
	);
	rmSync(marker, { force: true });
	rmSync(fakeShutdown, { force: true });
}

if (Platform.isWindows()) {
	// The agent runs shutdown.exe as LOCAL SERVICE: check that the account holds the privilege.
	const logDir = WindowsFiles.logDir(AppConstants.DEFAULT_CONFIG_PATH);
	const output = join(logDir, "privileges.txt");
	const xml = WindowsFiles.taskXml({
		binaryPath: "C:\\Windows\\System32\\cmd.exe",
		configPath: AppConstants.DEFAULT_CONFIG_PATH,
	})
		.replace(
			/<BootTrigger>[\s\S]*?<\/BootTrigger>/,
			"<TimeTrigger><StartBoundary>2099-01-01T00:00:00</StartBoundary></TimeTrigger>",
		)
		.replace(
			/<Arguments>[\s\S]*?<\/Arguments>/,
			`<Arguments>/c whoami /priv /fo csv &gt; "${output}"</Arguments>`,
		);
	const xmlFile = join(logDir, "e2e-task.xml");
	writeFileSync(xmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
	const task = "NetIgnite e2e privileges";
	await run(["schtasks", "/Create", "/TN", task, "/XML", xmlFile, "/F"]);
	await run(["schtasks", "/Run", "/TN", task]);
	check(
		"LOCAL SERVICE holds SeShutdownPrivilege",
		// cmd's redirect writes the console code page; the privilege names are ASCII either way.
		await waitFor(
			() => existsSync(output) && readFileSync(output, "latin1").includes("SeShutdownPrivilege"),
			20_000,
		),
		existsSync(output) ? readFileSync(output).toString() : "no output",
	);
	await run(["schtasks", "/Delete", "/TN", task, "/F"]);
	rmSync(xmlFile, { force: true });
	rmSync(output, { force: true });
}

// --- uninstall -----------------------------------------------------------------------------------
const uninstall = await run([binary, "uninstall", "--purge"]);
check("uninstall --purge", uninstall.code === 0, uninstall.out);
check("the config is gone", !existsSync(AppConstants.DEFAULT_CONFIG_PATH));
if (Platform.isLinux()) {
	const left = [SystemFiles.UNIT_PATH, ...SystemFiles.powerUnitPaths()].filter((path) =>
		existsSync(path),
	);
	check("the units are gone", left.length === 0, left);
	for (const action of SystemFiles.actions()) {
		rmSync(`/etc/systemd/system/${SystemFiles.powerUnitName(action)}.service.d`, {
			recursive: true,
			force: true,
		});
		rmSync(linuxMarker(action), { force: true });
	}
	await run(["systemctl", "daemon-reload"]);
}
if (Platform.isMac()) {
	const left = MacFiles.labels()
		.map((label) => MacFiles.plistPath(label))
		.filter((path) => existsSync(path));
	check("the daemons are gone", left.length === 0, left);
	check(
		"the user is gone",
		(await run(["dscl", ".", "-read", `/Users/${MacFiles.SERVICE_USER}`])).code !== 0,
	);
}
if (Platform.isWindows()) {
	check(
		"the task is gone",
		(await run(["schtasks", "/Query", "/TN", WindowsFiles.TASK_NAME])).code !== 0,
	);
}

await fake.stop();
console.log(failures === 0 ? "\nALL SERVICE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
