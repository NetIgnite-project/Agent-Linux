import { rm, stat, writeFile } from "node:fs/promises";
import { MacFiles } from "../install/macos/macFiles";
import { SystemFiles } from "../install/systemFiles";
import { WindowsFiles } from "../install/windows/windowsFiles";
import { AppConstants } from "../utils/constants";
import { Logger } from "../utils/logger";
import { Platform } from "../utils/platform";

/**
 * Shutting down and rebooting the machine the agent runs on. Only these two fixed actions exist;
 * nothing the server sends ends up on a command line.
 *
 * - **Linux**: the agent has no right to do either. It asks by creating a file in its runtime
 *   directory (`/run/netignite-agent`, writable only by the service user); a `.path` unit that
 *   `install` sets up sees the file and starts a root unit that runs `systemctl poweroff|reboot`.
 * - **macOS**: the same with launchd: a file in `/usr/local/var/netignite-agent/<action>/`, and a
 *   root daemon (`QueueDirectories`) that runs `/sbin/shutdown -h|-r now`.
 * - **Windows**: the agent runs as LOCAL SERVICE, which may shut down, and runs `shutdown.exe`
 *   with fixed arguments itself.
 */
export class HostControl {
	/** Time between answering the request and acting, so the answer reaches the server. */
	static readonly DELAY_MS = 1000;
	/** How long the `.path` unit gets to pick a request up before it counts as failed. */
	static readonly PICKUP_TIMEOUT_MS = 5000;

	/**
	 * Whether the action can happen right now: its `.path` unit is active and no block inhibitor
	 * (a running package upgrade, for example) stops shutdowns. Returns why not, or null if it can
	 * or that can't be told (no systemctl or busctl, or no D-Bus to ask through). The server gets
	 * this answer; the action itself runs only after answering.
	 */
	static async check(action: HostControl.Action): Promise<string | null> {
		if (Platform.isWindows()) return null;
		if (Platform.isMac()) {
			const dir = MacFiles.requestDir(action);
			return (await HostControl.exists(dir))
				? null
				: HostControl.notSetUp(action, `${dir} is missing`);
		}

		const unit = `${SystemFiles.powerUnitName(action)}.path`;
		// Prints the state (also for a unit that doesn't exist: "inactive"); nothing if it can't ask.
		const state = (await HostControl.output(["systemctl", "is-active", unit]))?.trim();
		if (state && state !== "active") return HostControl.notSetUp(action, `${unit} is ${state}`);

		const inhibitors = await HostControl.output(
			[
				"busctl",
				"--system",
				"--json=short",
				"call",
				"org.freedesktop.login1",
				"/org/freedesktop/login1",
				"org.freedesktop.login1.Manager",
				"ListInhibitors",
			],
			{ requireSuccess: true },
		);
		const blocker = inhibitors === null ? null : HostControl.blockingInhibitor(inhibitors);
		if (blocker) {
			return `${blocker.who} blocks shutdown and reboot right now${blocker.why ? ` (${blocker.why})` : ""}`;
		}
		return null;
	}

	/**
	 * The first inhibitor in logind's `ListInhibitors` answer (`busctl --json=short`) that blocks
	 * shutdowns, or null. Delay inhibitors only postpone a shutdown and don't count.
	 */
	static blockingInhibitor(json: string): { who: string; why: string } | null {
		let inhibitors: unknown;
		try {
			inhibitors = (JSON.parse(json) as { data?: unknown[] }).data?.[0];
		} catch {
			return null;
		}
		if (!Array.isArray(inhibitors)) return null;

		for (const entry of inhibitors) {
			if (!Array.isArray(entry)) continue;
			const [what, who, why, mode] = entry;
			if (mode !== "block" || typeof what !== "string") continue;
			if (!what.split(":").includes("shutdown")) continue;
			return { who: String(who || "Something"), why: String(why ?? "") };
		}
		return null;
	}

	/**
	 * Linux and macOS: creates the action's request file and waits until the root unit picked it up
	 * (deleted it). If nothing does, removes the file again, so that it can't fire later, and
	 * throws. Windows: runs `shutdown.exe`.
	 */
	static async perform(
		action: HostControl.Action,
		options: { requestPath?: string; timeoutMs?: number } = {},
	) {
		if (Platform.isWindows() && !options.requestPath) return await HostControl.runShutdownExe(action);

		const path =
			options.requestPath ??
			(Platform.isMac() ? MacFiles.requestPath(action) : SystemFiles.requestPath(action));
		const timeoutMs = options.timeoutMs ?? HostControl.PICKUP_TIMEOUT_MS;
		Logger.warn(`Host control: ${action} requested by the server, asking the system (${path})`);

		try {
			await writeFile(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(HostControl.notSetUp(action, `can't create ${path}: ${reason}`));
		}

		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await Bun.sleep(100);
			if (!(await HostControl.exists(path))) return;
		}

		await rm(path, { force: true });
		throw new Error(
			HostControl.notSetUp(action, `nothing picked the request up within ${timeoutMs / 1000} s`),
		);
	}

	private static async runShutdownExe(action: HostControl.Action) {
		const argv = WindowsFiles.shutdownCommand(action);
		Logger.warn(`Host control: ${action} requested by the server, running ${argv.join(" ")}`);
		const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) {
			const detail = (stderr.trim() || stdout.trim()).replace(/\s+/g, " ");
			throw new Error(`shutdown.exe failed (exit ${exitCode})${detail ? `: ${detail}` : ""}`);
		}
	}

	private static notSetUp(action: HostControl.Action, reason: string) {
		const verb = action === "shutdown" ? "shut down" : "reboot";
		return `This machine can't ${verb} through the agent (${reason}): run "sudo ${AppConstants.BINARY_NAME} install" again`;
	}

	/** stdout of a command, or null if it can't run (or, with `requireSuccess`, exits non-zero). */
	private static async output(argv: string[], options: { requireSuccess?: boolean } = {}) {
		try {
			const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
			const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			if (options.requireSuccess && exitCode !== 0) return null;
			return stdout;
		} catch {
			return null;
		}
	}

	private static async exists(path: string) {
		try {
			await stat(path);
			return true;
		} catch {
			return false;
		}
	}
}

export namespace HostControl {
	export type Action = "shutdown" | "reboot";
	export type Perform = (action: Action) => Promise<void>;
	/** Returns why the action isn't possible now, or null. */
	export type Check = (action: Action) => Promise<string | null>;
}
