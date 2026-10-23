import { win32 } from "node:path";
import type { HostControl } from "../../agent/hostControl";
import { AppConstants } from "../../utils/constants";
import { AppError } from "../../utils/errors";

/**
 * Windows: the agent runs as a scheduled task started at boot, as `LOCAL SERVICE`. That account
 * has no rights to the user's files or the system, and no right to shut the machine down either
 * (which `shutdown.exe` needs) — `install` grants it via the local security policy, see
 * {@link WindowsPolicy}.
 *
 * Accounts are named by their well-known SIDs: the names are translated (German Windows calls
 * `LOCAL SERVICE` "LOKALER DIENST").
 */
export class WindowsFiles {
	static readonly TASK_NAME = "NetIgnite Agent";

	static readonly SID = {
		localService: "S-1-5-19",
		system: "S-1-5-18",
		administrators: "S-1-5-32-544",
	} as const;

	/** The current process's user SID, asked for once (see {@link currentSid}). */
	private static sid: Promise<string | null> | null = null;

	static configDir(configPath: string) {
		return win32.dirname(configPath);
	}

	static logDir(configPath: string) {
		return win32.join(WindowsFiles.configDir(configPath), "logs");
	}

	static logFile(configPath: string) {
		return win32.join(WindowsFiles.logDir(configPath), "agent.log");
	}

	/** Paths end up quoted in the task's command line, so no quotes, and absolute. */
	static assertSafePath(path: string, what: string) {
		if (!/^[A-Za-z]:\\[^"<>|*?\r\n]*$/.test(path)) {
			throw new AppError(`The ${what} path "${path}" must be an absolute Windows path without quotes`);
		}
	}

	/** The task, in Task Scheduler's XML (written as UTF-16, which `schtasks /XML` expects). */
	static taskXml(options: { binaryPath: string; configPath: string }) {
		WindowsFiles.assertSafePath(options.binaryPath, "binary");
		WindowsFiles.assertSafePath(options.configPath, "config");
		const args = `run --config "${options.configPath}" --log-file "${WindowsFiles.logFile(options.configPath)}"`;

		return [
			'<?xml version="1.0" encoding="UTF-16"?>',
			'<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
			"  <RegistrationInfo>",
			`    <Description>${xml(`${AppConstants.APP_NAME}: reports this PC to its NetIgnite server and shuts it down or restarts it when asked. Written by "${AppConstants.BINARY_NAME} install".`)}</Description>`,
			"  </RegistrationInfo>",
			"  <Triggers>",
			"    <BootTrigger>",
			"      <Enabled>true</Enabled>",
			"    </BootTrigger>",
			"  </Triggers>",
			"  <Principals>",
			'    <Principal id="Agent">',
			`      <UserId>${WindowsFiles.SID.localService}</UserId>`,
			"      <RunLevel>LeastPrivilege</RunLevel>",
			"    </Principal>",
			"  </Principals>",
			"  <Settings>",
			"    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
			"    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
			"    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
			"    <AllowHardTerminate>true</AllowHardTerminate>",
			"    <StartWhenAvailable>true</StartWhenAvailable>",
			"    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
			"    <IdleSettings>",
			"      <StopOnIdleEnd>false</StopOnIdleEnd>",
			"      <RestartOnIdle>false</RestartOnIdle>",
			"    </IdleSettings>",
			"    <AllowStartOnDemand>true</AllowStartOnDemand>",
			"    <Enabled>true</Enabled>",
			"    <Hidden>false</Hidden>",
			"    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
			"    <WakeToRun>false</WakeToRun>",
			"    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
			"    <Priority>7</Priority>",
			"    <RestartOnFailure>",
			"      <Interval>PT1M</Interval>",
			"      <Count>999</Count>",
			"    </RestartOnFailure>",
			"  </Settings>",
			'  <Actions Context="Agent">',
			"    <Exec>",
			`      <Command>${xml(options.binaryPath)}</Command>`,
			`      <Arguments>${xml(args)}</Arguments>`,
			"    </Exec>",
			"  </Actions>",
			"</Task>",
			"",
		].join("\r\n");
	}

	/**
	 * `icacls` on the config directory: only SYSTEM and Administrators, plus read for the agent
	 * (LOCAL SERVICE). Inherited permissions (ProgramData lets every user read) are removed.
	 */
	static configAcl(configDir: string) {
		const { system, administrators, localService } = WindowsFiles.SID;
		return [
			"icacls",
			configDir,
			"/inheritance:r",
			"/grant:r",
			`*${system}:(OI)(CI)F`,
			`*${administrators}:(OI)(CI)F`,
			`*${localService}:(OI)(CI)RX`,
		];
	}

	/**
	 * The same without the agent, plus a grant for `creatorSid`: what `pair` sets for the folder it
	 * just created, so the secret is readable only for SYSTEM, Administrators and the account that
	 * runs the agent setup (until `install` replaces this with {@link configAcl}).
	 */
	static configAclAdminsOnly(configDir: string, creatorSid?: string) {
		const { system, administrators } = WindowsFiles.SID;
		const argv = [
			"icacls",
			configDir,
			"/inheritance:r",
			"/grant:r",
			`*${system}:(OI)(CI)F`,
			`*${administrators}:(OI)(CI)F`,
		];
		if (creatorSid) argv.push(`*${creatorSid}:(OI)(CI)F`);
		return argv;
	}

	/** The current user's SID (`whoami`), or null if it can't be determined. Memoized. */
	static async currentSid(): Promise<string | null> {
		WindowsFiles.sid ??= (async () => {
			try {
				const child = Bun.spawn(
					[
						"powershell.exe",
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						"[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
					],
					{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
				);
				const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
				const sid = stdout.trim();
				return code === 0 && /^S-1-[0-9-]+$/.test(sid) ? sid : null;
			} catch {
				return null;
			}
		})();
		return WindowsFiles.sid;
	}

	/** The agent may write its log (and nothing else). */
	static logAcl(logDir: string) {
		return ["icacls", logDir, "/grant:r", `*${WindowsFiles.SID.localService}:(OI)(CI)M`];
	}

	/** `shutdown.exe` with the fixed arguments: now, reason "Other (Planned)". */
	static shutdownCommand(action: HostControl.Action) {
		const systemRoot = process.env.SystemRoot || "C:\\Windows";
		return [
			win32.join(systemRoot, "System32", "shutdown.exe"),
			action === "shutdown" ? "/s" : "/r",
			"/t",
			"0",
			"/d",
			"p:0:0",
		];
	}
}

function xml(text: string) {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
