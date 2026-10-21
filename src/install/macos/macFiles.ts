import type { HostControl } from "../../agent/hostControl";
import { AppError } from "../../utils/errors";

/**
 * macOS: the agent runs as a launchd daemon under the hidden system user `_netignite`, which has
 * no right to shut the Mac down. Like on Linux it can only ask: it creates a file in its own
 * request directory, and a root daemon per action (launchd `QueueDirectories`) runs
 * `/sbin/shutdown` and nothing else.
 */
export class MacFiles {
	static readonly LABEL = "dev.netignite.agent";
	static readonly SERVICE_USER = "_netignite";
	static readonly PLIST_DIR = "/Library/LaunchDaemons";
	/** Request directories, one per action (owned by the agent's user, mode 0700). */
	static readonly STATE_DIR = "/usr/local/var/netignite-agent";
	static readonly LOG_DIR = "/usr/local/var/log/netignite-agent";

	static plistPath(label: string) {
		return `${MacFiles.PLIST_DIR}/${label}.plist`;
	}

	static powerLabel(action: HostControl.Action) {
		return `${MacFiles.LABEL}.${action}`;
	}

	static requestDir(action: HostControl.Action) {
		return `${MacFiles.STATE_DIR}/${action}`;
	}

	static requestPath(action: HostControl.Action) {
		return `${MacFiles.requestDir(action)}/request`;
	}

	static logFile() {
		return `${MacFiles.LOG_DIR}/agent.log`;
	}

	static actions(): HostControl.Action[] {
		return ["shutdown", "reboot"];
	}

	/** Paths go into the property lists and a shell script: plain absolute paths only. */
	static assertSafePath(path: string, what: string) {
		if (!/^\/[A-Za-z0-9._/@+-]*$/.test(path) || path.includes("/../")) {
			throw new AppError(
				`The ${what} path "${path}" must be absolute and use only letters, digits and . _ / @ + -`,
			);
		}
	}

	/** The agent's daemon: runs as `_netignite`, restarted by launchd, logs to its own file. */
	static agentPlist(options: { binaryPath: string; configPath: string }) {
		MacFiles.assertSafePath(options.binaryPath, "binary");
		MacFiles.assertSafePath(options.configPath, "config");
		return plist([
			key("Label", string(MacFiles.LABEL)),
			key(
				"ProgramArguments",
				array([
					options.binaryPath,
					"run",
					"--config",
					options.configPath,
					"--log-file",
					MacFiles.logFile(),
				]),
			),
			key("UserName", string(MacFiles.SERVICE_USER)),
			key("GroupName", string(MacFiles.SERVICE_USER)),
			key("RunAtLoad", "<true/>"),
			key("KeepAlive", "<true/>"),
			// Restarted at most once a minute (after a crash, or when the server rejected the credential).
			key("ThrottleInterval", "<integer>60</integer>"),
			key("Umask", "<integer>63</integer>"),
			key("StandardOutPath", string("/dev/null")),
			key("StandardErrorPath", string("/dev/null")),
			key("ProcessType", string("Background")),
		]);
	}

	/**
	 * Empties the request directory first (launchd keeps the job running while it isn't empty),
	 * then shuts down or restarts, only if the request is less than a minute old. The script never
	 * reads what the agent wrote: only the file's age counts. `paths` are for tests.
	 */
	static powerScript(
		action: HostControl.Action,
		paths: { dir: string; shutdown: string } = {
			dir: MacFiles.requestDir(action),
			shutdown: "/sbin/shutdown",
		},
	) {
		const flag = action === "shutdown" ? "-h" : "-r";
		return [
			// Prints the file if it was modified within the last minute; nothing if it's older or gone.
			`fresh=$(find "${paths.dir}/request" -mmin -1 2>/dev/null)`,
			`rm -rf "${paths.dir}"/* "${paths.dir}"/.[!.]*`,
			`[ -n "$fresh" ] && exec ${paths.shutdown} ${flag} now`,
			"exit 0",
		].join("\n");
	}

	/** The root daemon of an action: runs {@link powerScript} when its request directory fills. */
	static powerPlist(action: HostControl.Action) {
		return plist([
			key("Label", string(MacFiles.powerLabel(action))),
			key("ProgramArguments", array(["/bin/sh", "-c", MacFiles.powerScript(action)])),
			key("QueueDirectories", array([MacFiles.requestDir(action)])),
			key("StandardOutPath", string("/dev/null")),
			key("StandardErrorPath", string("/dev/null")),
		]);
	}

	/** Every launchd label `install` sets up: the agent and the two root daemons. */
	static labels() {
		return [MacFiles.LABEL, ...MacFiles.actions().map((action) => MacFiles.powerLabel(action))];
	}
}

function plist(entries: string[]) {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		...entries,
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}

function key(name: string, value: string) {
	return `\t<key>${name}</key>\n\t${value}`;
}

function string(value: string) {
	return `<string>${xmlEscape(value)}</string>`;
}

function array(values: string[]) {
	return `<array>\n${values.map((value) => `\t\t${string(value)}`).join("\n")}\n\t</array>`;
}

function xmlEscape(text: string) {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
