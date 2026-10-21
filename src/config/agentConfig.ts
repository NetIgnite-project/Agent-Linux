import { chmod, chown, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ServerUrl } from "../net/serverUrl";
import { SshKeys } from "../ssh/sshKeys";
import { AppConstants } from "../utils/constants";
import { AppError } from "../utils/errors";
import { Platform } from "../utils/platform";

/**
 * The agent's config file (`/etc/netignite/agent.json` by default), written by `pair`:
 *
 * ```json
 * { "server": "https://netignite.example.com", "agent_id": 3, "token_id": "…", "secret": "…",
 *   "wol": { "enabled": false }, "ssh_keys": { "shutdown": "-----BEGIN OPENSSH…", "reboot": "…" } }
 * ```
 *
 * It holds the agent's long-term secret and its SSH private keys (Wake-on-LAN mode logs in to
 * other devices with them), so it is always mode 0600: owned by the service user `netignite` once
 * that exists (the service has to read it), by root before. The service can't write it, so `pair`,
 * `install` and `wol-mode on` create missing keys.
 */
export class AgentConfig {
	/** Agent-generated secrets: 32–128 URL-safe characters (same rule as the server). */
	static readonly SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
	static readonly AGENT_TOKEN_PREFIX = `${AppConstants.APP_KEYS_PREFIX}_agent_`;

	static readonly FILE_MODE = 0o600;
	static readonly DIR_MODE = 0o750;

	static readonly Schema = z.object({
		server: z.string().refine((value) => {
			try {
				ServerUrl.parse(value);
				return true;
			} catch {
				return false;
			}
		}, "Invalid server URL"),
		agent_id: z.number().int().positive(),
		token_id: z
			.string()
			.min(1)
			.max(256)
			.regex(/^[^:\s]+$/, "Invalid token id"),
		secret: z.string().regex(AgentConfig.SECRET_PATTERN, "Invalid secret"),
		wol: z.object({ enabled: z.boolean() }).default({ enabled: false }),
		ssh_keys: z
			.object({
				shutdown: z.string().refine(SshKeys.isUsablePrivateKey, "Invalid SSH key"),
				reboot: z.string().refine(SshKeys.isUsablePrivateKey, "Invalid SSH key"),
			})
			.optional(),
	});

	/** Validates parsed JSON. */
	static parse(json: unknown): AgentConfig.Data {
		const parsed = AgentConfig.Schema.safeParse(json);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
			throw new ConfigError(`Invalid config: ${where}${issue?.message ?? "unknown error"}`);
		}
		return parsed.data;
	}

	static async load(path: string): Promise<AgentConfig.Data> {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				throw new ConfigError(
					`No config at ${path}. Pair the agent first: sudo ${AppConstants.BINARY_NAME} pair <server-url> <enrollment-token>`,
				);
			}
			if (code === "EACCES") {
				throw new ConfigError(`Can't read ${path} (permission denied). Run it with sudo.`);
			}
			throw error;
		}

		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			throw new ConfigError(`${path} is not valid JSON`);
		}
		return AgentConfig.parse(json);
	}

	/**
	 * Who owns a newly written config: the service user if it exists (it has to read the file),
	 * else whoever owned the previous file. `null` leaves the owner to the writing process.
	 */
	static fileOwner(options: {
		serviceUser: AgentConfig.Owner | null;
		previous: AgentConfig.Owner | null;
	}): AgentConfig.Owner | null {
		return options.serviceUser ?? options.previous;
	}

	/**
	 * Writes the config atomically (temp file + rename) with mode 0600 and the owner from
	 * {@link fileOwner}. Changing the owner needs root; without it the owner stays the writer.
	 */
	static async save(
		path: string,
		data: AgentConfig.Data,
		options: { serviceUser?: AgentConfig.Owner | null } = {},
	) {
		const config = AgentConfig.parse(data);
		const serviceUser = options.serviceUser ?? null;
		const canChown = Platform.isLinux() && Platform.isRoot();

		let previous: AgentConfig.Owner | null = null;
		try {
			const info = await stat(path);
			previous = { uid: info.uid, gid: info.gid };
		} catch {
			await AgentConfig.ensureDir(dirname(path), canChown ? serviceUser : null);
		}

		const owner = AgentConfig.fileOwner({ serviceUser, previous });
		const temp = `${path}.${process.pid}.tmp`;
		try {
			await writeFile(temp, `${JSON.stringify(config, null, "\t")}\n`, {
				mode: AgentConfig.FILE_MODE,
				// Never follow or reuse a file someone put there.
				flag: "wx",
			});
			// The mode passed to writeFile is filtered by the umask.
			await chmod(temp, AgentConfig.FILE_MODE);
			if (owner && canChown) await chown(temp, owner.uid, owner.gid);
			await rename(temp, path);
		} catch (error) {
			await rm(temp, { force: true });
			throw error;
		}
	}

	/** Creates the config directory (0750); the service user's group may enter it. */
	private static async ensureDir(dir: string, serviceUser: AgentConfig.Owner | null) {
		if (await Platform.exists(dir)) return;
		await mkdir(dir, { recursive: true, mode: AgentConfig.DIR_MODE });
		await chmod(dir, AgentConfig.DIR_MODE);
		if (serviceUser) await chown(dir, 0, serviceUser.gid);
	}

	/**
	 * Fails unless the config can be written, creating its directory if needed. `pair` checks
	 * this before it spends the single-use enrollment token.
	 */
	static async assertWritable(path: string) {
		const probe = `${path}.${process.pid}.check`;
		try {
			if (!(await Platform.exists(dirname(path)))) {
				await mkdir(dirname(path), { recursive: true, mode: AgentConfig.DIR_MODE });
			}
			await writeFile(probe, "", { flag: "wx", mode: AgentConfig.FILE_MODE });
			await rm(probe, { force: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EACCES" || code === "EPERM") {
				throw new ConfigError(`Can't write ${path} (permission denied). Run it with sudo.`);
			}
			const reason = error instanceof Error ? error.message : String(error);
			throw new ConfigError(`Can't write ${path}: ${reason}`);
		}
	}

	/** The config with SSH keys: the existing ones, or new ones if it has none. */
	static withSshKeys(config: AgentConfig.Data): { config: AgentConfig.Data; created: boolean } {
		if (config.ssh_keys) return { config, created: false };
		return { config: { ...config, ssh_keys: SshKeys.generate(config.agent_id) }, created: true };
	}

	/** The bearer credential: `netignite_agent_<token_id>:<secret>`. */
	static credential(config: AgentConfig.Data) {
		return `${AgentConfig.AGENT_TOKEN_PREFIX}${config.token_id}:${config.secret}`;
	}
}

export namespace AgentConfig {
	export type Data = z.infer<typeof AgentConfig.Schema>;

	export type Owner = { uid: number; gid: number };
}

export class ConfigError extends AppError {}
