import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { Logger } from "../../utils/logger";
import { WindowsFiles } from "./windowsFiles";
import { WindowsPolicy } from "./windowsPolicy";

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

	/**
	 * The local security policy, as `secedit /export` writes it (a read; nothing on the system
	 * changes), or null when it can't be read (secedit missing, or this isn't an administrator —
	 * e.g. a `--dry-run`).
	 */
	static async policy(): Promise<WindowsFacts.Policy | null> {
		const inf = win32.join(tmpdir(), `netignite-secedit-${process.pid}.inf`);
		try {
			const child = Bun.spawn(["secedit", "/export", "/cfg", inf], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
			});
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			if (exitCode !== 0) {
				Logger.debug(`secedit /export failed (exit ${exitCode}): ${stderr.trim()}`);
				return null;
			}
			const buffer = await readFile(inf);
			const { text, encoding } = WindowsPolicy.decode(buffer);
			return { text, encoding };
		} catch (error) {
			Logger.debug(`secedit /export failed: ${error instanceof Error ? error.message : error}`);
			return null;
		} finally {
			await rm(inf, { force: true }).catch(() => {});
		}
	}
}

export namespace WindowsFacts {
	export type Policy = {
		/** The whole exported INF text; the plan edits the `SeShutdownPrivilege` line in it. */
		text: string;
		/** How secedit encoded it; the plan writes it back the same way. */
		encoding?: "utf16le-bom";
	};
}
