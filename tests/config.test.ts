import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentConfig, ConfigError } from "../src/config/agentConfig";
import { Enrollment, EnrollmentError } from "../src/enroll/enrollment";
import { SystemFacts } from "../src/install/systemFacts";
import { ServerUrl } from "../src/net/serverUrl";
import { makeTempDir, removeTempDir } from "./helpers/cli";
import { ServerProtocol } from "./helpers/server-protocol";

const VALID: AgentConfig.Data = {
	server: "https://netignite.example.com",
	agent_id: 7,
	token_id: "a1b2c3d4e5f6",
	secret: "f".repeat(64),
	wol: { enabled: false },
};

const posixOnly = test.skipIf(process.platform === "win32");

let dir: string;

beforeAll(async () => {
	dir = await makeTempDir();
});

afterAll(async () => {
	await removeTempDir(dir);
});

describe("AgentConfig", () => {
	test("accepts a valid config and defaults Wake-on-LAN mode to off", () => {
		const { wol: _wol, ...withoutWol } = VALID;
		expect(AgentConfig.parse(withoutWol).wol).toEqual({ enabled: false });
		expect(AgentConfig.parse(VALID)).toEqual(VALID);
	});

	test("rejects broken configs with the field name", () => {
		expect(() => AgentConfig.parse({ ...VALID, server: "ftp://x" })).toThrow("server");
		expect(() => AgentConfig.parse({ ...VALID, agent_id: 0 })).toThrow("agent_id");
		expect(() => AgentConfig.parse({ ...VALID, token_id: "a:b" })).toThrow("token_id");
		expect(() => AgentConfig.parse({ ...VALID, secret: "short" })).toThrow("secret");
		expect(() => AgentConfig.parse(null)).toThrow(ConfigError);
	});

	test("builds the bearer credential", () => {
		expect(AgentConfig.credential(VALID)).toBe(`netignite_agent_a1b2c3d4e5f6:${"f".repeat(64)}`);
	});

	test("save and load round-trip, through a fresh directory", async () => {
		const path = join(dir, "roundtrip", "nested", "agent.json");
		await AgentConfig.save(path, VALID);
		expect(await AgentConfig.load(path)).toEqual(VALID);

		await AgentConfig.save(path, { ...VALID, wol: { enabled: true } });
		expect((await AgentConfig.load(path)).wol.enabled).toBe(true);

		// Atomic write: no temp files left behind.
		expect(await readdir(join(dir, "roundtrip", "nested"))).toEqual(["agent.json"]);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...VALID, wol: { enabled: true } });
	});

	test("save refuses invalid data and leaves the old file alone", async () => {
		const path = join(dir, "invalid.json");
		await AgentConfig.save(path, VALID);
		await expect(AgentConfig.save(path, { ...VALID, secret: "x" })).rejects.toThrow("secret");
		expect(await AgentConfig.load(path)).toEqual(VALID);
	});

	posixOnly("the file is 0600, the directory 0750", async () => {
		const path = join(dir, "modes", "agent.json");
		await AgentConfig.save(path, VALID);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(join(dir, "modes"))).mode & 0o777).toBe(0o750);

		// Even if someone loosened it.
		await chmod(path, 0o644);
		await AgentConfig.save(path, VALID);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	test("owner: the service user if it exists, else the previous owner", () => {
		const service = { uid: 990, gid: 985 };
		const previous = { uid: 0, gid: 0 };
		expect(AgentConfig.fileOwner({ serviceUser: service, previous })).toEqual(service);
		expect(AgentConfig.fileOwner({ serviceUser: service, previous: null })).toEqual(service);
		expect(AgentConfig.fileOwner({ serviceUser: null, previous })).toEqual(previous);
		expect(AgentConfig.fileOwner({ serviceUser: null, previous: null })).toBeNull();
		expect(AgentConfig.FILE_MODE).toBe(0o600);
	});

	test("load explains a missing or broken file", async () => {
		await expect(AgentConfig.load(join(dir, "missing.json"))).rejects.toThrow("Pair the agent first");
		const broken = join(dir, "broken.json");
		await writeFile(broken, "{ not json");
		await expect(AgentConfig.load(broken)).rejects.toThrow("not valid JSON");
	});

	test("assertWritable creates the directory and leaves nothing behind", async () => {
		const path = join(dir, "writable", "agent.json");
		await AgentConfig.assertWritable(path);
		expect(await readdir(join(dir, "writable"))).toEqual([]);
	});

	test("assertWritable fails if the directory can't be created", async () => {
		const file = join(dir, "a-file");
		await writeFile(file, "");
		await expect(AgentConfig.assertWritable(join(file, "agent.json"))).rejects.toThrow(ConfigError);
	});
});

describe("SystemFacts.parsePasswdEntry", () => {
	test("reads uid and gid", () => {
		expect(
			SystemFacts.parsePasswdEntry("netignite:x:998:997::/nonexistent:/usr/sbin/nologin\n"),
		).toEqual({ uid: 998, gid: 997 });
	});

	test("rejects anything else", () => {
		expect(SystemFacts.parsePasswdEntry("")).toBeNull();
		expect(SystemFacts.parsePasswdEntry("netignite:x:abc:997::/:/bin/false")).toBeNull();
		expect(SystemFacts.parsePasswdEntry("netignite:x:998")).toBeNull();
	});
});

describe("Enrollment", () => {
	const server = ServerUrl.parse("https://netignite.example.com/sub");
	const token = `netignite_enroll_${"a".repeat(32)}:${"b".repeat(64)}`;

	function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return new Response(body === undefined ? null : JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json", ...headers },
			});
		}) as typeof fetch;
		return { fetchImpl, calls };
	}

	test("generates 64 hex characters the server accepts", () => {
		const secrets = new Set<string>();
		for (let i = 0; i < 20; i++) {
			const secret = Enrollment.generateSecret();
			expect(secret).toMatch(/^[0-9a-f]{64}$/);
			expect(ServerProtocol.SECRET_PATTERN.test(secret)).toBe(true);
			secrets.add(secret);
		}
		expect(secrets.size).toBe(20);
	});

	test("recognizes enrollment tokens", () => {
		expect(Enrollment.isEnrollmentToken(token)).toBe(true);
		expect(Enrollment.isEnrollmentToken("netignite_enroll_abc")).toBe(false);
		expect(Enrollment.isEnrollmentToken("netignite_agent_abc:def")).toBe(false);
		expect(Enrollment.isEnrollmentToken("netignite_enroll_a:b:c")).toBe(false);
		expect(Enrollment.isEnrollmentToken(`netignite_enroll_a:${"b".repeat(300)}`)).toBe(false);
	});

	test("posts the token and secret and returns the credential parts", async () => {
		const { fetchImpl, calls } = fakeFetch(200, {
			success: true,
			code: 200,
			message: "Agent enrolled",
			data: { agent_id: 3, kind: "linux", token_id: "tok123" },
		});
		const secret = Enrollment.generateSecret();

		const result = await Enrollment.enroll(server, token, secret, fetchImpl);
		expect(result).toEqual({ agent_id: 3, kind: "linux", token_id: "tok123" });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://netignite.example.com/sub/api/v1/agents/enroll");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ enrollment_token: token, secret });
	});

	test("an ESP32 token fails with a clear message", async () => {
		const { fetchImpl } = fakeFetch(200, {
			success: true,
			code: 200,
			message: "Agent enrolled",
			data: { agent_id: 4, kind: "esp32", token_id: "tok" },
		});
		const error = await Enrollment.enroll(server, token, "c".repeat(64), fetchImpl).catch((e) => e);
		expect(error).toBeInstanceOf(EnrollmentError);
		expect(error.message).toContain("ESP32 agent");
		expect(error.message).toContain("Linux");
	});

	test("explains the server's rejections", async () => {
		const cases: Array<[number, unknown, string]> = [
			[
				401,
				{ success: false, code: 401, message: "Unknown, used or expired enrollment token" },
				"already used or expired",
			],
			[429, { success: false, code: 429, message: "Too many" }, "Too many enrollment attempts"],
			[
				400,
				{ success: false, code: 400, message: "The secret must be 32–128 characters" },
				"The secret must be",
			],
			[404, { success: false, code: 404, message: "Not found" }, "Check the server URL"],
			[500, { success: false, code: 500, message: "Internal Server Error" }, "HTTP 500"],
			[200, { hello: "world" }, "Is this a NetIgnite v2 server?"],
		];
		for (const [status, body, expected] of cases) {
			const { fetchImpl } = fakeFetch(status, body);
			await expect(Enrollment.enroll(server, token, "c".repeat(64), fetchImpl)).rejects.toThrow(
				expected,
			);
		}
	});

	test("doesn't follow redirects (the POST would turn into a GET)", async () => {
		const { fetchImpl, calls } = fakeFetch(301, undefined, {
			Location: "https://netignite.example.com/sub/api/v1/agents/enroll",
		});
		await expect(Enrollment.enroll(server, token, "c".repeat(64), fetchImpl)).rejects.toThrow(
			"redirects",
		);
		expect(calls[0]?.init?.redirect).toBe("manual");
	});

	test("never puts the token or secret into an error message", async () => {
		const secret = Enrollment.generateSecret();
		for (const status of [400, 401, 404, 429, 500]) {
			const { fetchImpl } = fakeFetch(status, { success: false, code: status, message: "nope" });
			const error: Error = await Enrollment.enroll(server, token, secret, fetchImpl).catch((e) => e);
			expect(error.message).not.toContain(secret);
			expect(error.message).not.toContain(token.split(":")[1] as string);
		}
	});

	test("a network error names the server", async () => {
		const fetchImpl = (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as unknown as typeof fetch;
		await expect(Enrollment.enroll(server, token, "c".repeat(64), fetchImpl)).rejects.toThrow(
			"Couldn't reach the server at https://netignite.example.com/sub",
		);
	});
});
