import { CLIApp, type CLICMDExecEnv, type CLICommandArg, CLICommandContext } from "@cleverjs/cli";

/**
 * `CLIApp.handle()` lower-cases every argument, which would break config paths and server URLs
 * with a sub-path (`https://example.com/NetIgnite`). This variant passes arguments through as
 * typed; command names are still matched case-insensitively.
 */
export class CaseSensitiveCLIApp<
	FlagSpecsT extends CLICommandArg.Flag.SpecList = CLICommandArg.Flag.SpecList,
> extends CLIApp<FlagSpecsT> {
	override async handle(input: string | string[], env: CLICMDExecEnv = "shell") {
		const ctx = new CLICommandContext({
			raw_args: [],
			raw_parent_args: [],
			environment: env,
			logger: this.logger,
			state: { ...this.defaultState },
		});

		const args = typeof input === "string" ? input.trim().split(" ").filter(Boolean) : [...input];
		const success = await this.dispatch(args, ctx);

		const exitOnError =
			this.settings.exitOnError || (this.settings.exitOnError === undefined && env === "shell");
		if (!success && exitOnError) process.exit(1);
	}
}
