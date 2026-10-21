import { isIP } from "node:net";
import { MacAddress } from "./macAddress";

/**
 * The kernel's neighbor table (ARP for IPv4, NDP for IPv6), read with `ip neigh show`. An entry
 * in `REACHABLE`, `DELAY` or `PROBE` means the neighbor answered recently; `STALE` only means it
 * answered at some point.
 */
export class NeighborTable {
	static readonly LIVE_STATES = ["REACHABLE", "DELAY", "PROBE"] as const;
	static readonly KNOWN_STATES = [
		"PERMANENT",
		"NOARP",
		"REACHABLE",
		"STALE",
		"NONE",
		"INCOMPLETE",
		"DELAY",
		"PROBE",
		"FAILED",
	] as const;

	/**
	 * Parses `ip neigh show` output, e.g.
	 * `192.168.1.20 dev eth0 lladdr 52:54:00:12:34:56 REACHABLE` or
	 * `fe80::1 dev eth0 lladdr 52:54:00:12:34:56 router STALE`. Lines it can't read are skipped.
	 */
	static parse(output: string): NeighborTable.Entry[] {
		const entries: NeighborTable.Entry[] = [];

		for (const line of output.split("\n")) {
			const tokens = line.trim().split(/\s+/);
			const address = tokens[0];
			if (!address || isIP(address) === 0) continue;

			let dev: string | null = null;
			let mac: MacAddress | null = null;
			let state: string | null = null;

			for (let i = 1; i < tokens.length; i++) {
				const token = tokens[i] ?? "";
				if (token === "dev") {
					dev = tokens[++i] ?? null;
				} else if (token === "lladdr") {
					mac = MacAddress.parse(tokens[++i] ?? "");
				} else if ((NeighborTable.KNOWN_STATES as readonly string[]).includes(token)) {
					state = token;
				}
			}

			entries.push({ address, dev, mac, state });
		}

		return entries;
	}

	/** Entries of a MAC address, in any state. */
	static entriesOf(entries: NeighborTable.Entry[], mac: MacAddress) {
		return entries.filter((entry) => entry.mac?.equals(mac));
	}

	/** Whether the table shows that a MAC address answered recently. */
	static isLive(entries: NeighborTable.Entry[], mac: MacAddress) {
		return NeighborTable.entriesOf(entries, mac).some(
			(entry) =>
				entry.state !== null && (NeighborTable.LIVE_STATES as readonly string[]).includes(entry.state),
		);
	}
}

export namespace NeighborTable {
	export type Entry = {
		address: string;
		dev: string | null;
		mac: MacAddress | null;
		state: string | null;
	};
}
