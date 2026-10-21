import type { NetworkInterfaceInfo } from "node:os";
import type { MacAddress } from "./macAddress";

/** Wake-on-LAN magic packets and where to send them. */
export class MagicPacket {
	static readonly SIZE = 102;
	static readonly LIMITED_BROADCAST = "255.255.255.255";

	/** 6 × `0xFF`, then the MAC address 16 times. */
	static build(mac: MacAddress) {
		const packet = new Uint8Array(MagicPacket.SIZE);
		packet.fill(0xff, 0, 6);
		for (let repeat = 0; repeat < 16; repeat++) {
			packet.set(mac.bytes, 6 + repeat * 6);
		}
		return packet;
	}

	/** The directed broadcast address of an IPv4 network, e.g. `192.168.1.20/24` → `192.168.1.255`. */
	static directedBroadcast(address: string, netmask: string) {
		const ip = MagicPacket.parseIPv4(address);
		const mask = MagicPacket.parseIPv4(netmask);
		if (ip === null || mask === null) return null;

		const broadcast = ((ip & mask) | ~mask) >>> 0;
		return [24, 16, 8, 0].map((shift) => (broadcast >>> shift) & 0xff).join(".");
	}

	/**
	 * Every address a magic packet goes to: the limited broadcast plus the directed broadcast of
	 * each external IPv4 network (`os.networkInterfaces()`), without duplicates. Directed
	 * broadcasts make sure the packet leaves through every interface, not just the default route.
	 */
	static broadcastTargets(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>) {
		const targets = new Set<string>([MagicPacket.LIMITED_BROADCAST]);

		for (const entries of Object.values(interfaces)) {
			for (const entry of entries ?? []) {
				if (entry.internal || entry.family !== "IPv4") continue;
				// A /32 (point-to-point, VPN) has no broadcast address of its own.
				if (entry.netmask === "255.255.255.255") continue;

				const broadcast = MagicPacket.directedBroadcast(entry.address, entry.netmask);
				if (broadcast) targets.add(broadcast);
			}
		}

		return [...targets];
	}

	private static parseIPv4(text: string) {
		const parts = text.split(".");
		if (parts.length !== 4) return null;

		let value = 0;
		for (const part of parts) {
			if (!/^\d{1,3}$/.test(part)) return null;
			const octet = Number(part);
			if (octet > 255) return null;
			value = value * 256 + octet;
		}
		return value >>> 0;
	}
}
