import { WindowsFiles } from "./windowsFiles";

/** Looks at the Windows PC (read-only) for `install`, `pair` and `status`. */
export class WindowsFacts {
	/**
	 * The task's state: `Running`, `Ready`, `Disabled`, … (PowerShell's names, not translated), or
	 * `not installed`.
	 */
	static async taskState() {
		try {
			const child = Bun.spawn(
				[
					"powershell.exe",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`(Get-ScheduledTask -TaskName '${WindowsFiles.TASK_NAME}' -ErrorAction Stop).State`,
				],
				{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
			);
			const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			return exitCode === 0 && stdout.trim() ? stdout.trim() : "not installed";
		} catch {
			return "not installed";
		}
	}
}
