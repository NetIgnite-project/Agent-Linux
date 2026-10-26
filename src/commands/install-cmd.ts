import { CLIBaseCommand, CLICommandArg, type CLICommandArgParser } from "@cleverjs/cli";
import { AgentConfig } from "../config/agentConfig";
import { InstallPlan } from "../install/installPlan";
import { MacFacts } from "../install/macos/macFacts";
import { MacFiles } from "../install/macos/macFiles";
import { MacPlan } from "../install/macos/macPlan";
import { PlanRunner } from "../install/planRunner";
import { SystemFacts } from "../install/systemFacts";
import { WindowsFacts } from "../install/windows/windowsFacts";
import { WindowsFiles } from "../install/windows/windowsFiles";
import { WindowsPlan } from "../install/windows/windowsPlan";
import { WindowsPolicy } from "../install/windows/windowsPolicy";
import { CommandFlags, serviceConfigPath } from "../utils/commandFlags";
import { AppConstants } from "../utils/constants";
import { AppError, reportError } from "../utils/errors";
import { Logger } from "../utils/logger";
import { Platform } from "../utils/platform";

const ARGS = CLICommandArg.defineCLIArgSpecs({
	flags: [CommandFlags.CONFIG, CommandFlags.DRY_RUN],
});

/**
 * `install`: sets the agent up as a service that starts with the machine.
 *
 * - Linux: the systemd service `netignite-agent` as the system user `netignite`, plus the units
 *   that power off or reboot when the agent asks for it.
 * - macOS: the launchd daemon `dev.netignite.agent` as the hidden user `_netignite`, plus a root
 *   daemon per action.
 * - Windows: the scheduled task "NetIgnite Agent", started at boot as LOCAL SERVICE.
 */
export class InstallCMD extends CLIBaseCommand<typeof ARGS> {
	static readonly ARGS = ARGS;

	constructor() {
		super({
			name: "install",
			description:
				"Install and start the service (needs root or an administrator, and a paired config).",
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
		const configPath = serviceConfigPath(configFlag);

		if (!dryRun) {
			const problem = Platform.requirePrivileges("install");
			if (problem) throw new AppError(problem);
			if (Platform.isLinux() && !(await SystemFacts.systemdRunning())) {
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
			// Configs from 1.0.0 and older have no SSH keys; the service can't write them itself.
			// They exist for Wake-on-LAN mode's SSH logins, which need Linux.
			const { config, created } = Platform.isLinux()
				? AgentConfig.withSshKeys(loaded)
				: { config: loaded, created: false };
			if (created && !dryRun) {
				await AgentConfig.save(configPath, config);
				Logger.info("Created the agent's SSH keys (for shutdown and reboot of other devices).");
			}
		} catch (error) {
			if (!dryRun) throw error;
			Logger.warn(`${error instanceof Error ? error.message : error} (ignored for --dry-run)`);
		}
		if (wol && !Platform.isLinux()) {
			Logger.warn("Wake-on-LAN mode needs Linux; on this machine the agent runs in host mode.");
		}

		if (Platform.isWindows()) return await InstallCMD.installWindows(configPath, dryRun);
		if (Platform.isMac()) return await InstallCMD.installMac(configPath, dryRun);
		return await InstallCMD.installLinux(configPath, wol, dryRun);
	}

	private static async installLinux(configPath: string, wol: boolean, dryRun: boolean) {
		const user = AppConstants.SERVICE_USER;
		const facts = Platform.isLinux()
			? await SystemFacts.gather(user)
			: { userExists: false, groupExists: false, nologinShell: "/usr/sbin/nologin" };

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

	private static async installMac(configPath: string, dryRun: boolean) {
		const facts = await MacFacts.gather();
		const steps = MacPlan.install({
			binarySource: process.execPath,
			binaryTarget: AppConstants.INSTALL_BINARY_PATH,
			configPath,
			facts,
		});

		await PlanRunner.run(steps, { dryRun });
		if (dryRun) return;

		Logger.info(
			`Installed: the launchd daemon ${MacFiles.LABEL} runs as user ${MacFiles.SERVICE_USER}.`,
		);
		Logger.info(
			`Check it with: sudo ${AppConstants.BINARY_NAME} status  /  log: ${MacFiles.logFile()}`,
		);
	}

	private static async installWindows(configPath: string, dryRun: boolean) {
		// secedit needs an administrator; and without the local policy the plan can't grant the
		// shutdown right, which shutdown.exe needs.
		const policy = await WindowsFacts.policy();
		if (!dryRun && !policy) {
			throw new AppError(
				"secedit couldn't export the local security policy, so the agent's account can't be granted the right to shut this machine down",
			);
		}
		const steps = WindowsPlan.install({
			binarySource: process.execPath,
			binaryTarget: AppConstants.INSTALL_BINARY_PATH,
			configPath,
			policy,
		});

		await PlanRunner.run(steps, { dryRun });
		if (dryRun) return;

		Logger.info(
			`Installed: the scheduled task "${WindowsFiles.TASK_NAME}" runs the agent as LOCAL SERVICE whenever Windows starts.`,
		);
		// Only when this run rewrites the policy; on a re-install the right is already granted.
		if (policy && WindowsPolicy.merge(policy.text) !== null) {
			Logger.info(
				"Granted LOCAL SERVICE the right to shut this machine down (uninstall takes it back).",
			);
		}
		Logger.info(
			`Check it with: ${AppConstants.BINARY_NAME} status  /  log: ${WindowsFiles.logFile(configPath)}`,
		);
	}
}
