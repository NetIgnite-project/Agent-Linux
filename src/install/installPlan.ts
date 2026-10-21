import { posix } from "node:path";
import { AppConstants } from "../utils/constants";
import { SystemFiles } from "./systemFiles";

/**
 * What `install`, `uninstall` and `wol on|off` do to the system, as a list of steps. Building the
 * list is pure (tested); {@link PlanRunner} executes or prints it.
 */
export class InstallPlan {
	/** The .path units that turn the agent's requests into a shutdown or reboot. */
	static powerPathUnits() {
		return SystemFiles.actions().map((action) => `${SystemFiles.powerUnitName(action)}.path`);
	}

	static install(options: InstallPlan.InstallOptions): InstallPlan.Step[] {
		const { user, facts } = options;
		const configDir = posix.dirname(options.configPath);
		const service = AppConstants.SERVICE_NAME;
		const steps: InstallPlan.Step[] = [];

		if (!facts.userExists) {
			steps.push({
				type: "run",
				argv: [
					"useradd",
					"--system",
					"--no-create-home",
					"--home-dir",
					"/nonexistent",
					"--shell",
					facts.nologinShell,
					// A group of the same name may be left over from an earlier install.
					...(facts.groupExists ? ["--gid", user] : ["--user-group"]),
					user,
				],
			});
		}

		if (options.binarySource !== options.binaryTarget) {
			steps.push({ type: "copy", from: options.binarySource, to: options.binaryTarget, mode: 0o755 });
		}

		// The config holds the secret: owned by the service user (which has to read it), 0600.
		// The directory stays root's, so the service user can't put other files there.
		steps.push(
			{ type: "run", argv: ["chown", `root:${user}`, configDir] },
			{ type: "run", argv: ["chmod", "0750", configDir] },
			{ type: "run", argv: ["chown", `${user}:${user}`, options.configPath] },
			{ type: "run", argv: ["chmod", "0600", options.configPath] },
		);

		steps.push({
			type: "write",
			path: SystemFiles.UNIT_PATH,
			content: SystemFiles.unit({
				binaryPath: options.binaryTarget,
				configPath: options.configPath,
				user,
				wol: options.wol,
			}),
			mode: 0o644,
		});

		for (const action of SystemFiles.actions()) {
			const name = SystemFiles.powerUnitName(action);
			steps.push(
				{
					type: "write",
					path: `${SystemFiles.UNIT_DIR}/${name}.path`,
					content: SystemFiles.powerPathUnit(action),
					mode: 0o644,
				},
				{
					type: "write",
					path: `${SystemFiles.UNIT_DIR}/${name}.service`,
					content: SystemFiles.powerServiceUnit(action),
					mode: 0o644,
				},
			);
		}
		// Earlier versions used polkit for shutdown and reboot.
		for (const path of SystemFiles.LEGACY_POLKIT_FILES) steps.push({ type: "remove", path });

		steps.push(
			{ type: "run", argv: ["systemctl", "daemon-reload"] },
			// Watching before the agent (re)starts, so its first request is picked up.
			{ type: "run", argv: ["systemctl", "enable", "--now", ...InstallPlan.powerPathUnits()] },
			{ type: "run", argv: ["systemctl", "enable", service] },
			// restart instead of `enable --now`: it also picks up a new binary or config.
			{ type: "run", argv: ["systemctl", "restart", service] },
		);

		return steps;
	}

	static uninstall(options: InstallPlan.UninstallOptions): InstallPlan.Step[] {
		const { user, facts } = options;
		const configDir = posix.dirname(options.configPath);
		const service = AppConstants.SERVICE_NAME;

		const steps: InstallPlan.Step[] = [
			{ type: "run", argv: ["systemctl", "disable", "--now", service], ignoreFailure: true },
			{
				type: "run",
				argv: ["systemctl", "disable", "--now", ...InstallPlan.powerPathUnits()],
				ignoreFailure: true,
			},
			{ type: "remove", path: SystemFiles.UNIT_PATH },
			...SystemFiles.powerUnitPaths().map((path): InstallPlan.Step => ({ type: "remove", path })),
			{ type: "run", argv: ["systemctl", "daemon-reload"], ignoreFailure: true },
			...SystemFiles.LEGACY_POLKIT_FILES.map((path): InstallPlan.Step => ({ type: "remove", path })),
		];

		if (options.purge) {
			steps.push({ type: "remove", path: options.configPath }, { type: "rmdir", path: configDir });
		} else {
			// Keep the config, root-only again: the service user is about to disappear.
			steps.push(
				{ type: "run", argv: ["chown", "root:root", configDir], ignoreFailure: true },
				{ type: "run", argv: ["chmod", "0700", configDir], ignoreFailure: true },
				{ type: "run", argv: ["chown", "root:root", options.configPath], ignoreFailure: true },
				{ type: "run", argv: ["chmod", "0600", options.configPath], ignoreFailure: true },
			);
		}

		if (facts.userExists) {
			steps.push({ type: "run", argv: ["userdel", user], ignoreFailure: true });
		}

		steps.push({ type: "remove", path: options.binaryTarget });
		return steps;
	}

	/** After `wol on|off` on an installed agent: the unit's capabilities depend on the mode. */
	static refreshUnit(options: SystemFiles.UnitOptions): InstallPlan.Step[] {
		return [
			{ type: "write", path: SystemFiles.UNIT_PATH, content: SystemFiles.unit(options), mode: 0o644 },
			{ type: "run", argv: ["systemctl", "daemon-reload"] },
			{ type: "run", argv: ["systemctl", "try-restart", AppConstants.SERVICE_NAME] },
		];
	}

	/** One line per step, for `--dry-run` and logs. */
	static describe(step: InstallPlan.Step) {
		const mode = (value: number) => `0${value.toString(8)}`;
		switch (step.type) {
			case "run":
				return `run    ${step.argv.join(" ")}${step.ignoreFailure ? "  (failure ignored)" : ""}`;
			case "write":
				return `write  ${step.path} (mode ${mode(step.mode)})`;
			case "copy":
				return `copy   ${step.from} -> ${step.to} (mode ${mode(step.mode)})`;
			case "mkdir":
				return `mkdir  ${step.path} (mode ${mode(step.mode)}, if missing)`;
			case "remove":
				return `remove ${step.path} (if present)`;
			case "rmdir":
				return `rmdir  ${step.path} (if empty)`;
		}
	}
}

export namespace InstallPlan {
	export type Step =
		| { type: "run"; argv: string[]; ignoreFailure?: boolean }
		| { type: "write"; path: string; content: string; mode: number }
		| { type: "copy"; from: string; to: string; mode: number }
		| { type: "mkdir"; path: string; mode: number }
		| { type: "remove"; path: string }
		/** Removes a directory only if it is empty. */
		| { type: "rmdir"; path: string };

	/** What the plan depends on about the system. */
	export type Facts = {
		userExists: boolean;
		groupExists: boolean;
		/** `/usr/sbin/nologin` or wherever the system has it. */
		nologinShell: string;
	};

	export type InstallOptions = {
		/** The running binary. */
		binarySource: string;
		/** Where the service runs it from. */
		binaryTarget: string;
		configPath: string;
		user: string;
		wol: boolean;
		facts: Facts;
	};

	export type UninstallOptions = {
		binaryTarget: string;
		configPath: string;
		user: string;
		/** Also delete the config (and its directory, if empty). */
		purge: boolean;
		facts: Pick<Facts, "userExists">;
	};
}
