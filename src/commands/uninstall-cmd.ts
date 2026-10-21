import { CLIBaseCommand, CLICommandArg, type CLICommandArgParser } from "@cleverjs/cli";
import { InstallPlan } from "../install/installPlan";
import { PlanRunner } from "../install/planRunner";
import { SystemFacts } from "../install/systemFacts";
import { CommandFlags, serviceConfigPath } from "../utils/commandFlags";
import { AppConstants } from "../utils/constants";
import { AppError, reportError } from "../utils/errors";
import { Logger } from "../utils/logger";
import { Platform } from "../utils/platform";

const ARGS = CLICommandArg.defineCLIArgSpecs({
	flags: [
		CommandFlags.CONFIG,
		{
			name: "purge",
			type: "boolean",
			description: "Also delete the config with the agent's credential.",
		},
		CommandFlags.DRY_RUN,
	],
});

/** `uninstall`: removes the service and its power units, service user and binary. Keeps the config unless `--purge`. */
export class UninstallCMD extends CLIBaseCommand<typeof ARGS> {
	static readonly ARGS = ARGS;

	constructor() {
		super({
			name: "uninstall",
			description: "Stop and remove the service (keeps the config unless --purge).",
			args: ARGS,
		});
	}

	async run(args: CLICommandArgParser.ParsedArgs<typeof ARGS>) {
		try {
			await this.uninstall(args.flags.config, args.flags.purge, args.flags["dry-run"]);
			return true;
		} catch (error) {
			reportError(error);
			return false;
		}
	}

	private async uninstall(configFlag: string, purge: boolean, dryRun: boolean) {
		if (!dryRun) {
			const problem = Platform.requireLinuxRoot("uninstall");
			if (problem) throw new AppError(problem);
		}

		const user = AppConstants.SERVICE_USER;
		const configPath = serviceConfigPath(configFlag);
		const facts = Platform.isLinux() ? await SystemFacts.gather(user) : { userExists: true };

		const steps = InstallPlan.uninstall({
			binaryTarget: AppConstants.INSTALL_BINARY_PATH,
			configPath,
			user,
			purge,
			facts,
		});

		await PlanRunner.run(steps, { dryRun });
		if (dryRun) return;

		Logger.info(`Uninstalled ${AppConstants.APP_NAME}.`);
		Logger.info(
			purge
				? `Deleted ${configPath}. The agent stays registered in the dashboard; delete it there too.`
				: `Kept ${configPath} (root-only). Delete it with: sudo rm ${configPath}`,
		);
	}
}
