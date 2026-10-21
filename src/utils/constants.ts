export namespace AppConstants {
	export const APP_NAME = "NetIgnite Agent";

	export const APP_ENV_PREFIX = "NETIGNITE_AGENT";

	/** Prefix of NetIgnite credentials (`netignite_agent_…`, `netignite_enroll_…`). */
	export const APP_KEYS_PREFIX = "netignite";

	export const BINARY_NAME = "netignite-agent";

	/** The agent kind the server knows this agent as. */
	export const AGENT_KIND = "linux";

	export const DEFAULT_CONFIG_PATH = "/etc/netignite/agent.json";

	/** Where `install` puts the binary the service runs. */
	export const INSTALL_BINARY_PATH = "/usr/local/bin/netignite-agent";

	export const SERVICE_NAME = "netignite-agent";

	/** System user the service runs as. */
	export const SERVICE_USER = "netignite";

	/** The version baked in at compile time, or a dev placeholder under `bun run`. */
	export function version() {
		return process.env.APP_VERSION || "0.0.0-dev";
	}
}
