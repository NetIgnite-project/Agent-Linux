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
}
