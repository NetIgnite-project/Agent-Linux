import { Logger } from "../utils/logger";

/**
 * Shutting down and rebooting the machine the agent runs on. Only these two fixed commands exist;
 * nothing the server sends ends up on a command line.
 *
 * The service user may run them through polkit (`install` writes the rule).
 */
export class HostControl {
	/** Time between answering the request and acting, so the answer reaches the server. */
	static readonly DELAY_MS = 1000;

	static command(action: HostControl.Action): string[] {
		const verb = action === "shutdown" ? "poweroff" : "reboot";
		return ["systemctl", "--no-ask-password", verb];
	}

	/**
	 * Asks logind whether this user may do the action right now (polkit rule, inhibitors, other
	 * users' sessions). Returns why not, or null if it may or the answer is unknown (no busctl).
	 * The server gets this answer; the action itself runs only after answering.
	 */
	static async check(action: HostControl.Action): Promise<string | null> {
		const method = action === "shutdown" ? "CanPowerOff" : "CanReboot";
		let output: string;
		try {
			const child = Bun.spawn(
				[
					"busctl",
					"--system",
					"call",
					"org.freedesktop.login1",
					"/org/freedesktop/login1",
					"org.freedesktop.login1.Manager",
					method,
				],
				{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
			);
			if ((await child.exited) !== 0) return null;
			output = await new Response(child.stdout).text();
		} catch {
			return null;
		}
		return HostControl.describeAnswer(action, output);
	}

	/** Turns logind's answer (`s "yes"`, `s "challenge"`, ...) into an error, or null if allowed. */
	static describeAnswer(action: HostControl.Action, output: string): string | null {
		const verb = action === "shutdown" ? "shut down" : "reboot";
		switch (output.match(/"([a-z]+)"/)?.[1]) {
			case "challenge":
				return `This machine doesn't let the agent ${verb} without a password: the polkit rule from "netignite-agent install" is missing, or an inhibitor blocks it (systemd-inhibit --list)`;
			case "no":
				return `This machine doesn't let the agent ${verb} (polkit or an inhibitor denies it)`;
			case "na":
				return `This machine can't ${verb} through systemd-logind`;
			default:
				return null;
		}
	}

	/** Runs the action. Throws if systemctl refuses (e.g. polkit denies it or something inhibits it). */
	static async execute(action: HostControl.Action) {
		const command = HostControl.command(action);
		Logger.warn(`Host control: ${action} requested by the server, running ${command.join(" ")}`);

		const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
		const exitCode = await child.exited;
		if (exitCode !== 0) {
			const stderr = (await new Response(child.stderr).text()).trim();
			throw new Error(`${command.join(" ")} failed (exit ${exitCode})${stderr ? `: ${stderr}` : ""}`);
		}
	}
}

export namespace HostControl {
	export type Action = "shutdown" | "reboot";
	export type Executor = (action: Action) => Promise<void>;
	/** Returns why the action isn't possible now, or null. */
	export type Check = (action: Action) => Promise<string | null>;
}
