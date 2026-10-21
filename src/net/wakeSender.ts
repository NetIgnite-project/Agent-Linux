import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { Logger } from "../utils/logger";
import type { MacAddress } from "./macAddress";
import { MagicPacket } from "./magicPacket";

/** Sends Wake-on-LAN magic packets over UDP broadcast. */
export class WakeSender {
	static readonly ROUNDS = 3;
	static readonly ROUND_INTERVAL_MS = 100;

	/**
	 * Sends the magic packet for `mac` to UDP `port` on every broadcast target (by default the
	 * limited broadcast and each interface's directed broadcast), {@link WakeSender.ROUNDS} times.
	 * Fails only if not a single packet could be sent.
	 */
	static async send(
		mac: MacAddress,
		port: number,
		targets: string[] = MagicPacket.broadcastTargets(networkInterfaces()),
	) {
		const packet = MagicPacket.build(mac);
		const socket = createSocket({ type: "udp4", reuseAddr: true });

		let sent = 0;
		let lastError: unknown = null;
		try {
			await new Promise<void>((resolve, reject) => {
				socket.once("error", reject);
				socket.bind(0, () => {
					socket.off("error", reject);
					resolve();
				});
			});
			socket.setBroadcast(true);

			for (let round = 0; round < WakeSender.ROUNDS; round++) {
				if (round > 0) await Bun.sleep(WakeSender.ROUND_INTERVAL_MS);

				for (const target of targets) {
					try {
						await WakeSender.sendTo(socket, packet, port, target);
						sent++;
					} catch (error) {
						lastError = error;
						Logger.debug(`Magic packet to ${target}:${port} failed:`, error);
					}
				}
			}
		} finally {
			socket.close();
		}

		if (sent === 0) {
			const reason = lastError instanceof Error ? lastError.message : String(lastError);
			throw new Error(`Couldn't send the magic packet: ${reason}`);
		}
		Logger.info(`Sent Wake-on-LAN to ${mac} (port ${port}, ${targets.join(", ")})`);
	}

	private static sendTo(socket: Socket, packet: Uint8Array, port: number, address: string) {
		return new Promise<void>((resolve, reject) => {
			socket.send(packet, port, address, (error) => (error ? reject(error) : resolve()));
		});
	}
}
