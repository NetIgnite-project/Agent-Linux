import { posix } from "node:path";
import type { HostControl } from "../agent/hostControl";
import { AppConstants } from "../utils/constants";
import { AppError } from "../utils/errors";

/** Contents of the files `install` writes. Pure functions, so they can be tested. */
export class SystemFiles {
	static readonly UNIT_DIR = "/etc/systemd/system";
	static readonly UNIT_PATH = `${SystemFiles.UNIT_DIR}/${AppConstants.SERVICE_NAME}.service`;

	/**
	 * The service's `RuntimeDirectory=` (a tmpfs, owned by the service user, mode 0700). The agent
	 * asks for a shutdown or reboot by creating a file here; nobody but that user and root can.
	 */
	static readonly RUNTIME_DIR = `/run/${AppConstants.SERVICE_NAME}`;

	/** The two fixed actions and the `systemctl` verb behind each. */
	static readonly POWER_ACTIONS = { shutdown: "poweroff", reboot: "reboot" } as const;

	/** polkit rules written by versions before 1.0.0; `install` and `uninstall` remove them. */
	static readonly LEGACY_POLKIT_FILES = [
		`/etc/polkit-1/rules.d/50-${AppConstants.SERVICE_NAME}.rules`,
		`/etc/polkit-1/localauthority/50-local.d/50-${AppConstants.SERVICE_NAME}.pkla`,
	] as const;

	/**
	 * Exit status of `run` when the server rejected the credential (EX_CONFIG). The unit doesn't
	 * restart the agent then: only pairing again helps.
	 */
	static readonly EXIT_CREDENTIAL_REJECTED = 78;

	/** The file the agent creates to ask for `action`. */
	static requestPath(action: HostControl.Action) {
		return `${SystemFiles.RUNTIME_DIR}/${action}`;
	}

	/** `netignite-agent-shutdown` / `netignite-agent-reboot`: the name of its .path and .service. */
	static powerUnitName(action: HostControl.Action) {
		return `${AppConstants.SERVICE_NAME}-${action}`;
	}

	/** The .path and .service unit files of both actions. */
	static powerUnitPaths() {
		return SystemFiles.actions().flatMap((action) => [
			`${SystemFiles.UNIT_DIR}/${SystemFiles.powerUnitName(action)}.path`,
			`${SystemFiles.UNIT_DIR}/${SystemFiles.powerUnitName(action)}.service`,
		]);
	}

	static actions() {
		return Object.keys(SystemFiles.POWER_ACTIONS) as HostControl.Action[];
	}

	/** `ProtectHome=yes` hides these from the service, so the config can't live there. */
	static readonly HIDDEN_FROM_SERVICE = ["/home", "/root", "/run/user"];

	/** Paths end up in the unit file unquoted, so only plain absolute paths are allowed. */
	static assertSafePath(path: string, what: string) {
		if (!/^\/[A-Za-z0-9._/@+-]*$/.test(path) || path.includes("/../") || path.endsWith("/..")) {
			throw new AppError(
				`The ${what} path "${path}" must be absolute and use only letters, digits and . _ / @ + -`,
			);
		}
	}

	static unit(options: SystemFiles.UnitOptions) {
		SystemFiles.assertSafeUser(options.user);
		SystemFiles.assertSafePath(options.binaryPath, "binary");
		SystemFiles.assertSafePath(options.configPath, "config");
		const hidden = SystemFiles.HIDDEN_FROM_SERVICE.find(
			(dir) => options.configPath === dir || options.configPath.startsWith(`${dir}/`),
		);
		if (hidden) {
			throw new AppError(
				`The service can't read a config below ${hidden} (ProtectHome=yes). Use a path such as ${AppConstants.DEFAULT_CONFIG_PATH}.`,
			);
		}

		// Wake-on-LAN mode runs `ping`. With NoNewPrivileges, ping's own file capability or setuid
		// bit doesn't apply, so the service hands CAP_NET_RAW down (ambient). Host mode needs none.
		const capabilities = options.wol
			? ["CapabilityBoundingSet=CAP_NET_RAW", "AmbientCapabilities=CAP_NET_RAW"]
			: ["CapabilityBoundingSet="];

		return [
			`# Written by \`${AppConstants.BINARY_NAME} install\`; the next install or \`wol-mode on|off\` overwrites it.`,
			`# Use \`systemctl edit ${AppConstants.SERVICE_NAME}\` for local changes.`,
			"[Unit]",
			`Description=${AppConstants.APP_NAME}`,
			"Documentation=https://github.com/NetIgnite-project/Agent-Linux",
			"Wants=network-online.target",
			"After=network-online.target",
			"",
			"[Service]",
			"Type=simple",
			`User=${options.user}`,
			`Group=${options.user}`,
			`ExecStart=${options.binaryPath} run --config ${options.configPath}`,
			"Restart=always",
			"RestartSec=5",
			`# ${SystemFiles.EXIT_CREDENTIAL_REJECTED}: the server rejected the credential. Restarting doesn't help; pair again.`,
			`RestartPreventExitStatus=${SystemFiles.EXIT_CREDENTIAL_REJECTED}`,
			"TimeoutStopSec=10",
			"",
			"# Shutdown and reboot: the agent creates shutdown or reboot in its RuntimeDirectory, and",
			`# ${SystemFiles.powerUnitName("shutdown")}.path / ${SystemFiles.powerUnitName("reboot")}.path start a root unit that runs`,
			"# systemctl poweroff|reboot. The agent itself needs no privileges for it.",
			`RuntimeDirectory=${AppConstants.SERVICE_NAME}`,
			"RuntimeDirectoryMode=0700",
			"",
			"# Hardening. The agent talks to the server, sends Wake-on-LAN packets and runs ping and ip.",
			"# It writes nothing but the requests above (ProtectSystem=strict keeps RuntimeDirectory=",
			"# writable).",
			"NoNewPrivileges=yes",
			"ProtectSystem=strict",
			"ProtectHome=yes",
			"PrivateTmp=yes",
			"PrivateDevices=yes",
			`ReadOnlyPaths=${posix.dirname(options.configPath)}`,
			"ProtectKernelTunables=yes",
			"ProtectKernelModules=yes",
			"ProtectKernelLogs=yes",
			"ProtectControlGroups=yes",
			"ProtectClock=yes",
			"ProtectHostname=yes",
			"RestrictNamespaces=yes",
			"RestrictRealtime=yes",
			"RestrictSUIDSGID=yes",
			"LockPersonality=yes",
			"SystemCallArchitectures=native",
			"UMask=0077",
			"RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
			...capabilities,
			"",
			"[Install]",
			"WantedBy=multi-user.target",
			"",
		].join("\n");
	}

	/** The `--config` path in a unit written by {@link unit}, or null. */
	static unitConfigPath(unitText: string) {
		return /^ExecStart=\S+ run --config (\S+)\s*$/m.exec(unitText)?.[1] ?? null;
	}

	/**
	 * Starts the action's root unit when the agent creates its request file. `PathExists=` doesn't
	 * fire when the file (or the whole RuntimeDirectory, when the agent stops) is removed.
	 */
	static powerPathUnit(action: HostControl.Action) {
		const name = SystemFiles.powerUnitName(action);
		return [
			`# Written by \`${AppConstants.BINARY_NAME} install\`: starts ${name}.service when the`,
			`# ${AppConstants.APP_NAME} asks for a ${action} by creating ${SystemFiles.requestPath(action)}.`,
			`# Only the agent's user and root can write to ${SystemFiles.RUNTIME_DIR}.`,
			"[Unit]",
			`Description=${AppConstants.APP_NAME}: ${action} requests`,
			"Documentation=https://github.com/NetIgnite-project/Agent-Linux",
			"",
			"[Path]",
			`PathExists=${SystemFiles.requestPath(action)}`,
			`Unit=${name}.service`,
			"",
			"[Install]",
			"WantedBy=multi-user.target",
			"",
		].join("\n");
	}

	/** Runs `systemctl poweroff|reboot` as root, and nothing else. */
	static powerServiceUnit(action: HostControl.Action) {
		const name = SystemFiles.powerUnitName(action);
		const description = action === "shutdown" ? "shut down" : "reboot";
		return [
			`# Written by \`${AppConstants.BINARY_NAME} install\`: the ${action} the ${AppConstants.APP_NAME} asked for`,
			`# (see ${name}.path).`,
			"[Unit]",
			`Description=${AppConstants.APP_NAME}: ${description} this machine`,
			"Documentation=https://github.com/NetIgnite-project/Agent-Linux",
			"",
			"[Service]",
			"Type=oneshot",
			"# Remove the request first: while it exists, the .path unit would start this unit again.",
			`ExecStart=rm -f ${SystemFiles.requestPath(action)}`,
			`ExecStart=systemctl --no-block ${SystemFiles.POWER_ACTIONS[action]}`,
			"",
		].join("\n");
	}

	private static assertSafeUser(user: string) {
		if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) {
			throw new AppError(`Invalid user name "${user}"`);
		}
	}
}

export namespace SystemFiles {
	export type UnitOptions = {
		binaryPath: string;
		configPath: string;
		user: string;
		/** Wake-on-LAN mode needs CAP_NET_RAW for ping. */
		wol: boolean;
	};
}
