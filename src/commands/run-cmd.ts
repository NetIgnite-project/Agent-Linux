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
import { SshKeys } from "../ssh/sshKeys";
import { SshRemote } from "../ssh/sshRemote";
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

		// SSH logins to other devices: Wake-on-LAN mode, the agent's keys, and TLS to the server.
		const sshUnavailable = !wolEnabled
			? "Wake-on-LAN mode is off"
			: !config.ssh_keys
				? `This agent has no SSH keys yet: run "sudo ${AppConstants.BINARY_NAME} install" again`
				: !server.secure && (options.sshRequiresTls ?? true)
					? "SSH needs an https:// server address (the agent connects without TLS)"
					: null;
		const ssh =
			sshUnavailable || !config.ssh_keys
				? null
				: options.ssh === undefined
					? new SshRemote(config.ssh_keys)
					: options.ssh;
		if (wolEnabled && sshUnavailable)
			Logger.warn(`No shutdown or reboot of other devices over SSH: ${sshUnavailable}`);
		const sshKeys = ssh && config.ssh_keys ? SshKeys.publicKeys(config.ssh_keys) : null;

		const defaultHostControl: HostControl.Perform | null = linux ? HostControl.perform : null;
		const handler = new RequestHandler({
			wolEnabled,
			statusProbe: options.statusProbe ?? new StatusProbe(),
			wake: options.wake ?? ((mac, port) => WakeSender.send(mac, port)),
			ssh,
			sshUnavailable: sshUnavailable ?? undefined,
			hostControl: options.hostControl === undefined ? defaultHostControl : options.hostControl,
			// Only for the real executor: an injected one (tests) runs nothing on this machine.
			hostControlCheck: options.hostControl === undefined && linux ? HostControl.check : null,
			hostControlDelayMs: options.hostControlDelayMs,
		});

		return new AgentClient({
			url: server.wsUrl(AgentProtocol.WS_PATH),
			credential: AgentConfig.credential(config),
			agentID: config.agent_id,
			hello: () => HostInfo.hello({ wol: wolEnabled, sshKeys }),
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
		/** Replaces the SSH client (tests); still only used with keys and TLS. */
		ssh?: RequestHandler.SshClient | null;
		/** Tests against a plain-WebSocket fake server only; no CLI flag sets it. */
		sshRequiresTls?: boolean;
		/** `null`: host control unsupported. Default: the systemd units on Linux. */
		hostControl?: HostControl.Perform | null;
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
