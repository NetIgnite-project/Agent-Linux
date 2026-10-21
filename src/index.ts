import { CLICommandArg } from "@cleverjs/cli";
import { InstallCMD } from "./commands/install-cmd";
import { PairCMD } from "./commands/pair-cmd";
import { RunCMD } from "./commands/run-cmd";
import { StatusCMD } from "./commands/status-cmd";
import { UninstallCMD } from "./commands/uninstall-cmd";
import { VersionCMD } from "./commands/version-cmd";
import { WolCMD } from "./commands/wol-cmd";
import { WolModeCMD } from "./commands/wol-mode-cmd";
import { CaseSensitiveCLIApp } from "./utils/caseSensitiveCLIApp";
import { Logger } from "./utils/logger";

new CaseSensitiveCLIApp({
	globalFlags: CLICommandArg.defineCLIFlagSpecs([
		{
			name: "log-level",
			type: "enum",
			allowedValues: ["debug", "info", "warn", "error", "critical"],
			description: "Set the log level for the application.",
			default: "info",
		},
	]),
	logger: Logger,
	exitOnError: true,
})
	.register(new VersionCMD())
	.register(new PairCMD())
	.register(new RunCMD())
	.register(new InstallCMD())
	.register(new UninstallCMD())
	.register(new StatusCMD())
	.register(new WolModeCMD())
	.register(new WolCMD())
	.use(async (args, _ctx, next) => {
		Logger.setLogLevel(args["log-level"]);
		return await next();
	})
	.handle(process.argv.slice(2), "shell");
