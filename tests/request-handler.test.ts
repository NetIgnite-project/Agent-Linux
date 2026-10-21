import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { HostControl } from "../src/agent/hostControl";
import { HostInfo } from "../src/agent/hostInfo";
import { RequestHandler } from "../src/agent/requestHandler";
import { SystemFiles } from "../src/install/systemFiles";
import type { MacAddress } from "../src/net/macAddress";
import { AgentProtocol } from "../src/protocol/agentProtocol";
import { SshKeys } from "../src/ssh/sshKeys";
import { AppConstants } from "../src/utils/constants";
import { Logger } from "../src/utils/logger";
import { makeTempDir, removeTempDir } from "./helpers/cli";
import { ServerProtocol } from "./helpers/server-protocol";

Logger.setLogLevel("critical");

function makeHandler(options: Partial<RequestHandler.Options> = {}) {
	const calls = {
		wake: [] as Array<{ mac: string; port: number }>,
		status: [] as AgentProtocol.StatusRequest[],
		hostControl: [] as HostControl.Action[],
		sshCheck: [] as AgentProtocol.SshCheckRequest[],
		sshPower: [] as AgentProtocol.SshPowerRequest[],
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
		ssh: {
			check: async (request) => {
				calls.sshCheck.push(request);
				return {
					ok: true,
					result: { online: true, host_key: HOST_KEY, shutdown: true, reboot: false },
				};
			},
			power: async (request) => {
				calls.sshPower.push(request);
				return request.action === "reboot"
					? { ok: false, error: "the device didn't accept the agent's reboot key" }
					: { ok: true };
			},
		},
		...options,
	});
	return { handler, calls };
}

const HOST_KEY = "SHA256:DcMC1wdAY3Z/tgRBo2BNYADDzJ63IywaXdcFMUjqjC8";

function sshCheckPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { host: "192.168.1.20", port: 22, username: "netignite", host_key: HOST_KEY, ...overrides };
}

function sshPowerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return sshCheckPayload({ action: "shutdown", os: "posix", sudo: true, ...overrides });
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
		expect(errorOf(await handler.handle("SSH_SHELL", { command: "id" }))).toBe(
			"Unknown command SSH_SHELL",
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

		test("SSH_CHECK and SSH_POWER are rejected before anything is parsed or connected", async () => {
			const { handler, calls } = makeHandler({ wolEnabled: false });
			expect(errorOf(await handler.handle("SSH_CHECK", sshCheckPayload()))).toContain(
				"Wake-on-LAN mode is off",
			);
			expect(errorOf(await handler.handle("SSH_POWER", sshPowerPayload()))).toContain(
				"Wake-on-LAN mode is off",
			);
			expect(calls.sshCheck).toEqual([]);
			expect(calls.sshPower).toEqual([]);
		});

		test("HOST_CONTROL is refused with the check's reason when it isn't possible", async () => {
			const { handler, calls } = makeHandler({
				hostControlCheck: async (action) =>
					action === "shutdown" ? "apt blocks shutdown and reboot right now" : null,
			});
			const refused = await handler.handle("HOST_CONTROL", { action: "shutdown" });
			expect(refused.ok).toBe(false);
			expect(errorOf(refused)).toContain("apt blocks shutdown");
			const allowed = await handler.handle("HOST_CONTROL", { action: "reboot" });
			expect(allowed.ok).toBe(true);
			if (allowed.ok) allowed.afterSend?.();
			await Bun.sleep(60);
			expect(calls.hostControl).toEqual(["reboot"]);
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

		test("asks systemd through one fixed request file per action", () => {
			expect(SystemFiles.requestPath("shutdown")).toBe("/run/netignite-agent/shutdown");
			expect(SystemFiles.requestPath("reboot")).toBe("/run/netignite-agent/reboot");
			expect(HostControl.DELAY_MS).toBe(1000);
		});
	});
});

describe("SSH_CHECK", () => {
	test("passes the validated request on and answers with the result", async () => {
		const { handler, calls } = makeHandler();
		expect(await handler.handle("SSH_CHECK", sshCheckPayload())).toEqual({
			ok: true,
			p: { online: true, host_key: HOST_KEY, shutdown: true, reboot: false },
		});
		expect(calls.sshCheck).toEqual([sshCheckPayload() as AgentProtocol.SshCheckRequest]);
	});

	test("host_key may be null or missing (trust on first use)", async () => {
		const { handler, calls } = makeHandler();
		expect((await handler.handle("SSH_CHECK", sshCheckPayload({ host_key: null }))).ok).toBe(true);
		const { host_key: _, ...withoutKey } = sshCheckPayload();
		expect((await handler.handle("SSH_CHECK", withoutKey)).ok).toBe(true);
		expect(calls.sshCheck.map((request) => request.host_key ?? null)).toEqual([null, null]);
	});

	test("accepts IPv6, host names and Windows user names", async () => {
		const { handler } = makeHandler();
		for (const overrides of [
			{ host: "fd00::20" },
			{ host: "fe80::1%eth0" },
			{ host: "nas.lan" },
			{ username: "DESKTOP-1\\Jane Doe" },
			{ username: "jane@example.com" },
			{ port: 65535 },
		]) {
			expect((await handler.handle("SSH_CHECK", sshCheckPayload(overrides))).ok).toBe(true);
		}
	});

	test("rejects bad parameters without connecting", async () => {
		const { handler, calls } = makeHandler();
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ port: 0 }, "Invalid port"],
			[{ port: 65536 }, "Invalid port"],
			[{ port: "22" }, "Invalid port"],
			[{ port: undefined }, "Invalid port"],
			[{ username: "" }, "Invalid username"],
			[{ username: undefined }, "Invalid username"],
			[{ username: "admin\n" }, "Invalid username"],
			[{ username: "admin\u0000" }, "Invalid username"],
			[{ username: "a".repeat(256) }, "Invalid username"],
			[{ host: "" }, "Invalid host"],
			[{ host: "-oProxyCommand=x" }, "Invalid host"],
			[{ host: "a b" }, "Invalid host"],
			[{ host: 192 }, "Invalid host"],
			[{ host_key: "MD5:aa:bb" }, "Invalid host key"],
			[{ host_key: `${HOST_KEY}=` }, "Invalid host key"],
			[{ host_key: 5 }, "Invalid host key"],
		];
		for (const [overrides, error] of cases) {
			expect(errorOf(await handler.handle("SSH_CHECK", sshCheckPayload(overrides)))).toBe(error);
		}
		expect(calls.sshCheck).toEqual([]);
	});

	test("credentials from the server are ignored: the agent only uses its own keys", async () => {
		const { handler, calls } = makeHandler();
		await handler.handle(
			"SSH_CHECK",
			sshCheckPayload({ auth: { type: "password", password: "hunter2" } }),
		);
		expect(calls.sshCheck[0]).not.toHaveProperty("auth");
	});

	test("a refused check (login limit) becomes ok:false", async () => {
		const { handler } = makeHandler({
			ssh: {
				check: async () => ({ ok: false, error: "Too many SSH logins" }),
				power: async () => ({ ok: true }),
			},
		});
		expect(await handler.handle("SSH_CHECK", sshCheckPayload())).toEqual({
			ok: false,
			err: "Too many SSH logins",
		});
	});
});

describe("SSH_POWER", () => {
	test("passes the validated request on", async () => {
		const { handler, calls } = makeHandler();
		expect(await handler.handle("SSH_POWER", sshPowerPayload())).toEqual({ ok: true, p: {} });
		expect(calls.sshPower[0]).toMatchObject({ action: "shutdown", os: "posix", sudo: true });
	});

	test("a failure becomes ok:false with the error", async () => {
		const { handler } = makeHandler();
		expect(await handler.handle("SSH_POWER", sshPowerPayload({ action: "reboot" }))).toEqual({
			ok: false,
			err: "the device didn't accept the agent's reboot key",
		});
	});

	test("requires the host key", async () => {
		const { handler, calls } = makeHandler();
		const { host_key: _, ...withoutKey } = sshPowerPayload();
		expect(errorOf(await handler.handle("SSH_POWER", withoutKey))).toBe("Missing host key");
		expect(errorOf(await handler.handle("SSH_POWER", sshPowerPayload({ host_key: null })))).toBe(
			"Missing host key",
		);
		expect(calls.sshPower).toEqual([]);
	});

	test("rejects unknown actions, systems and bad flags", async () => {
		const { handler, calls } = makeHandler();
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ action: "halt" }, "Unknown action"],
			[{ action: "shutdown -h now; rm -rf /" }, "Unknown action"],
			[{ action: undefined }, "Unknown action"],
			[{ os: "macos" }, "Unknown OS"],
			[{ os: undefined }, "Unknown OS"],
			[{ sudo: "yes" }, "Invalid sudo flag"],
			[{ sudo: undefined }, "Invalid sudo flag"],
			[{ port: -1 }, "Invalid port"],
			[{ username: "" }, "Invalid username"],
		];
		for (const [overrides, error] of cases) {
			expect(errorOf(await handler.handle("SSH_POWER", sshPowerPayload(overrides)))).toBe(error);
		}
		expect(calls.sshPower).toEqual([]);
	});

	test("drops fields it doesn't know (there is no free-text command)", async () => {
		const { handler, calls } = makeHandler();
		await handler.handle("SSH_POWER", sshPowerPayload({ command: "rm -rf /" }));
		expect(calls.sshPower[0]).not.toHaveProperty("command");
	});

	test("SSH_EXEC (2.0.0-beta.2) is an unknown command", async () => {
		const { handler, calls } = makeHandler();
		expect(errorOf(await handler.handle("SSH_EXEC", sshPowerPayload()))).toBe(
			"Unknown command SSH_EXEC",
		);
		expect(calls.sshPower).toEqual([]);
	});
});

describe("without SSH (no keys, or no TLS to the server)", () => {
	test("SSH_CHECK and SSH_POWER say why, without parsing or connecting", async () => {
		const { handler, calls } = makeHandler({
			ssh: null,
			sshUnavailable: "SSH needs an https:// server address (the agent connects without TLS)",
		});
		for (const [cmd, payload] of [
			["SSH_CHECK", sshCheckPayload()],
			["SSH_POWER", sshPowerPayload()],
		] as const) {
			expect(errorOf(await handler.handle(cmd, payload))).toBe(
				"SSH needs an https:// server address (the agent connects without TLS)",
			);
		}
		expect(calls.sshCheck).toEqual([]);
		expect(calls.sshPower).toEqual([]);
	});
});

describe("AgentProtocol", () => {
	test("capabilities: host always, Wake-on-LAN extras in WOL mode, ssh.power with keys and TLS", () => {
		const wol = ["wake", "status.link_local", "status.ip", "status.host", "status.tcp"] as const;
		expect(AgentProtocol.capabilities({ wol: false, ssh: false })).toEqual([
			"host.status",
			"host.control",
		]);
		// SSH only comes with Wake-on-LAN mode.
		expect(AgentProtocol.capabilities({ wol: false, ssh: true })).toEqual([
			"host.status",
			"host.control",
		]);
		expect(AgentProtocol.capabilities({ wol: true, ssh: false })).toEqual([
			"host.status",
			"host.control",
			...wol,
		]);
		expect(AgentProtocol.capabilities({ wol: true, ssh: true })).toEqual([
			"host.status",
			"host.control",
			...wol,
			"ssh.power",
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

	test("HELLO matches the server's schema; SSH keys only come with ssh.power", async () => {
		const sshKeys = SshKeys.publicKeys(SshKeys.generate(3));
		const withSsh = ServerProtocol.Hello.parse(await HostInfo.hello({ wol: true, sshKeys }));
		expect(withSsh.capabilities).toContain("ssh.power");
		expect(withSsh.ssh_keys).toEqual(sshKeys);
		const hostMode = ServerProtocol.Hello.parse(await HostInfo.hello({ wol: false, sshKeys }));
		expect(hostMode.capabilities).not.toContain("ssh.power");
		expect(hostMode.ssh_keys).toBeUndefined();

		for (const wol of [false, true]) {
			const hello = await HostInfo.hello({ wol, sshKeys: null });
			const parsed = ServerProtocol.Hello.parse(hello);
			expect(parsed.protocol).toBe(2);
			expect(parsed.kind).toBe(AppConstants.AGENT_KIND);
			expect(parsed.capabilities).toEqual(AgentProtocol.capabilities({ wol, ssh: false }));
			expect(parsed.ssh_keys).toBeUndefined();
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

describe("HostControl", () => {
	test("finds block inhibitors for shutdowns in logind's ListInhibitors answer", () => {
		const answer = (inhibitors: unknown[]) =>
			JSON.stringify({ type: "a(ssssuu)", data: [inhibitors] });

		expect(HostControl.blockingInhibitor(answer([]))).toBeNull();
		// Delay inhibitors only postpone the shutdown; sleep and idle blockers don't matter.
		expect(
			HostControl.blockingInhibitor(
				answer([
					["shutdown:sleep", "Unattended Upgrades Shutdown", "Stop ongoing upgrades", "delay", 0, 808],
					["sleep:idle", "GNOME", "Playing a video", "block", 1000, 1500],
				]),
			),
		).toBeNull();
		expect(
			HostControl.blockingInhibitor(
				answer([["sleep:shutdown", "apt", "Installing packages", "block", 0, 1234]]),
			),
		).toEqual({ who: "apt", why: "Installing packages" });
		// Verbatim from systemd 257 (Debian 13) with `systemd-inhibit --what=shutdown:sleep --mode=block`.
		expect(
			HostControl.blockingInhibitor(
				'{"type":"a(ssssuu)","data":[[["shutdown:sleep","Test","pretend upgrade","block",0,883]]]}',
			),
		).toEqual({ who: "Test", why: "pretend upgrade" });
		expect(HostControl.blockingInhibitor("not json")).toBeNull();
		expect(HostControl.blockingInhibitor('{"data":[]}')).toBeNull();
	});

	test("perform returns once the .path unit picked the request up", async () => {
		const dir = await makeTempDir();
		try {
			const requestPath = join(dir, "shutdown");
			// Stands in for netignite-agent-shutdown.service, which removes the request first.
			const pickUp = (async () => {
				while (!(await Bun.file(requestPath).exists())) await Bun.sleep(20);
				await rm(requestPath);
			})();
			await HostControl.perform("shutdown", { requestPath, timeoutMs: 3000 });
			await pickUp;
		} finally {
			await removeTempDir(dir);
		}
	});

	test("perform fails and removes the request when nothing picks it up", async () => {
		const dir = await makeTempDir();
		try {
			const requestPath = join(dir, "reboot");
			await expect(HostControl.perform("reboot", { requestPath, timeoutMs: 300 })).rejects.toThrow(
				"nothing picked the request up",
			);
			// A request left behind would reboot the machine whenever the unit becomes active.
			expect(await Bun.file(requestPath).exists()).toBe(false);

			await expect(
				HostControl.perform("reboot", { requestPath: join(dir, "missing", "reboot") }),
			).rejects.toThrow("can't create");
		} finally {
			await removeTempDir(dir);
		}
	});
});
