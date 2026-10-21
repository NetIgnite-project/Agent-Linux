import { describe, expect, test } from "bun:test";
import { ServerUrl } from "../src/net/serverUrl";

describe("ServerUrl", () => {
	test("keeps https URLs and derives wss://", () => {
		const url = ServerUrl.parse("https://netignite.example.com");
		expect(url.toString()).toBe("https://netignite.example.com");
		expect(url.httpUrl("/api/v1/agents/enroll")).toBe(
			"https://netignite.example.com/api/v1/agents/enroll",
		);
		expect(url.wsUrl("/ws/agent")).toBe("wss://netignite.example.com/ws/agent");
	});

	test("keeps http URLs with a port and derives ws://", () => {
		const url = ServerUrl.parse("http://192.168.1.10:18232");
		expect(url.toString()).toBe("http://192.168.1.10:18232");
		expect(url.wsUrl("/ws/agent")).toBe("ws://192.168.1.10:18232/ws/agent");
	});

	test("drops trailing slashes and keeps a sub-path as typed", () => {
		expect(ServerUrl.parse("http://192.168.1.10:18232/").toString()).toBe(
			"http://192.168.1.10:18232",
		);
		const url = ServerUrl.parse("https://example.com/NetIgnite//");
		expect(url.basePath).toBe("/NetIgnite");
		expect(url.wsUrl("/ws/agent")).toBe("wss://example.com/NetIgnite/ws/agent");
	});

	test("handles IPv6 literals with a port", () => {
		const url = ServerUrl.parse("http://[fd00::10]:18232/");
		expect(url.host).toBe("[fd00::10]");
		expect(url.port).toBe(18232);
		expect(url.toString()).toBe("http://[fd00::10]:18232");
		expect(url.wsUrl("/ws/agent")).toBe("ws://[fd00::10]:18232/ws/agent");
		expect(ServerUrl.parse("https://[2001:db8::1]").wsUrl("/ws/agent")).toBe(
			"wss://[2001:db8::1]/ws/agent",
		);
	});

	test("normalizes case and default ports", () => {
		expect(ServerUrl.parse("HTTPS://NetIgnite.Example.COM").toString()).toBe(
			"https://netignite.example.com",
		);
		expect(ServerUrl.parse("https://example.com:443").toString()).toBe("https://example.com");
		expect(ServerUrl.parse("http://example.com:80/").toString()).toBe("http://example.com");
		expect(ServerUrl.parse("https://example.com:80").toString()).toBe("https://example.com:80");
	});

	test("assumes https:// without a scheme", () => {
		expect(ServerUrl.parse("  netignite.example.com/ ").toString()).toBe(
			"https://netignite.example.com",
		);
	});

	test("round-trips through toString()", () => {
		for (const text of [
			"https://netignite.example.com",
			"http://192.168.1.10:18232",
			"http://[fd00::10]:18232/netignite",
		]) {
			const once = ServerUrl.parse(text).toString();
			expect(ServerUrl.parse(once).toString()).toBe(once);
		}
	});

	test("rejects credentials", () => {
		expect(() => ServerUrl.parse("https://user:pass@example.com")).toThrow("user name or password");
		expect(() => ServerUrl.parse("https://user@example.com")).toThrow("user name or password");
	});

	test("rejects queries and fragments", () => {
		for (const text of [
			"https://example.com/?token=1",
			"https://example.com?",
			"https://example.com/#frag",
			"https://example.com#",
		]) {
			expect(() => ServerUrl.parse(text)).toThrow("query (?) or fragment (#)");
		}
	});

	test("rejects other schemes and garbage", () => {
		expect(() => ServerUrl.parse("ftp://example.com")).toThrow("Unsupported scheme");
		expect(() => ServerUrl.parse("wss://example.com")).toThrow("Unsupported scheme");
		expect(() => ServerUrl.parse("")).toThrow("empty");
		expect(() => ServerUrl.parse("https://exa mple.com")).toThrow("not a valid URL");
		expect(() => ServerUrl.parse(`https://${"a".repeat(600)}.com`)).toThrow("too long");
	});
});
