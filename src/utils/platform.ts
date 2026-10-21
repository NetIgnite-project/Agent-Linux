import { stat } from "node:fs/promises";

/** Small checks about the machine the agent runs on. */
export class Platform {
	private static admin: boolean | null = null;

	static isLinux() {
		return process.platform === "linux";
	}

	static isWindows() {
		return process.platform === "win32";
	}

	static isMac() {
		return process.platform === "darwin";
	}

	/** The agent kind the server knows this machine's agent as. */
	static kind(): Platform.Kind {
		if (Platform.isWindows()) return "windows";
		if (Platform.isMac()) return "macos";
		return "linux";
	}

	static isRoot() {
		return typeof process.getuid === "function" && process.getuid() === 0;
	}

	/** Windows: whether this process runs elevated (as an administrator). */
	static isAdmin() {
		if (!Platform.isWindows()) return false;
		// `net session` only works elevated; it changes nothing.
		Platform.admin ??=
			Bun.spawnSync(["net", "session"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
				.exitCode === 0;
		return Platform.admin;
	}

	/** Root on Linux and macOS, an elevated administrator on Windows. */
	static isPrivileged() {
		return Platform.isWindows() ? Platform.isAdmin() : Platform.isRoot();
	}

	/** Whether this process is the compiled binary (not `bun run src/index.ts`). */
	static isCompiledBinary() {
		return Bun.isStandaloneExecutable;
	}

	/**
	 * Returns an error message if the command can't change the system here: Linux, macOS and
	 * Windows are supported, and it needs root or an administrator. `null` means it can.
	 */
	static requirePrivileges(action: string): string | null {
		if (!Platform.isLinux() && !Platform.isMac() && !Platform.isWindows()) {
			return `${action} needs Linux, macOS or Windows (this is ${process.platform}).`;
		}
		if (!Platform.isPrivileged()) {
			return Platform.isWindows()
				? `${action} must run as an administrator. Open PowerShell with "Run as administrator" and try again.`
				: `${action} must run as root. Try again with sudo.`;
		}
		return null;
	}

	static async exists(path: string) {
		try {
			await stat(path);
			return true;
		} catch {
			return false;
		}
	}
}

export namespace Platform {
	export type Kind = "linux" | "windows" | "macos";
}
