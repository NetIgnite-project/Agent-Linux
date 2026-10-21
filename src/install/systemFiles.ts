import { posix } from "node:path";
import { AppConstants } from "../utils/constants";
import { AppError } from "../utils/errors";

/** Contents of the files `install` writes. Pure functions, so they can be tested. */
export class SystemFiles {
	static readonly UNIT_PATH = `/etc/systemd/system/${AppConstants.SERVICE_NAME}.service`;
	static readonly POLKIT_RULES_PATH = `/etc/polkit-1/rules.d/50-${AppConstants.SERVICE_NAME}.rules`;
	/** polkit < 0.106 (Debian 11, Ubuntu ≤ 22.10) reads `.pkla` files instead of JavaScript rules. */
	static readonly POLKIT_LEGACY_DIR = "/etc/polkit-1/localauthority";
	static readonly POLKIT_PKLA_PATH =
		`/etc/polkit-1/localauthority/50-local.d/50-${AppConstants.SERVICE_NAME}.pkla`;

	/**
	 * Exit status of `run` when the server rejected the credential (EX_CONFIG). The unit doesn't
	 * restart the agent then: only pairing again helps.
	 */
	static readonly EXIT_CREDENTIAL_REJECTED = 78;

	/**
	 * The logind actions behind `systemctl poweroff` and `systemctl reboot`, and nothing else.
	 * `*-multiple-sessions` is checked when other users are logged in (e.g. over SSH). The
	 * `*-ignore-inhibit` actions are left out on purpose: a block inhibitor (a running package
	 * upgrade, for example) keeps stopping a remote shutdown.
	 */
	static readonly POWER_ACTIONS = [
		"org.freedesktop.login1.power-off",
		"org.freedesktop.login1.power-off-multiple-sessions",
		"org.freedesktop.login1.reboot",
		"org.freedesktop.login1.reboot-multiple-sessions",
	] as const;

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
			"# Hardening. The agent talks to the server, sends Wake-on-LAN packets, runs ping and ip, and",
			"# runs `systemctl poweroff|reboot`. Those go to logind over D-Bus and polkit allows them (see",
			`# ${SystemFiles.POLKIT_RULES_PATH}), so NoNewPrivileges= doesn't get in the way: only setuid`,
			"# helpers such as sudo or pkexec would need new privileges. The seccomp-based options below",
			"# imply NoNewPrivileges= for a service with User= anyway. The agent never writes to the disk.",
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

	/** polkit ≥ 0.106 rule (ES5: older polkit versions use an old JavaScript engine). */
	static polkitRules(user: string) {
		SystemFiles.assertSafeUser(user);
		const actions = SystemFiles.POWER_ACTIONS.map((action) => `\t\t"${action}"`).join(",\n");

		return [
			`// Written by \`${AppConstants.BINARY_NAME} install\`: lets the ${AppConstants.APP_NAME}`,
			`// service user "${user}" power off and reboot this machine, and nothing else.`,
			"polkit.addRule(function (action, subject) {",
			"\tvar allowed = [",
			actions,
			"\t];",
			`\tif (subject.user == "${user}" && allowed.indexOf(action.id) >= 0) {`,
			"\t\treturn polkit.Result.YES;",
			"\t}",
			"});",
			"",
		].join("\n");
	}

	/** The same permission for polkit < 0.106. */
	static polkitPkla(user: string) {
		SystemFiles.assertSafeUser(user);

		return [
			`# Written by \`${AppConstants.BINARY_NAME} install\`: lets the ${AppConstants.APP_NAME}`,
			`# service user "${user}" power off and reboot this machine, and nothing else.`,
			`[${AppConstants.APP_NAME} power control]`,
			`Identity=unix-user:${user}`,
			`Action=${SystemFiles.POWER_ACTIONS.join(";")}`,
			"ResultAny=yes",
			"ResultInactive=yes",
			"ResultActive=yes",
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
