import { CLIBaseCommand, CLICommandArg, type CLICommandArgParser } from "@cleverjs/cli";
import { ConnectionCheck } from "../agent/connectionCheck";
import { AgentConfig } from "../config/agentConfig";
import { MacFacts } from "../install/macos/macFacts";
import { MacFiles } from "../install/macos/macFiles";
import { SystemFacts } from "../install/systemFacts";
import { WindowsFacts } from "../install/windows/windowsFacts";
import { WindowsFiles } from "../install/windows/windowsFiles";
import { ServerUrl } from "../net/serverUrl";
import { AgentProtocol } from "../protocol/agentProtocol";
import { CommandFlags } from "../utils/commandFlags";
import { reportError } from "../utils/errors";
import { Logger } from "../utils/logger";
import { Platform } from "../utils/platform";

const ARGS = CLICommandArg.defineCLIArgSpecs({ flags: [CommandFlags.CONFIG] });

/** `status`: the config (without the secret), the service state and a connection check. */
export class StatusCMD extends CLIBaseCommand<typeof ARGS> {
	static readonly ARGS = ARGS;

	constructor() {
		super({
			name: "status",
			description: "Show the pairing, the service state and whether the server is reachable.",
			args: ARGS,
		});
	}

	async run(args: CLICommandArgParser.ParsedArgs<typeof ARGS>) {
		const configPath = args.flags.config;

		let serviceActive = false;
		if (Platform.isWindows()) {
			const state = await WindowsFacts.taskState();
			serviceActive = state === "Running";
			Logger.log(`Service:      ${state} (scheduled task "${WindowsFiles.TASK_NAME}")`);
		} else if (Platform.isMac()) {
			const state = await MacFacts.serviceState();
			serviceActive = state === "running";
			Logger.log(`Service:      ${state} (launchd ${MacFiles.LABEL})`);
		} else if (Platform.isLinux() && (await SystemFacts.systemdRunning())) {
			const state = await SystemFacts.serviceState();
			serviceActive = state.active === "active";
			Logger.log(`Service:      ${state.active} (${state.enabled})`);
		} else {
			Logger.log(
				`Service:      not available (needs Linux with systemd, macOS or Windows; this is ${process.platform})`,
			);
		}

		let config: AgentConfig.Data;
		try {
			config = await AgentConfig.load(configPath);
		} catch (error) {
			reportError(error);
			return false;
		}

		const server = ServerUrl.parse(config.server);
		Logger.log(`Config:       ${configPath}`);
		Logger.log(`Server:       ${server.toString()}`);
		Logger.log(`Agent:        ${config.agent_id}`);
		Logger.log(`Wake-on-LAN:  ${config.wol.enabled ? "on" : "off"}`);

		const health = await ConnectionCheck.health(server);
		Logger.log(`Server check: ${health.detail}`);

		if (serviceActive) {
			Logger.log("Credential:   not checked (the running service holds the connection)");
		} else if (health.ok) {
			const credential = await ConnectionCheck.credential(
				server.wsUrl(AgentProtocol.WS_PATH),
				AgentConfig.credential(config),
			);
			Logger.log(`Credential:   ${credential.detail}`);
		}

		return true;
	}
}
