import { rm, stat, writeFile } from "node:fs/promises";
import { SystemFiles } from "../install/systemFiles";
import { AppConstants } from "../utils/constants";
import { Logger } from "../utils/logger";

/**
 * Shutting down and rebooting the machine the agent runs on. Only these two fixed actions exist;
 * nothing the server sends ends up on a command line.
 *
 * The agent itself has no right to do either. It asks by creating a file in its runtime directory
 * (`/run/netignite-agent`, writable only by the service user); a `.path` unit that `install` sets
 * up sees the file and starts a root unit that runs `systemctl poweroff` or `systemctl reboot`.
 */
export class HostControl {
	/** Time between answering the request and acting, so the answer reaches the server. */
	static readonly DELAY_MS = 1000;
	/** How long the `.path` unit gets to pick a request up before it counts as failed. */
	static readonly PICKUP_TIMEOUT_MS = 5000;

	/**
	 * Whether the action can happen right now: its `.path` unit is active and no block inhibitor
	 * (a running package upgrade, for example) stops shutdowns. Returns why not, or null if it can
	 * or that can't be told (no systemctl or busctl). The server gets this answer; the action
	 * itself runs only after answering.
	 */
	static async check(action: HostControl.Action): Promise<string | null> {
		const unit = `${SystemFiles.powerUnitName(action)}.path`;
		const state = await HostControl.output(["systemctl", "is-active", unit]);
		if (state !== null && state.trim() !== "active") {
			return HostControl.notSetUp(action, `${unit} is ${state.trim() || "missing"}`);
		}

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
	 * Asks systemd for the action by creating its request file, and waits until the `.path` unit
	 * picked it up (deleted it). If nothing does, removes the file again, so that it can't fire
	 * later, and throws.
	 */
	static async execute(
		action: HostControl.Action,
		options: { requestPath?: string; timeoutMs?: number } = {},
	) {
		const path = options.requestPath ?? SystemFiles.requestPath(action);
		const timeoutMs = options.timeoutMs ?? HostControl.PICKUP_TIMEOUT_MS;
		Logger.warn(`Host control: ${action} requested by the server, asking systemd (${path})`);

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
	export type Executor = (action: Action) => Promise<void>;
	/** Returns why the action isn't possible now, or null. */
	export type Check = (action: Action) => Promise<string | null>;
}
