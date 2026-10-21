import { Platform } from "./platform";

const programData = process.env.ProgramData || "C:\\ProgramData";
const programFiles = process.env.ProgramFiles || "C:\\Program Files";

export namespace AppConstants {
	export const APP_NAME = "NetIgnite Agent";

	export const APP_ENV_PREFIX = "NETIGNITE_AGENT";

	/** Prefix of NetIgnite credentials (`netignite_agent_…`, `netignite_enroll_…`). */
	export const APP_KEYS_PREFIX = "netignite";

	export const BINARY_NAME = "netignite-agent";

	/** The agent kind the server knows this agent as: `linux`, `windows` or `macos`. */
	export const AGENT_KIND = Platform.kind();

	export const DEFAULT_CONFIG_PATH = Platform.isWindows()
		? `${programData}\\NetIgnite\\agent.json`
		: Platform.isMac()
			? "/usr/local/etc/netignite/agent.json"
			: "/etc/netignite/agent.json";

	/** Where `install` puts the binary the service runs. */
	export const INSTALL_BINARY_PATH = Platform.isWindows()
		? `${programFiles}\\NetIgnite\\${BINARY_NAME}.exe`
		: `/usr/local/bin/${BINARY_NAME}`;

	/** Linux: the systemd unit, and its runtime directory. */
	export const SERVICE_NAME = "netignite-agent";

	/** Linux: the system user the service runs as. */
	export const SERVICE_USER = "netignite";

	/** The version baked in at compile time, or a dev placeholder under `bun run`. */
	export function version() {
		return process.env.APP_VERSION || "0.0.0-dev";
	}
}
