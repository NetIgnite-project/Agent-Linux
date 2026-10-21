import { resolve } from "node:path";
import { AppConstants } from "./constants";

/** Flags several commands share. */
export namespace CommandFlags {
	export const CONFIG = {
		name: "config",
		type: "string",
		default: AppConstants.DEFAULT_CONFIG_PATH,
		description: `Path of the config file (default ${AppConstants.DEFAULT_CONFIG_PATH}).`,
	} as const;

	export const DRY_RUN = {
		name: "dry-run",
		type: "boolean",
		description: "Only print what would be done.",
	} as const;
}

/** The config path as the service sees it: absolute. */
export function serviceConfigPath(path: string) {
	return resolve(path);
}
