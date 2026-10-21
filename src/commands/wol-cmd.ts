import { CLIBaseCommand, CLICommandArg, type CLICommandArgParser } from "@cleverjs/cli";
import { MacAddress } from "../net/macAddress";
import { MagicPacket } from "../net/magicPacket";
import { WakeSender } from "../net/wakeSender";
import { AppError, reportError } from "../utils/errors";
import { Logger } from "../utils/logger";

const ARGS = CLICommandArg.defineCLIArgSpecs({
	args: [
		{
			name: "mac",
			type: "string",
			required: true,
			description: "MAC address of the device to wake, e.g. AA:BB:CC:DD:EE:FF",
		},
	],
	flags: [
		{
			name: "port",
			type: "number",
			default: 9,
			description: "UDP port of the magic packet (default 9; some devices listen on 7).",
		},
	],
});

/**
 * `wol <mac>`: sends a Wake-on-LAN magic packet from this machine, the same way a WAKE request
 * does. For testing; needs no config and no server.
 */
export class WolCMD extends CLIBaseCommand<typeof ARGS> {
	static readonly ARGS = ARGS;

	constructor() {
		super({
			name: "wol",
			description: "Send a Wake-on-LAN packet to a MAC address from here (for testing).",
			args: ARGS,
		});
	}

	async run(args: CLICommandArgParser.ParsedArgs<typeof ARGS>) {
		try {
			const mac = MacAddress.parse(args.args.mac);
			if (!mac) {
				throw new AppError(`"${args.args.mac}" is not a MAC address (e.g. AA:BB:CC:DD:EE:FF)`);
			}
			const port = args.flags.port;
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				throw new AppError(`Invalid port ${port}`);
			}

			await WakeSender.send(mac, port);
			Logger.info(
				`Sent ${WakeSender.ROUNDS} × ${MagicPacket.SIZE}-byte magic packets for ${mac} to UDP port ${port}.`,
			);
			return true;
		} catch (error) {
			reportError(error);
			return false;
		}
	}
}
