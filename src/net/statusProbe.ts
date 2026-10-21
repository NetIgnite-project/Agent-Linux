import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import type { AgentProtocol } from "../protocol/agentProtocol";
import { Logger } from "../utils/logger";
import { Platform } from "../utils/platform";
import { MacAddress } from "./macAddress";
import { NeighborTable } from "./neighborTable";
import { Ping } from "./ping";
import { TcpProbe } from "./tcpProbe";

/**
 * Answers STATUS requests: is a device on the network up? Online if any requested probe (ICMP
 * echo, TCP connect) answers on any of the target's addresses. For `link_local` targets the
 * kernel's neighbor table counts too. Everything finishes within {@link StatusProbe.BUDGET_MS};
 * the server gives up after 5 s (6 s for its background checks).
 */
export class StatusProbe {
	static readonly BUDGET_MS = 4500;
	/** At most this many addresses are probed per request. */
	static readonly MAX_ADDRESSES = 8;
	static readonly NEIGHBOR_TIMEOUT_MS = 1000;

	constructor(private readonly deps: StatusProbe.Deps = StatusProbe.systemDeps()) {}

	async check(request: AgentProtocol.StatusRequest, budgetMs = StatusProbe.BUDGET_MS) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), budgetMs);
		});

		try {
			return await Promise.race([this.run(request), deadline]);
		} catch (error) {
			Logger.warn("Status check failed:", error);
			return false;
		} finally {
			clearTimeout(timer);
		}
	}

	private async run(request: AgentProtocol.StatusRequest): Promise<boolean> {
		const { target } = request;
		let addresses: string[];

		if (target.type === "link_local") {
			const mac = MacAddress.parse(target.mac);
			if (!mac) return false;

			const neighbors = await this.deps.neighbors();
			if (NeighborTable.isLive(neighbors, mac)) {
				Logger.debug(`${mac} is in the neighbor table as reachable`);
				return true;
			}
			addresses = StatusProbe.linkLocalCandidates(mac, this.deps.interfaces(), neighbors);
		} else if (target.type === "ip") {
			addresses = StatusProbe.scopeLinkLocal(target.address, this.deps.interfaces());
		} else {
			addresses = await this.deps.lookup(target.host);
			if (addresses.length === 0) {
				Logger.debug(`${target.host} doesn't resolve`);
				return false;
			}
		}

		addresses = [...new Set(addresses)].slice(0, StatusProbe.MAX_ADDRESSES);
		Logger.debug(`Probing ${addresses.join(", ")}`);

		const probes: Promise<boolean>[] = [];
		for (const address of addresses) {
			if (request.icmp) probes.push(this.deps.ping(address));
			if (request.tcp_port) probes.push(this.deps.tcp(address, request.tcp_port));
		}
		return await StatusProbe.anyTrue(probes);
	}

	/** Resolves true as soon as one probe does, false once all said no. */
	static anyTrue(probes: Promise<boolean>[]): Promise<boolean> {
		if (probes.length === 0) return Promise.resolve(false);
		return Promise.any(
			probes.map((probe) =>
				probe.then((online) => (online ? true : Promise.reject(new Error("no answer")))),
			),
		).catch(() => false);
	}

	/** Names of the external interfaces that have IPv6. */
	static ipv6Interfaces(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>) {
		return Object.entries(interfaces)
			.filter(([, entries]) =>
				(entries ?? []).some((entry) => !entry.internal && entry.family === "IPv6"),
			)
			.map(([name]) => name);
	}

	/**
	 * Addresses to probe for a MAC: its EUI-64 link-local address on every IPv6 interface, plus
	 * every address the neighbor table knows for it (IPv4 included), unless the entry failed.
	 */
	static linkLocalCandidates(
		mac: MacAddress,
		interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
		neighbors: NeighborTable.Entry[],
	) {
		const linkLocal = mac.linkLocalIPv6();
		const addresses = StatusProbe.ipv6Interfaces(interfaces).map((name) => `${linkLocal}%${name}`);

		for (const entry of NeighborTable.entriesOf(neighbors, mac)) {
			if (entry.state === "FAILED" || entry.state === "INCOMPLETE") continue;
			const scoped = entry.address.toLowerCase().startsWith("fe80:") && entry.dev;
			addresses.push(scoped ? `${entry.address}%${entry.dev}` : entry.address);
		}
		return addresses;
	}

	/**
	 * A link-local IPv6 address only means something together with an interface. Without a zone
	 * it is tried on every IPv6 interface; any other address is returned unchanged.
	 */
	static scopeLinkLocal(address: string, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>) {
		const isLinkLocal = isIP(address) === 6 && /^fe[89ab][0-9a-f]:/i.test(address);
		if (!isLinkLocal || address.includes("%")) return [address];
		return StatusProbe.ipv6Interfaces(interfaces).map((name) => `${address}%${name}`);
	}

	/** The real probes. */
	static systemDeps(): StatusProbe.Deps {
		return {
			ping: (address) => Ping.probe(address),
			tcp: (address, port) => TcpProbe.probe(address, port),
			lookup: async (host) => {
				try {
					const results = await lookup(host, { all: true });
					return results.map((result) => result.address);
				} catch {
					return [];
				}
			},
			neighbors: () => StatusProbe.readNeighbors(),
			interfaces: () => networkInterfaces(),
		};
	}

	/** `ip neigh show`; an empty table if `ip` isn't there (or this isn't Linux). */
	static async readNeighbors(): Promise<NeighborTable.Entry[]> {
		if (!Platform.isLinux()) return [];
		try {
			const child = Bun.spawn(["ip", "neigh", "show"], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
				timeout: StatusProbe.NEIGHBOR_TIMEOUT_MS,
			});
			const [output] = await Promise.all([new Response(child.stdout).text(), child.exited]);
			return NeighborTable.parse(output);
		} catch (error) {
			Logger.debug("Couldn't read the neighbor table:", error);
			return [];
		}
	}
}

export namespace StatusProbe {
	/** What the probe needs from the system; tests replace it. */
	export type Deps = {
		ping(address: string): Promise<boolean>;
		tcp(address: string, port: number): Promise<boolean>;
		lookup(host: string): Promise<string[]>;
		neighbors(): Promise<NeighborTable.Entry[]>;
		interfaces(): NodeJS.Dict<NetworkInterfaceInfo[]>;
	};
}
