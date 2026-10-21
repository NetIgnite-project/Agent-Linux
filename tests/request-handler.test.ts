import { describe, expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { HostControl } from "../src/agent/hostControl";
import { HostInfo } from "../src/agent/hostInfo";
import { RequestHandler } from "../src/agent/requestHandler";
import type { MacAddress } from "../src/net/macAddress";
import { AgentProtocol } from "../src/protocol/agentProtocol";
import { Logger } from "../src/utils/logger";
import { ServerProtocol } from "./helpers/server-protocol";

Logger.setLogLevel("critical");

function makeHandler(options: Partial<RequestHandler.Options> = {}) {
	const calls = {
		wake: [] as Array<{ mac: string; port: number }>,
		status: [] as AgentProtocol.StatusRequest[],
		hostControl: [] as HostControl.Action[],
	};
	const handler = new RequestHandler({
		wolEnabled: true,
		statusProbe: {
			check: async (request) => {
				calls.status.push(request);
				return request.target.type === "ip" && request.target.address === "192.168.1.50";
			},
		},
		wake: async (mac: MacAddress, port: number) => {
			calls.wake.push({ mac: mac.toString(), port });
		},
		hostControl: async (action) => {
			calls.hostControl.push(action);
		},
		hostControlDelayMs: 20,
		...options,
	});
	return { handler, calls };
}

function errorOf(outcome: RequestHandler.Outcome) {
	return outcome.ok ? null : outcome.err;
}

describe("RequestHandler", () => {
	test("PING answers {}", async () => {
		const { handler } = makeHandler({ wolEnabled: false });
		expect(await handler.handle("PING", {})).toEqual({ ok: true, p: {} });
	});

	test("unknown commands are rejected", async () => {
		const { handler } = makeHandler();
		expect(errorOf(await handler.handle("SSH_EXEC", { action: "shutdown" }))).toBe(
			"Unknown command SSH_EXEC",
		);
		expect(errorOf(await handler.handle("ping", {}))).toBe("Unknown command ping");
	});

	describe("without Wake-on-LAN mode", () => {
		test("WAKE and STATUS are rejected and nothing is sent or probed", async () => {
			const { handler, calls } = makeHandler({ wolEnabled: false });
			const wake = await handler.handle("WAKE", { mac: "AA:BB:CC:DD:EE:FF", port: 9 });
			const status = await handler.handle("STATUS", {
				target: { type: "ip", address: "192.168.1.50" },
				icmp: true,
			});
			expect(errorOf(wake)).toContain("Wake-on-LAN mode is off");
			expect(errorOf(status)).toContain("Wake-on-LAN mode is off");
			expect(calls.wake).toEqual([]);
			expect(calls.status).toEqual([]);
		});

		test("HOST_CONTROL still works", async () => {
			const { handler } = makeHandler({ wolEnabled: false });
			expect((await handler.handle("HOST_CONTROL", { action: "reboot" })).ok).toBe(true);
		});
	});

	describe("WAKE", () => {
		test("sends to the parsed MAC and port", async () => {
			const { handler, calls } = makeHandler();
			expect(await handler.handle("WAKE", { mac: "aa-bb-cc-dd-ee-ff", port: 7 })).toEqual({
				ok: true,
				p: {},
			});
			expect(calls.wake).toEqual([{ mac: "AA:BB:CC:DD:EE:FF", port: 7 }]);
		});

		test("rejects bad parameters", async () => {
			const { handler, calls } = makeHandler();
			const cases: Array<[Record<string, unknown>, string]> = [
				[{ port: 9 }, "Invalid MAC address"],
				[{ mac: "AA:BB:CC:DD:EE", port: 9 }, "Invalid MAC address"],
				[{ mac: 42, port: 9 }, "Invalid MAC address"],
				[{ mac: "AA:BB:CC:DD:EE:FF" }, "Invalid port"],
				[{ mac: "AA:BB:CC:DD:EE:FF", port: 0 }, "Invalid port"],
				[{ mac: "AA:BB:CC:DD:EE:FF", port: 65536 }, "Invalid port"],
				[{ mac: "AA:BB:CC:DD:EE:FF", port: "9" }, "Invalid port"],
				[{ mac: "AA:BB:CC:DD:EE:FF", port: 9.5 }, "Invalid port"],
			];
			for (const [payload, error] of cases) {
				expect(errorOf(await handler.handle("WAKE", payload))).toBe(error);
			}
			expect(calls.wake).toEqual([]);
		});

		test("reports a send failure", async () => {
			const { handler } = makeHandler({
				wake: async () => {
					throw new Error("Couldn't send the magic packet: ENETUNREACH");
				},
			});
			expect(errorOf(await handler.handle("WAKE", { mac: "AA:BB:CC:DD:EE:FF", port: 9 }))).toBe(
				"Couldn't send the magic packet: ENETUNREACH",
			);
		});
	});

	describe("STATUS", () => {
		test("answers {online} from the probe", async () => {
			const { handler, calls } = makeHandler();
			expect(
				await handler.handle("STATUS", {
					target: { type: "ip", address: "192.168.1.50" },
					icmp: true,
				}),
			).toEqual({ ok: true, p: { online: true } });
			expect(
				await handler.handle("STATUS", {
					target: { type: "host", host: "nas.lan" },
					icmp: false,
					tcp_port: 22,
				}),
			).toEqual({ ok: true, p: { online: false } });
			expect(calls.status[1]).toEqual({
				target: { type: "host", host: "nas.lan" },
				icmp: false,
				tcp_port: 22,
			});
		});

		test("accepts every target type the server sends", async () => {
			const { handler } = makeHandler();
			for (const target of [
				{ type: "link_local", mac: "AA:BB:CC:DD:EE:FF" },
				{ type: "ip", address: "fd00::7" },
				{ type: "ip", address: "fe80::1%eth0" },
				{ type: "host", host: "server-01.example.com" },
			]) {
				expect((await handler.handle("STATUS", { target, icmp: true })).ok).toBe(true);
			}
		});

		test("rejects bad parameters", async () => {
			const { handler, calls } = makeHandler();
			const cases: Array<[Record<string, unknown>, string]> = [
				[{ icmp: true }, "Unknown status target"],
				[{ target: { type: "mdns", name: "x" }, icmp: true }, "Unknown status target"],
				[{ target: { type: "ip", address: "999.1.1.1" }, icmp: true }, "Invalid IP address"],
				[{ target: { type: "ip", address: "192.168.1.1%eth0" }, icmp: true }, "Invalid IP address"],
				[{ target: { type: "ip", address: "fe80::1%eth0 -c" }, icmp: true }, "Invalid IP address"],
				[{ target: { type: "host", host: "-c1" }, icmp: true }, "Invalid host name"],
				[{ target: { type: "host", host: "a b" }, icmp: true }, "Invalid host name"],
				[{ target: { type: "link_local", mac: "nope" }, icmp: true }, "Invalid MAC address"],
				[{ target: { type: "ip", address: "10.0.0.1" }, icmp: false }, "No probe requested"],
				[{ target: { type: "ip", address: "10.0.0.1" }, icmp: "yes" }, "Invalid icmp flag"],
				[{ target: { type: "ip", address: "10.0.0.1" }, icmp: true, tcp_port: 0 }, "Invalid port"],
			];
			for (const [payload, error] of cases) {
				expect(errorOf(await handler.handle("STATUS", payload))).toBe(error);
			}
			expect(calls.status).toEqual([]);
		});
	});

	describe("HOST_CONTROL", () => {
		test("answers first and acts after the delay, once the answer was sent", async () => {
			const { handler, calls } = makeHandler({ wolEnabled: false });
			const outcome = await handler.handle("HOST_CONTROL", { action: "shutdown" });
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;

			await Bun.sleep(60);
			expect(calls.hostControl).toEqual([]);

			outcome.afterSend?.();
			expect(calls.hostControl).toEqual([]);
			await Bun.sleep(60);
			expect(calls.hostControl).toEqual(["shutdown"]);
		});

		test("rejects a second request while one is pending", async () => {
			const { handler } = makeHandler({ hostControlDelayMs: 200 });
			const first = await handler.handle("HOST_CONTROL", { action: "reboot" });
			if (first.ok) first.afterSend?.();
			expect(errorOf(await handler.handle("HOST_CONTROL", { action: "shutdown" }))).toContain(
				"already in progress",
			);
		});

		test("rejects unknown actions and unsupported systems", async () => {
			const { handler, calls } = makeHandler();
			for (const payload of [{}, { action: "halt" }, { action: "rm -rf /" }, { action: ["reboot"] }]) {
				expect(errorOf(await handler.handle("HOST_CONTROL", payload))).toBe("Unknown action");
			}

			const unsupported = makeHandler({ hostControl: null }).handler;
			expect(errorOf(await unsupported.handle("HOST_CONTROL", { action: "reboot" }))).toContain(
				"isn't supported",
			);
			expect(calls.hostControl).toEqual([]);
		});

		test("runs only the two fixed systemctl commands", () => {
			expect(HostControl.command("shutdown")).toEqual(["systemctl", "--no-ask-password", "poweroff"]);
			expect(HostControl.command("reboot")).toEqual(["systemctl", "--no-ask-password", "reboot"]);
			expect(HostControl.DELAY_MS).toBe(1000);
		});
	});
});

describe("AgentProtocol", () => {
	test("capabilities: host always, Wake-on-LAN extras only in WOL mode", () => {
		expect(AgentProtocol.capabilities(false)).toEqual(["host.status", "host.control"]);
		expect(AgentProtocol.capabilities(true)).toEqual([
			"host.status",
			"host.control",
			"wake",
			"status.link_local",
			"status.ip",
			"status.host",
			"status.tcp",
		]);
	});

	test("encodes frames the server's schema accepts", () => {
		for (const text of [
			AgentProtocol.encodeResponse(7, { online: true }),
			AgentProtocol.encodeResponse(0xffffffff),
			AgentProtocol.encodeError(8, "nope"),
			AgentProtocol.encodeEvent("HOST_STATUS", { hostname: "pc", uptime_s: 5 }),
		]) {
			expect(ServerProtocol.Frame.safeParse(JSON.parse(text)).success).toBe(true);
		}
		expect(JSON.parse(AgentProtocol.encodeResponse(7, { online: true }))).toEqual({
			t: "res",
			id: 7,
			ok: true,
			p: { online: true },
		});
		expect(JSON.parse(AgentProtocol.encodeError(8, "x".repeat(2000))).err).toHaveLength(1024);
	});

	test("decodes requests and drops anything else", () => {
		expect(AgentProtocol.decode('{"t":"req","id":5,"cmd":"PING"}')).toEqual({
			ok: true,
			frame: { t: "req", id: 5, cmd: "PING", p: {} },
		});
		expect(AgentProtocol.decode("not json").ok).toBe(false);
		expect(AgentProtocol.decode('{"t":"req","id":-1,"cmd":"PING"}').ok).toBe(false);
		expect(AgentProtocol.decode('{"t":"req","id":1,"cmd":""}').ok).toBe(false);
		expect(AgentProtocol.decode('{"t":"nope"}').ok).toBe(false);
		expect(
			AgentProtocol.decode(`{"t":"req","id":1,"cmd":"PING","p":{"x":"${"a".repeat(70_000)}"}}`),
		).toEqual({ ok: false, error: "frame too large" });
	});
});

describe("HostInfo", () => {
	test("parses os-release", () => {
		const values = HostInfo.parseOsRelease(
			[
				'NAME="Debian GNU/Linux"',
				'VERSION="12 (bookworm)"',
				"ID=debian",
				"# comment",
				"",
				'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"',
			].join("\n"),
		);
		expect(values.ID).toBe("debian");
		expect(HostInfo.osName(values)).toBe("Debian GNU/Linux 12 (bookworm)");
		expect(HostInfo.osName({ NAME: "Alpine Linux", VERSION: "3.20" })).toBe("Alpine Linux 3.20");
		expect(HostInfo.osName({})).toBeNull();
	});

	test("lists external addresses only", () => {
		const entry = (address: string, family: "IPv4" | "IPv6", internal = false) =>
			({ address, family, internal, netmask: "", mac: "", cidr: null }) as NetworkInterfaceInfo;
		expect(
			HostInfo.addresses({
				lo: [entry("127.0.0.1", "IPv4", true), entry("::1", "IPv6", true)],
				eth0: [entry("192.168.1.20", "IPv4"), entry("fe80::1", "IPv6")],
				eth1: [entry("192.168.1.20", "IPv4")],
			}),
		).toEqual({ ipv4: ["192.168.1.20"], ipv6: ["fe80::1"] });
	});

	test("HELLO matches the server's schema", async () => {
		for (const wol of [false, true]) {
			const hello = await HostInfo.hello(wol);
			const parsed = ServerProtocol.Hello.parse(hello);
			expect(parsed.protocol).toBe(2);
			expect(parsed.kind).toBe("linux");
			expect(parsed.capabilities).toEqual(AgentProtocol.capabilities(wol));
			expect(parsed.info).toMatchObject({
				hostname: expect.any(String),
				kernel: expect.any(String),
				arch: process.arch,
				uptime_s: expect.any(Number),
				wake_on_lan: wol ? "on" : "off",
			});
			expect(JSON.stringify(hello).length).toBeLessThan(AgentProtocol.MAX_FRAME_BYTES);
		}
		expect(ServerProtocol.HostStatus.safeParse(HostInfo.status()).success).toBe(true);
	});
});
