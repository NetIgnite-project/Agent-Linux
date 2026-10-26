import { AppError } from "../../utils/errors";
import { MacFiles } from "./macFiles";
import { MacPlan } from "./macPlan";

/** Looks at the Mac (read-only) for `install`, `uninstall` and `status`. */
export class MacFacts {
	static async gather(): Promise<MacPlan.Facts> {
		const [{ userId, groupId }, users, groups] = await Promise.all([
			MacFacts.existingIds(),
			MacFacts.output(["dscl", ".", "-list", "/Users", "UniqueID"]),
			MacFacts.output(["dscl", ".", "-list", "/Groups", "PrimaryGroupID"]),
		]);
		const freeId = MacPlan.freeId(users ?? "", groups ?? "");
		if (freeId === null && (userId === null || groupId === null)) {
			throw new AppError(
				`No free id in ${MacPlan.ID_RANGE.join("–")} for the user ${MacFiles.SERVICE_USER}.`,
			);
		}
		return { userId, groupId, freeId: freeId ?? MacPlan.ID_RANGE[0] };
	}

	/** `uid:gid` of the agent's user, for writing its config; null if it doesn't exist. */
	static async serviceUser() {
		const user = MacFiles.SERVICE_USER;
		const [uid, gid] = await Promise.all([
			MacFacts.readId(`/Users/${user}`, "UniqueID"),
			MacFacts.readId(`/Users/${user}`, "PrimaryGroupID"),
		]);
		return uid !== null && gid !== null ? { uid, gid } : null;
	}

	/**
	 * Whether the agent's user and group exist, for `uninstall`: two `dscl` reads, not the two full
	 * directory listings `gather()` needs to find a free id.
	 */
	static async existingIds() {
		const user = MacFiles.SERVICE_USER;
		const [userId, groupId] = await Promise.all([
			MacFacts.readId(`/Users/${user}`, "UniqueID"),
			MacFacts.readId(`/Groups/${user}`, "PrimaryGroupID"),
		]);
		return { userId, groupId };
	}

	/** `launchctl print` of the agent: `running`, or why not. */
	static async serviceState() {
		const text = await MacFacts.output(["launchctl", "print", `system/${MacFiles.LABEL}`]);
		if (text === null) return "not installed";
		return /^\s*state = (\S+)/m.exec(text)?.[1] ?? "unknown";
	}

	static async installed() {
		return (await MacFacts.output(["launchctl", "print", `system/${MacFiles.LABEL}`])) !== null;
	}

	/** `dscl . -read <record> <key>` as a number (`UniqueID: 401`), or null. */
	private static async readId(record: string, key: string) {
		const text = await MacFacts.output(["dscl", ".", "-read", record, key]);
		const id = Number(text?.split(":")[1]?.trim());
		return Number.isInteger(id) ? id : null;
	}

	/** stdout of a command that succeeded, or null. */
	private static async output(argv: string[]) {
		try {
			const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
			const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			return exitCode === 0 ? stdout : null;
		} catch {
			return null;
		}
	}
}
