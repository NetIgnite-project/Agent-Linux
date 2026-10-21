import { CLIBaseCommand, CLICommandArg, type CLICommandArgParser } from "@cleverjs/cli";
import { AgentClient } from "../agent/agentClient";
import { HostControl } from "../agent/hostControl";
import { HostInfo } from "../agent/hostInfo";
import { RequestHandler } from "../agent/requestHandler";
import { AgentConfig } from "../config/agentConfig";
import { SystemFiles } from "../install/systemFiles";
import { ServerUrl } from "../net/serverUrl";
import { StatusProbe } from "../net/statusProbe";
import { WakeSender } from "../net/wakeSender";
import { AgentProtocol } from "../protocol/agentProtocol";
import { CommandFlags } from "../utils/commandFlags";
import { AppConstants } from "../utils/constants";
import { reportError } from "../utils/errors";
import { Logger } from "../utils/logger";
import { Platform } from "../utils/platform";

const ARGS = CLICommandArg.defineCLIArgSpecs({
	flags: [
		CommandFlags.CONFIG,
		{
			name: "wol",
			type: "boolean",
			description: "Wake-on-LAN mode for this run, even if the config has it off.",
		},
	],
});

/**
 * `run`: the daemon the systemd service starts. Stops cleanly on SIGTERM / SIGINT. Exits with
 * {@link SystemFiles.EXIT_CREDENTIAL_REJECTED} when the server rejects the credential, which the
 * unit doesn't restart.
 */
export class RunCMD extends CLIBaseCommand<typeof ARGS> {
	static readonly ARGS = ARGS;

	constructor() {
		super({
			name: "run",
			description: "Run the agent in the foreground (what the service runs).",
			args: ARGS,
		});
	}

	async run(args: CLICommandArgParser.ParsedArgs<typeof ARGS>) {
		let client: AgentClient;
		try {
			const config = await AgentConfig.load(args.flags.config);
			client = RunCMD.createClient(config, { wol: args.flags.wol || config.wol.enabled });
		} catch (error) {
			reportError(error);
			return false;
		}

		let onSignal: (signal: NodeJS.Signals) => void = () => {};
		const signal = new Promise<NodeJS.Signals>((resolve) => {
			onSignal = resolve;
		});
		process.on("SIGTERM", onSignal);
		process.on("SIGINT", onSignal);

		client.start();
		const outcome = await Promise.race([signal, client.finished]);
		process.off("SIGTERM", onSignal);
		process.off("SIGINT", onSignal);

		if (typeof outcome === "string") {
			Logger.info(`${outcome} received, disconnecting`);
			await client.stop();
			return true;
		}

		if (outcome.type === "rejected") {
			Logger.error(
				`Not retrying. Pair this machine again with a new enrollment token from the dashboard: sudo ${AppConstants.BINARY_NAME} pair <server-url> <enrollment-token>`,
			);
			process.exit(SystemFiles.EXIT_CREDENTIAL_REJECTED);
		}
		return true;
	}

	/** Wires the agent together. Tests replace the parts that touch the system. */
	static createClient(config: AgentConfig.Data, options: RunCMD.ClientOptions = {}) {
		const server = ServerUrl.parse(config.server);
		const wolEnabled = options.wol ?? config.wol.enabled;
		const linux = Platform.isLinux();

		Logger.info(
			`${AppConstants.APP_NAME} ${AppConstants.version()} starting (agent ${config.agent_id}, Wake-on-LAN mode ${wolEnabled ? "on" : "off"})`,
		);
		if (!linux) {
			Logger.warn(
				`${AppConstants.BINARY_NAME} is made for Linux: on ${process.platform}, shutdown/reboot and ICMP probes don't work.`,
			);
		}

		const defaultHostControl: HostControl.Executor | null = linux ? HostControl.execute : null;
		const handler = new RequestHandler({
			wolEnabled,
			statusProbe: options.statusProbe ?? new StatusProbe(),
			wake: options.wake ?? ((mac, port) => WakeSender.send(mac, port)),
			hostControl: options.hostControl === undefined ? defaultHostControl : options.hostControl,
			hostControlDelayMs: options.hostControlDelayMs,
		});

		return new AgentClient({
			url: server.wsUrl(AgentProtocol.WS_PATH),
			credential: AgentConfig.credential(config),
			agentID: config.agent_id,
			hello: () => HostInfo.hello(wolEnabled),
			hostStatus: () => HostInfo.status(),
			handler,
			...options.client,
		});
	}
}

export namespace RunCMD {
	export type ClientOptions = {
		/** Overrides the config's Wake-on-LAN mode. */
		wol?: boolean;
		statusProbe?: RequestHandler.Options["statusProbe"];
		wake?: RequestHandler.Options["wake"];
		/** `null`: host control unsupported. Default: `systemctl` on Linux. */
		hostControl?: HostControl.Executor | null;
		hostControlDelayMs?: number;
		/** Timing and probe overrides for the connection. */
		client?: Pick<
			AgentClient.Options,
			| "reconnectMinMs"
			| "reconnectMaxMs"
			| "silenceTimeoutMs"
			| "hostStatusIntervalMs"
			| "probeUpgrade"
		>;
	};
}
