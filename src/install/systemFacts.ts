import { readFile } from "node:fs/promises";
import { AppConstants } from "../utils/constants";
import { Platform } from "../utils/platform";
import type { InstallPlan } from "./installPlan";
import { SystemFiles } from "./systemFiles";

/** Looks at the system (read-only) for `install`, `uninstall`, `pair` and `status`. */
export class SystemFacts {
	static readonly NOLOGIN_SHELLS = ["/usr/sbin/nologin", "/sbin/nologin", "/usr/bin/nologin"];
	static readonly POLKITD_PATHS = [
		"/usr/lib/polkit-1/polkitd",
		"/usr/libexec/polkitd",
		"/usr/libexec/polkit-1/polkitd",
		"/usr/lib/polkit/polkitd",
	];

	static async gather(user: string): Promise<InstallPlan.Facts> {
		const [userExists, groupExists, nologinShell, legacyPolkit] = await Promise.all([
			SystemFacts.succeeds(["getent", "passwd", user]),
			SystemFacts.succeeds(["getent", "group", user]),
			SystemFacts.nologinShell(),
			Platform.exists(SystemFiles.POLKIT_LEGACY_DIR),
		]);
		return { userExists, groupExists, nologinShell, legacyPolkit };
	}

	/** uid and gid of a user, or null if it doesn't exist (or this isn't Linux). */
	static async userIds(user: string) {
		if (!Platform.isLinux()) return null;
		return SystemFacts.parsePasswdEntry(await SystemFacts.output(["getent", "passwd", user]));
	}

	/** Parses a passwd(5) line, `name:x:uid:gid:gecos:home:shell`. */
	static parsePasswdEntry(line: string) {
		const fields = line.trim().split(":");
		if (fields.length < 7) return null;

		const uid = Number(fields[2]);
		const gid = Number(fields[3]);
		if (!/^\d+$/.test(fields[2] ?? "") || !/^\d+$/.test(fields[3] ?? "")) return null;
		return { uid, gid };
	}

	/** Whether systemd is the init system (same check as `sd_booted()`). */
	static systemdRunning() {
		return Platform.exists("/run/systemd/system");
	}

	static async polkitInstalled() {
		if (Bun.which("pkaction")) return true;
		for (const path of SystemFacts.POLKITD_PATHS) {
			if (await Platform.exists(path)) return true;
		}
		return false;
	}

	static unitInstalled() {
		return Platform.exists(SystemFiles.UNIT_PATH);
	}

	/** The config path the installed service runs with, or null if there is no unit. */
	static async installedConfigPath() {
		try {
			return SystemFiles.unitConfigPath(await readFile(SystemFiles.UNIT_PATH, "utf8"));
		} catch {
			return null;
		}
	}

	/** `systemctl is-active` / `is-enabled` of the service, e.g. `active` and `enabled`. */
	static async serviceState() {
		const [active, enabled] = await Promise.all([
			SystemFacts.output(["systemctl", "is-active", AppConstants.SERVICE_NAME]),
			SystemFacts.output(["systemctl", "is-enabled", AppConstants.SERVICE_NAME]),
		]);
		return { active: active || "unknown", enabled: enabled || "unknown" };
	}

	private static async nologinShell() {
		for (const path of SystemFacts.NOLOGIN_SHELLS) {
			if (await Platform.exists(path)) return path;
		}
		return "/bin/false";
	}

	private static async succeeds(argv: string[]) {
		try {
			const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
			return (await child.exited) === 0;
		} catch {
			return false;
		}
	}

	private static async output(argv: string[]) {
		try {
			const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
			const [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);
			return text.trim();
		} catch {
			return "";
		}
	}
}
