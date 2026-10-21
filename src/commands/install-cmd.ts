import { CLIBaseCommand, CLICommandArg, type CLICommandArgParser } from "@cleverjs/cli";
import { AgentConfig } from "../config/agentConfig";
import { InstallPlan } from "../install/installPlan";
import { PlanRunner } from "../install/planRunner";
import { SystemFacts } from "../install/systemFacts";
import { CommandFlags, serviceConfigPath } from "../utils/commandFlags";
import { AppConstants } from "../utils/constants";
import { AppError, reportError } from "../utils/errors";
import { Logger } from "../utils/logger";
import { Platform } from "../utils/platform";

const ARGS = CLICommandArg.defineCLIArgSpecs({
	flags: [CommandFlags.CONFIG, CommandFlags.DRY_RUN],
});

/**
 * `install`: sets the agent up as the systemd service `netignite-agent`, running as the system
 * user `netignite`, plus the units that power off or reboot when the agent asks for it.
 */
export class InstallCMD extends CLIBaseCommand<typeof ARGS> {
	static readonly ARGS = ARGS;

	constructor() {
		super({
			name: "install",
			description: "Install and start the systemd service (needs root and a paired config).",
			args: ARGS,
		});
	}

	async run(args: CLICommandArgParser.ParsedArgs<typeof ARGS>) {
		try {
			await this.install(args.flags.config, args.flags["dry-run"]);
			return true;
		} catch (error) {
			reportError(error);
			return false;
		}
	}

	private async install(configFlag: string, dryRun: boolean) {
		const user = AppConstants.SERVICE_USER;
		const configPath = serviceConfigPath(configFlag);

		if (!dryRun) {
			const problem = Platform.requireLinuxRoot("install");
			if (problem) throw new AppError(problem);
			if (!(await SystemFacts.systemdRunning())) {
				throw new AppError("systemd isn't running on this machine, so the service can't be installed.");
			}
			if (!Platform.isCompiledBinary()) {
				throw new AppError(
					`install must run from the compiled ${AppConstants.BINARY_NAME} binary (not bun run).`,
				);
			}
		}

		let wol = false;
		try {
			const loaded = await AgentConfig.load(configPath);
			wol = loaded.wol.enabled;
			// Configs from before 1.0.0 have no SSH keys; the service can't write them itself.
			const { config, created } = AgentConfig.withSshKeys(loaded);
			if (created && !dryRun) {
				await AgentConfig.save(configPath, config);
				Logger.info("Created the agent's SSH keys (for shutdown and reboot of other devices).");
			}
		} catch (error) {
			if (!dryRun) throw error;
			Logger.warn(`${error instanceof Error ? error.message : error} (ignored for --dry-run)`);
		}

		const facts = Platform.isLinux()
			? await SystemFacts.gather(user)
			: {
					userExists: false,
					groupExists: false,
					nologinShell: "/usr/sbin/nologin",
				};

		const steps = InstallPlan.install({
			binarySource: process.execPath,
			binaryTarget: AppConstants.INSTALL_BINARY_PATH,
			configPath,
			user,
			wol,
			facts,
		});

		await PlanRunner.run(steps, { dryRun });
		if (dryRun) return;

		Logger.info(
			`Installed: the ${AppConstants.SERVICE_NAME} service runs as user ${user} (Wake-on-LAN mode ${wol ? "on" : "off"}).`,
		);
		Logger.info(
			`Check it with: systemctl status ${AppConstants.SERVICE_NAME}  /  journalctl -u ${AppConstants.SERVICE_NAME} -f`,
		);
	}
}
