import { CLIBaseCommand, CLICommandArg, type CLICommandArgParser } from "@cleverjs/cli";
import { InstallPlan } from "../install/installPlan";
import { MacFacts } from "../install/macos/macFacts";
import { MacPlan } from "../install/macos/macPlan";
import { PlanRunner } from "../install/planRunner";
import { SystemFacts } from "../install/systemFacts";
import { WindowsFacts } from "../install/windows/windowsFacts";
import { WindowsPlan } from "../install/windows/windowsPlan";
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
			const problem = Platform.requirePrivileges("uninstall");
			if (problem) throw new AppError(problem);
		}

		const configPath = serviceConfigPath(configFlag);
		const binaryTarget = AppConstants.INSTALL_BINARY_PATH;
		let steps: InstallPlan.Step[];
		if (Platform.isWindows()) {
			// Best effort: without the policy (e.g. a non-admin --dry-run), the shutdown right stays.
			steps = WindowsPlan.uninstall({
				binaryTarget,
				configPath,
				purge,
				policy: (await WindowsFacts.policy()) ?? undefined,
			});
		} else if (Platform.isMac()) {
			steps = MacPlan.uninstall({
				binaryTarget,
				configPath,
				purge,
				facts: await MacFacts.existingIds(),
			});
		} else {
			const user = AppConstants.SERVICE_USER;
			const facts = Platform.isLinux() ? await SystemFacts.gather(user) : { userExists: true };
			steps = InstallPlan.uninstall({ binaryTarget, configPath, user, purge, facts });
		}

		await PlanRunner.run(steps, { dryRun });
		if (dryRun) return;

		Logger.info(`Uninstalled ${AppConstants.APP_NAME}.`);
		Logger.info(
			purge
				? `Deleted ${configPath}. The agent stays registered in the dashboard; delete it there too.`
				: Platform.isWindows()
					? `Kept ${configPath} (administrators only). Delete it with: Remove-Item "${configPath}"`
					: `Kept ${configPath} (root-only). Delete it with: sudo rm ${configPath}`,
		);
	}
}
