import { resolve } from "node:path";
import { CLIBaseCommand, CLICommandArg, type CLICommandArgParser } from "@cleverjs/cli";
import { AgentConfig } from "../config/agentConfig";
import { Enrollment } from "../enroll/enrollment";
import { PlanRunner } from "../install/planRunner";
import { SystemFacts } from "../install/systemFacts";
import { ServerUrl } from "../net/serverUrl";
import { CommandFlags } from "../utils/commandFlags";
import { AppConstants } from "../utils/constants";
import { AppError, reportError } from "../utils/errors";
import { Logger } from "../utils/logger";
import { Platform } from "../utils/platform";

const ARGS = CLICommandArg.defineCLIArgSpecs({
	args: [
		{
			name: "server-url",
			type: "string",
			required: true,
			description: "The NetIgnite server, e.g. https://netignite.example.com",
		},
		{
			name: "enrollment-token",
			type: "string",
			required: true,
			description: "Single-use token from the agent's page in the dashboard (netignite_enroll_…)",
		},
	],
	flags: [
		{
			name: "wol",
			type: "boolean",
			description: "Turn on Wake-on-LAN mode: wake and check other devices on this network.",
		},
		CommandFlags.CONFIG,
	],
});

/**
 * `pair <server-url> <enrollment-token>`: enrolls with the server and writes the config. The
 * secret is generated here; neither it nor the token is ever printed.
 */
export class PairCMD extends CLIBaseCommand<typeof ARGS> {
	static readonly ARGS = ARGS;

	constructor() {
		super({
			name: "pair",
			description: "Pair this machine with a NetIgnite server (writes the config).",
			args: ARGS,
		});
	}

	async run(args: CLICommandArgParser.ParsedArgs<typeof ARGS>) {
		try {
			await this.pair(
				args.args["server-url"],
				args.args["enrollment-token"].trim(),
				args.flags.config,
				args.flags.wol,
			);
			return true;
		} catch (error) {
			reportError(error);
			return false;
		}
	}

	private async pair(serverText: string, token: string, configPath: string, wolFlag: boolean) {
		const server = ServerUrl.parse(serverText);
		if (!Enrollment.isEnrollmentToken(token)) {
			throw new AppError(
				`That doesn't look like an enrollment token (they start with "${Enrollment.ENROLLMENT_TOKEN_PREFIX}"). Copy the pair command from the agent's page in the dashboard.`,
			);
		}

		let previous: AgentConfig.Data | null = null;
		try {
			previous = await AgentConfig.load(configPath);
		} catch {
			// Not paired yet (or a broken config, which gets replaced).
		}

		// The token works once: make sure the result can be stored before spending it.
		await AgentConfig.assertWritable(configPath);

		const wol = wolFlag || (previous?.wol.enabled ?? false);
		const root = Platform.isLinux() && Platform.isRoot();
		const serviceUser = root ? await SystemFacts.userIds(AppConstants.SERVICE_USER) : null;

		Logger.info(`Pairing with ${server.toString()} ...`);
		const secret = Enrollment.generateSecret();
		const result = await Enrollment.enroll(server, token, secret);

		try {
			await AgentConfig.save(
				configPath,
				{
					server: server.toString(),
					agent_id: result.agent_id,
					token_id: result.token_id,
					secret,
					wol: { enabled: wol },
				},
				{ serviceUser },
			);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new AppError(
				`Paired as agent ${result.agent_id}, but writing ${configPath} failed: ${reason}. The enrollment token is used up; create a new one in the dashboard and pair again.`,
			);
		}

		Logger.info(`Paired as agent ${result.agent_id}. Config written to ${configPath}.`);
		Logger.info(
			`Wake-on-LAN mode is ${wol ? "on" : "off"}${wol && !wolFlag ? " (kept from the previous config)" : ""}.`,
		);
		if (previous) Logger.info(`This replaced the previous pairing (agent ${previous.agent_id}).`);

		await PairCMD.applyToService(configPath, root);
	}

	/** Restarts an installed service that uses this config, so it connects with the new credential. */
	private static async applyToService(configPath: string, root: boolean) {
		const installedConfig = root ? await SystemFacts.installedConfigPath() : null;
		if (!installedConfig) {
			Logger.info(
				`Next: sudo ${AppConstants.BINARY_NAME} install  (runs the agent as a systemd service)`,
			);
			return;
		}
		if (installedConfig !== resolve(configPath)) {
			Logger.info(
				`The installed service uses ${installedConfig}, not this config; it was left alone.`,
			);
			return;
		}

		const state = await SystemFacts.serviceState();
		if (state.enabled !== "enabled") {
			Logger.info(
				`The service is ${state.enabled}. Start it with: sudo systemctl enable --now ${AppConstants.SERVICE_NAME}`,
			);
			return;
		}

		// `restart`, not `try-restart`: after a rejected credential the service has stopped.
		await PlanRunner.run(
			[{ type: "run", argv: ["systemctl", "restart", AppConstants.SERVICE_NAME] }],
			{
				dryRun: false,
			},
		);
		Logger.info("The service was restarted with the new credential.");
	}
}
