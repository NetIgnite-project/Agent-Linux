import { stat } from "node:fs/promises";

/** Small checks about the machine the agent runs on. */
export class Platform {
	static isLinux() {
		return process.platform === "linux";
	}

	static isRoot() {
		return typeof process.getuid === "function" && process.getuid() === 0;
	}

	/** Whether this process is the compiled binary (not `bun run src/index.ts`). */
	static isCompiledBinary() {
		return Bun.isStandaloneExecutable;
	}

	/**
	 * Returns an error message if the command can't run here: systemd features need Linux, and
	 * changing the system needs root. `null` means everything is fine.
	 */
	static requireLinuxRoot(action: string): string | null {
		if (!Platform.isLinux()) {
			return `${action} needs Linux with systemd (this is ${process.platform}).`;
		}
		if (!Platform.isRoot()) {
			return `${action} must run as root. Try again with sudo.`;
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
