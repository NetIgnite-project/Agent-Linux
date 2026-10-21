import { resolve } from "node:path";
import { CLIBaseCommand, CLICommandArg, type CLICommandArgParser } from "@cleverjs/cli";
import { AgentConfig } from "../config/agentConfig";
import { InstallPlan } from "../install/installPlan";
import { PlanRunner } from "../install/planRunner";
import { SystemFacts } from "../install/systemFacts";
import { CommandFlags, serviceConfigPath } from "../utils/commandFlags";
import { AppConstants } from "../utils/constants";
import { reportError } from "../utils/errors";
import { Logger } from "../utils/logger";
import { Platform } from "../utils/platform";

const ARGS = CLICommandArg.defineCLIArgSpecs({
	args: [
		{
			name: "mode",
			type: "enum",
			allowedValues: ["on", "off"],
			required: true,
			description: "on: also wake and check other devices on this network; off: host mode only.",
		},
	],
	flags: [CommandFlags.CONFIG],
});

/** `wol-mode on|off`: switches Wake-on-LAN mode in the config and updates an installed service. */
export class WolModeCMD extends CLIBaseCommand<typeof ARGS> {
	static readonly ARGS = ARGS;

	constructor() {
		super({
			name: "wol-mode",
			description: "Turn Wake-on-LAN mode on or off (wake and check other devices).",
			args: ARGS,
		});
	}

	async run(args: CLICommandArgParser.ParsedArgs<typeof ARGS>) {
		try {
			await this.setMode(args.args.mode === "on", args.flags.config);
			return true;
		} catch (error) {
			reportError(error);
			return false;
		}
	}

	private async setMode(enabled: boolean, configFlag: string) {
		const configPath = serviceConfigPath(configFlag);
		const config = await AgentConfig.load(configPath);

		if (config.wol.enabled === enabled) {
			Logger.info(`Wake-on-LAN mode is already ${enabled ? "on" : "off"}.`);
			return;
		}

		const root = Platform.isLinux() && Platform.isRoot();
		const serviceUser = root ? await SystemFacts.userIds(AppConstants.SERVICE_USER) : null;
		await AgentConfig.save(configPath, { ...config, wol: { enabled } }, { serviceUser });
		Logger.info(`Wake-on-LAN mode is now ${enabled ? "on" : "off"}.`);

		const installedConfig = root ? await SystemFacts.installedConfigPath() : null;
		if (installedConfig && installedConfig === resolve(configPath)) {
			// The service's capabilities depend on the mode (ping needs CAP_NET_RAW).
			await PlanRunner.run(
				InstallPlan.refreshUnit({
					binaryPath: AppConstants.INSTALL_BINARY_PATH,
					configPath,
					user: AppConstants.SERVICE_USER,
					wol: enabled,
				}),
				{ dryRun: false },
			);
			Logger.info("Updated and restarted the service.");
		} else {
			Logger.info("Restart the agent to apply it.");
		}
	}
}
