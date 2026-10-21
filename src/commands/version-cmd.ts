/**
 * VersionCMD — prints the baked-in `APP_VERSION` (set at compile time via
 * `--define "process.env.APP_VERSION=..."`). See docs/11-cli-and-infra.md of the style guide.
 */
import { CLIBaseCommand } from "@cleverjs/cli";
import { Logger } from "../utils/logger";

export class VersionCMD extends CLIBaseCommand {
	constructor() {
		super({
			name: "version",
			description: "Prints the version of the tool.",
			aliases: ["-v", "--version"],
		});
	}

	async run() {
		const version = process.env.APP_VERSION || "unknown";
		Logger.log(`NetIgnite Agent ${version}`);
		return true;
	}
}
