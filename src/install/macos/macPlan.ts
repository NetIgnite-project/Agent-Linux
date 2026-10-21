import { posix } from "node:path";
import type { InstallPlan } from "../installPlan";
import { MacFiles } from "./macFiles";

/** What `install` and `uninstall` do on macOS, as steps for the PlanRunner. */
export class MacPlan {
	/** System accounts below 500 are hidden from the login window; NetIgnite takes one in 400–499. */
	static readonly ID_RANGE = [400, 499] as const;

	static install(options: MacPlan.InstallOptions): InstallPlan.Step[] {
		const { binarySource, binaryTarget, configPath, facts } = options;
		const user = MacFiles.SERVICE_USER;
		const steps: InstallPlan.Step[] = [];

		const gid = facts.groupId ?? facts.freeId;
		const uid = facts.userId ?? facts.freeId;
		if (facts.groupId === null) {
			const group = `/Groups/${user}`;
			steps.push(
				{ type: "run", argv: ["dscl", ".", "-create", group] },
				{ type: "run", argv: ["dscl", ".", "-create", group, "PrimaryGroupID", String(gid)] },
				{ type: "run", argv: ["dscl", ".", "-create", group, "RealName", "NetIgnite Agent"] },
				{ type: "run", argv: ["dscl", ".", "-create", group, "Password", "*"] },
			);
		}
		if (facts.userId === null) {
			const account = `/Users/${user}`;
			steps.push(
				{ type: "run", argv: ["dscl", ".", "-create", account] },
				{ type: "run", argv: ["dscl", ".", "-create", account, "UniqueID", String(uid)] },
				{ type: "run", argv: ["dscl", ".", "-create", account, "PrimaryGroupID", String(gid)] },
				{ type: "run", argv: ["dscl", ".", "-create", account, "UserShell", "/usr/bin/false"] },
				{ type: "run", argv: ["dscl", ".", "-create", account, "NFSHomeDirectory", "/var/empty"] },
				{ type: "run", argv: ["dscl", ".", "-create", account, "RealName", "NetIgnite Agent"] },
				{ type: "run", argv: ["dscl", ".", "-create", account, "IsHidden", "1"] },
				{ type: "run", argv: ["dscl", ".", "-create", account, "Password", "*"] },
			);
		}

		steps.push({ type: "mkdir", path: posix.dirname(binaryTarget), mode: 0o755 });
		if (binarySource !== binaryTarget) {
			steps.push({ type: "copy", from: binarySource, to: binaryTarget, mode: 0o755 });
		}

		// The config: readable by the agent's user only. Numeric ids: a new user may not be cached yet.
		const configDir = posix.dirname(configPath);
		steps.push(
			{ type: "run", argv: ["chown", `0:${gid}`, configDir] },
			{ type: "run", argv: ["chmod", "0750", configDir] },
			{ type: "run", argv: ["chown", `${uid}:${gid}`, configPath] },
			{ type: "run", argv: ["chmod", "0600", configPath] },
			{ type: "mkdir", path: MacFiles.STATE_DIR, mode: 0o755 },
		);
		for (const action of MacFiles.actions()) {
			const dir = MacFiles.requestDir(action);
			steps.push(
				{ type: "mkdir", path: dir, mode: 0o700 },
				{ type: "run", argv: ["chown", `${uid}:${gid}`, dir] },
				{ type: "run", argv: ["chmod", "0700", dir] },
			);
		}
		steps.push(
			{ type: "mkdir", path: MacFiles.LOG_DIR, mode: 0o750 },
			{ type: "run", argv: ["chown", `${uid}:${gid}`, MacFiles.LOG_DIR] },
		);

		for (const action of MacFiles.actions()) {
			steps.push({
				type: "write",
				path: MacFiles.plistPath(MacFiles.powerLabel(action)),
				content: MacFiles.powerPlist(action),
				mode: 0o644,
			});
		}
		steps.push({
			type: "write",
			path: MacFiles.plistPath(MacFiles.LABEL),
			content: MacFiles.agentPlist({ binaryPath: binaryTarget, configPath }),
			mode: 0o644,
		});

		// (Re)load: the root daemons first, so the agent's first request is picked up.
		for (const label of MacFiles.labels()) {
			steps.push({
				type: "run",
				argv: ["launchctl", "bootout", `system/${label}`],
				ignoreFailure: true,
			});
		}
		for (const label of [...MacFiles.labels().slice(1), MacFiles.LABEL]) {
			steps.push({
				type: "run",
				argv: ["launchctl", "bootstrap", "system", MacFiles.plistPath(label)],
			});
		}
		return steps;
	}

	static uninstall(options: MacPlan.UninstallOptions): InstallPlan.Step[] {
		const { binaryTarget, configPath, purge, facts } = options;
		const user = MacFiles.SERVICE_USER;
		const steps: InstallPlan.Step[] = [];

		for (const label of MacFiles.labels()) {
			steps.push(
				{ type: "run", argv: ["launchctl", "bootout", `system/${label}`], ignoreFailure: true },
				{ type: "remove", path: MacFiles.plistPath(label) },
			);
		}
		for (const action of MacFiles.actions()) {
			steps.push(
				{ type: "remove", path: MacFiles.requestPath(action) },
				{ type: "rmdir", path: MacFiles.requestDir(action) },
			);
		}
		steps.push(
			{ type: "rmdir", path: MacFiles.STATE_DIR },
			{ type: "remove", path: MacFiles.logFile() },
			{ type: "remove", path: `${MacFiles.logFile()}.1` },
			{ type: "rmdir", path: MacFiles.LOG_DIR },
			{ type: "remove", path: binaryTarget },
		);

		const configDir = posix.dirname(configPath);
		if (purge) {
			steps.push({ type: "remove", path: configPath }, { type: "rmdir", path: configDir });
		} else {
			// Root-only again, so the config survives the user's removal safely.
			steps.push(
				{ type: "run", argv: ["chown", "0:0", configDir], ignoreFailure: true },
				{ type: "run", argv: ["chmod", "0700", configDir], ignoreFailure: true },
				{ type: "run", argv: ["chown", "0:0", configPath], ignoreFailure: true },
				{ type: "run", argv: ["chmod", "0600", configPath], ignoreFailure: true },
			);
		}

		if (facts.userId !== null)
			steps.push({ type: "run", argv: ["dscl", ".", "-delete", `/Users/${user}`] });
		if (facts.groupId !== null)
			steps.push({ type: "run", argv: ["dscl", ".", "-delete", `/Groups/${user}`] });
		return steps;
	}

	/** After `pair`: restart the agent with the new credential. */
	static restart(): InstallPlan.Step[] {
		return [{ type: "run", argv: ["launchctl", "kickstart", "-k", `system/${MacFiles.LABEL}`] }];
	}

	/**
	 * The lowest id in {@link ID_RANGE} that neither a user nor a group has, from the output of
	 * `dscl . -list /Users UniqueID` and `dscl . -list /Groups PrimaryGroupID` (`name  id` lines).
	 */
	static freeId(users: string, groups: string) {
		const used = new Set(
			`${users}\n${groups}`
				.split("\n")
				.map((line) => Number(line.trim().split(/\s+/).at(-1)))
				.filter((id) => Number.isInteger(id)),
		);
		for (let id: number = MacPlan.ID_RANGE[0]; id <= MacPlan.ID_RANGE[1]; id++) {
			if (!used.has(id)) return id;
		}
		return null;
	}
}

export namespace MacPlan {
	export type Facts = {
		/** `_netignite`'s ids, or null if it doesn't exist. */
		userId: number | null;
		groupId: number | null;
		/** A free id for a new user and group. */
		freeId: number;
	};

	export type InstallOptions = {
		binarySource: string;
		binaryTarget: string;
		configPath: string;
		facts: Facts;
	};

	export type UninstallOptions = {
		binaryTarget: string;
		configPath: string;
		purge: boolean;
		facts: Pick<Facts, "userId" | "groupId">;
	};
}
