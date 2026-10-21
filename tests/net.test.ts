import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { createServer, type Server } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { MacAddress } from "../src/net/macAddress";
import { MagicPacket } from "../src/net/magicPacket";
import { NeighborTable } from "../src/net/neighborTable";
import { Ping } from "../src/net/ping";
import { StatusProbe } from "../src/net/statusProbe";
import { TcpProbe } from "../src/net/tcpProbe";
import { WakeSender } from "../src/net/wakeSender";
import { Logger } from "../src/utils/logger";

Logger.setLogLevel("critical");

function iface(
	address: string,
	netmask: string,
	family: "IPv4" | "IPv6" = "IPv4",
	internal = false,
): NetworkInterfaceInfo {
	return {
		address,
		netmask,
		family,
		internal,
		mac: "52:54:00:12:34:56",
		cidr: null,
		...(family === "IPv6" ? { scopeid: 2 } : {}),
	} as NetworkInterfaceInfo;
}

const INTERFACES: NodeJS.Dict<NetworkInterfaceInfo[]> = {
	lo: [iface("127.0.0.1", "255.0.0.0", "IPv4", true), iface("::1", "ffff::", "IPv6", true)],
	eth0: [
		iface("192.168.1.20", "255.255.255.0"),
		iface("fe80::5054:ff:fe12:3456", "ffff:ffff:ffff:ffff::", "IPv6"),
	],
	eth1: [iface("10.0.0.5", "255.255.255.0"), iface("192.168.1.21", "255.255.255.0")],
	wg0: [iface("10.8.0.2", "255.255.255.255")],
};

describe("MacAddress", () => {
	test("parses colon, dash and bare notation", () => {
		const expected = [0xaa, 0xbb, 0xcc, 0x01, 0x02, 0x0f];
		for (const text of [
			"AA:BB:CC:01:02:0F",
			"aa:bb:cc:01:02:0f",
			"aa-bb-cc-01-02-0f",
			"aabbcc01020f",
			"  AA:BB:CC:01:02:0F\n",
		]) {
			expect([...(MacAddress.parse(text)?.bytes ?? [])]).toEqual(expected);
		}
	});

	test("rejects anything else", () => {
		for (const text of [
			"",
			"AA:BB:CC:DD:EE",
			"AA:BB:CC:DD:EE:FF:00",
			"AA:BB-CC:DD:EE:FF",
			"GG:BB:CC:DD:EE:FF",
			"AABB.CCDD.EEFF",
			"A:B:C:D:E:F",
			"aabbccddeef",
			"-a:bb:cc:dd:ee:ff",
		]) {
			expect(MacAddress.parse(text)).toBeNull();
		}
	});

	test("formats as upper-case colon notation and compares", () => {
		const mac = MacAddress.parse("aa-bb-cc-01-02-0f");
		expect(mac?.toString()).toBe("AA:BB:CC:01:02:0F");
		expect(mac?.equals(MacAddress.parse("AABBCC01020F") as MacAddress)).toBe(true);
		expect(mac?.equals(MacAddress.parse("AABBCC01020E") as MacAddress)).toBe(false);
	});

	test("derives the EUI-64 link-local address", () => {
		expect(MacAddress.parse("52:54:00:12:34:56")?.linkLocalIPv6()).toBe("fe80::5054:ff:fe12:3456");
		// The universal/local bit flips the other way, too.
		expect(MacAddress.parse("02:00:00:00:00:01")?.linkLocalIPv6()).toBe("fe80::ff:fe00:1");
	});
});

describe("MagicPacket", () => {
	test("is 6 × 0xFF followed by the MAC 16 times", () => {
		const mac = MacAddress.parse("01:23:45:67:89:AB") as MacAddress;
		const packet = MagicPacket.build(mac);

		const expected = Buffer.concat([
			Buffer.alloc(6, 0xff),
			...Array.from({ length: 16 }, () => Buffer.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab])),
		]);
		expect(packet.length).toBe(102);
		expect(Buffer.from(packet).equals(expected)).toBe(true);
	});

	test("computes directed broadcast addresses", () => {
		expect(MagicPacket.directedBroadcast("192.168.1.20", "255.255.255.0")).toBe("192.168.1.255");
		expect(MagicPacket.directedBroadcast("10.1.2.3", "255.0.0.0")).toBe("10.255.255.255");
		expect(MagicPacket.directedBroadcast("172.16.5.4", "255.255.240.0")).toBe("172.16.15.255");
		expect(MagicPacket.directedBroadcast("300.1.1.1", "255.255.255.0")).toBeNull();
		expect(MagicPacket.directedBroadcast("fe80::1", "ffff::")).toBeNull();
	});

	test("targets the limited broadcast and each external IPv4 network once", () => {
		expect(MagicPacket.broadcastTargets(INTERFACES)).toEqual([
			"255.255.255.255",
			"192.168.1.255",
			"10.0.0.255",
		]);
		expect(MagicPacket.broadcastTargets({})).toEqual(["255.255.255.255"]);
	});
});

describe("WakeSender", () => {
	test("sends the magic packet 3 times to every target", async () => {
		const receiver = createSocket("udp4");
		const received: Buffer[] = [];
		receiver.on("message", (message) => received.push(message));
		const port = await new Promise<number>((resolve) => {
			receiver.bind(0, "127.0.0.1", () => resolve(receiver.address().port));
		});

		try {
			const mac = MacAddress.parse("02:00:00:00:00:01") as MacAddress;
			// Loopback instead of a broadcast, so the test doesn't send anything onto the LAN.
			await WakeSender.send(mac, port, ["127.0.0.1"]);

			const deadline = Date.now() + 2000;
			while (received.length < WakeSender.ROUNDS && Date.now() < deadline) await Bun.sleep(10);

			expect(received).toHaveLength(WakeSender.ROUNDS);
			for (const message of received) {
				expect(message.equals(Buffer.from(MagicPacket.build(mac)))).toBe(true);
			}
		} finally {
			receiver.close();
		}
	});

	test("fails when no packet could be sent", async () => {
		const mac = MacAddress.parse("02:00:00:00:00:01") as MacAddress;
		await expect(WakeSender.send(mac, 9, ["not-an-address.invalid"])).rejects.toThrow(
			"Couldn't send the magic packet",
		);
	});
});

describe("NeighborTable", () => {
	const OUTPUT = [
		"192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:01 REACHABLE",
		"192.168.1.20 dev eth0 lladdr 52:54:00:12:34:56 STALE",
		"192.168.1.30 dev eth0  FAILED",
		"fe80::5054:ff:fe12:3456 dev eth0 lladdr 52:54:00:12:34:56 router DELAY",
		"this is not a neighbor line",
		"",
	].join("\n");

	test("parses `ip neigh show`", () => {
		const entries = NeighborTable.parse(OUTPUT);
		expect(entries).toHaveLength(4);
		expect(entries[0]).toMatchObject({ address: "192.168.1.1", dev: "eth0", state: "REACHABLE" });
		expect(entries[0]?.mac?.toString()).toBe("AA:BB:CC:DD:EE:01");
		expect(entries[2]).toMatchObject({ address: "192.168.1.30", mac: null, state: "FAILED" });
		expect(entries[3]).toMatchObject({ address: "fe80::5054:ff:fe12:3456", state: "DELAY" });
	});

	test("tells live from stale entries", () => {
		const entries = NeighborTable.parse(OUTPUT);
		const mac = MacAddress.parse("52:54:00:12:34:56") as MacAddress;
		expect(NeighborTable.entriesOf(entries, mac)).toHaveLength(2);
		expect(NeighborTable.isLive(entries, mac)).toBe(true);
		expect(NeighborTable.isLive(entries.slice(0, 3), mac)).toBe(false);
	});
});

describe("Ping", () => {
	test("builds a single-echo command that BusyBox understands too", () => {
		expect(Ping.command("192.168.1.20", { hasPing6: true })).toEqual([
			"ping",
			"-c",
			"1",
			"-W",
			"1",
			"-q",
			"192.168.1.20",
		]);
		expect(Ping.command("192.168.1.20", { hasPing6: false })).not.toContain("-n");
	});

	test("uses ping6 or ping -6 for IPv6, zones included", () => {
		expect(Ping.command("fe80::1%eth0", { hasPing6: true })?.slice(0, 1)).toEqual(["ping6"]);
		expect(Ping.command("fe80::1%eth0", { hasPing6: false })?.slice(0, 2)).toEqual(["ping", "-6"]);
		expect(Ping.command("fe80::1%eth0", { hasPing6: false })?.at(-1)).toBe("fe80::1%eth0");
	});

	test("refuses anything but an IP literal", () => {
		expect(Ping.command("example.com", { hasPing6: true })).toBeNull();
		expect(Ping.command("-c", { hasPing6: true })).toBeNull();
	});
});

describe("StatusProbe", () => {
	type Calls = { ping: string[]; tcp: string[]; lookup: string[] };

	function probe(overrides: Partial<StatusProbe.Deps> = {}) {
		const calls: Calls = { ping: [], tcp: [], lookup: [] };
		const deps: StatusProbe.Deps = {
			ping: async (address) => {
				calls.ping.push(address);
				return false;
			},
			tcp: async (address, port) => {
				calls.tcp.push(`${address}:${port}`);
				return false;
			},
			lookup: async (host) => {
				calls.lookup.push(host);
				return [];
			},
			neighbors: async () => [],
			interfaces: () => INTERFACES,
			...overrides,
		};
		if (overrides.ping) {
			const inner = overrides.ping;
			deps.ping = (address) => {
				calls.ping.push(address);
				return inner(address);
			};
		}
		if (overrides.tcp) {
			const inner = overrides.tcp;
			deps.tcp = (address, port) => {
				calls.tcp.push(`${address}:${port}`);
				return inner(address, port);
			};
		}
		return { probe: new StatusProbe(deps), calls };
	}

	test("ip target: pings the address", async () => {
		const { probe: p, calls } = probe({ ping: async (address) => address === "192.168.1.50" });
		expect(await p.check({ target: { type: "ip", address: "192.168.1.50" }, icmp: true })).toBe(true);
		expect(calls.ping).toEqual(["192.168.1.50"]);
		expect(calls.tcp).toEqual([]);
	});

	test("tcp only (the server's ssh check)", async () => {
		const { probe: p, calls } = probe({ tcp: async () => true });
		const online = await p.check({
			target: { type: "ip", address: "192.168.1.50" },
			icmp: false,
			tcp_port: 22,
		});
		expect(online).toBe(true);
		expect(calls.ping).toEqual([]);
		expect(calls.tcp).toEqual(["192.168.1.50:22"]);
	});

	test("a link-local address without zone is tried on every IPv6 interface", async () => {
		const { probe: p, calls } = probe();
		expect(await p.check({ target: { type: "ip", address: "fe80::1" }, icmp: true })).toBe(false);
		expect(calls.ping).toEqual(["fe80::1%eth0"]);
	});

	test("link_local target: a live neighbor entry is enough", async () => {
		const neighbors = NeighborTable.parse("192.168.1.20 dev eth0 lladdr 52:54:00:12:34:56 REACHABLE");
		const { probe: p, calls } = probe({ neighbors: async () => neighbors });
		const online = await p.check({
			target: { type: "link_local", mac: "52:54:00:12:34:56" },
			icmp: true,
		});
		expect(online).toBe(true);
		expect(calls.ping).toEqual([]);
	});

	test("link_local target: probes the EUI-64 address and known addresses", async () => {
		const neighbors = NeighborTable.parse(
			[
				"192.168.1.20 dev eth0 lladdr 52:54:00:12:34:56 STALE",
				"192.168.1.99 dev eth0 lladdr 52:54:00:12:34:56 FAILED",
			].join("\n"),
		);
		const { probe: p, calls } = probe({ neighbors: async () => neighbors });
		const online = await p.check({
			target: { type: "link_local", mac: "52-54-00-12-34-56" },
			icmp: true,
			tcp_port: 80,
		});
		expect(online).toBe(false);
		expect(calls.ping).toEqual(["fe80::5054:ff:fe12:3456%eth0", "192.168.1.20"]);
		expect(calls.tcp).toEqual(["fe80::5054:ff:fe12:3456%eth0:80", "192.168.1.20:80"]);
	});

	test("host target: resolves, then probes every address", async () => {
		const { probe: p, calls } = probe({
			lookup: async () => ["192.168.1.7", "fd00::7", "192.168.1.7"],
			ping: async (address) => address === "fd00::7",
		});
		expect(await p.check({ target: { type: "host", host: "nas.lan" }, icmp: true })).toBe(true);
		expect(calls.ping.sort()).toEqual(["192.168.1.7", "fd00::7"]);
	});

	test("host target that doesn't resolve is offline", async () => {
		const { probe: p, calls } = probe();
		expect(await p.check({ target: { type: "host", host: "nowhere.lan" }, icmp: true })).toBe(false);
		expect(calls.ping).toEqual([]);
	});

	test("answers within the budget even if probes hang", async () => {
		const { probe: p } = probe({ ping: () => new Promise<boolean>(() => {}) });
		const started = Date.now();
		const online = await p.check(
			{ target: { type: "ip", address: "192.168.1.50" }, icmp: true },
			100,
		);
		expect(online).toBe(false);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test("the first positive probe wins", async () => {
		const hang = new Promise<boolean>(() => {});
		expect(await StatusProbe.anyTrue([hang, Promise.resolve(true)])).toBe(true);
		expect(await StatusProbe.anyTrue([Promise.resolve(false), Promise.resolve(false)])).toBe(false);
		expect(await StatusProbe.anyTrue([])).toBe(false);
	});

	test("finishes well within the server's 5 s timeout by default", () => {
		expect(StatusProbe.BUDGET_MS).toBeLessThanOrEqual(4500);
		expect(Ping.PROCESS_TIMEOUT_MS).toBeLessThan(StatusProbe.BUDGET_MS);
		expect(TcpProbe.TIMEOUT_MS).toBeLessThan(StatusProbe.BUDGET_MS);
	});
});

describe("TcpProbe", () => {
	let server: Server;
	let port: number;

	beforeAll(async () => {
		server = createServer((socket) => socket.destroy());
		port = await new Promise<number>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				resolve(typeof address === "object" && address ? address.port : 0);
			});
		});
	});

	afterAll(() => {
		server.close();
	});

	test("an accepted connection means online", async () => {
		expect(await TcpProbe.probe("127.0.0.1", port)).toBe(true);
	});

	test("a refused connection means online too (the host answered)", async () => {
		const closed = createServer();
		const closedPort = await new Promise<number>((resolve) => {
			closed.listen(0, "127.0.0.1", () => {
				const address = closed.address();
				resolve(typeof address === "object" && address ? address.port : 0);
			});
		});
		await new Promise<void>((resolve) => closed.close(() => resolve()));

		// Windows retries a refused loopback connection for about 2 s.
		expect(await TcpProbe.probe("127.0.0.1", closedPort, 4000)).toBe(true);
	});

	test("no answer within the timeout means offline", async () => {
		// TEST-NET-1 (RFC 5737) is never routed.
		expect(await TcpProbe.probe("192.0.2.1", 9, 200)).toBe(false);
	});
});
