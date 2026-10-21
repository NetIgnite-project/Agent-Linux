import { win32 } from "node:path";
import type { InstallPlan } from "../installPlan";
import { WindowsFiles } from "./windowsFiles";

/** What `install` and `uninstall` do on Windows, as steps for the PlanRunner. */
export class WindowsPlan {
	static install(options: WindowsPlan.InstallOptions): InstallPlan.Step[] {
		const { binarySource, binaryTarget, configPath } = options;
		const configDir = WindowsFiles.configDir(configPath);
		const logDir = WindowsFiles.logDir(configPath);
		const taskFile = win32.join(configDir, "task.xml");
		const task = WindowsFiles.TASK_NAME;
		const steps: InstallPlan.Step[] = [];

		steps.push({ type: "mkdir", path: win32.dirname(binaryTarget), mode: 0o755 });
		if (binarySource !== binaryTarget) {
			// Windows can't replace a running executable: stop the agent first.
			steps.push(
				{ type: "run", argv: ["schtasks", "/End", "/TN", task], ignoreFailure: true },
				{ type: "copy", from: binarySource, to: binaryTarget, mode: 0o755 },
			);
		}

		steps.push(
			{ type: "run", argv: WindowsFiles.configAcl(configDir) },
			{ type: "mkdir", path: logDir, mode: 0o755 },
			{ type: "run", argv: WindowsFiles.logAcl(logDir) },
			{
				type: "write",
				path: taskFile,
				content: WindowsFiles.taskXml({ binaryPath: binaryTarget, configPath }),
				mode: 0o600,
				encoding: "utf16le-bom",
			},
			{ type: "run", argv: ["schtasks", "/Create", "/TN", task, "/XML", taskFile, "/F"] },
			{ type: "remove", path: taskFile },
			{ type: "run", argv: ["schtasks", "/End", "/TN", task], ignoreFailure: true },
			{ type: "run", argv: ["schtasks", "/Run", "/TN", task] },
		);
		return steps;
	}

	static uninstall(options: WindowsPlan.UninstallOptions): InstallPlan.Step[] {
		const { binaryTarget, configPath, purge } = options;
		const configDir = WindowsFiles.configDir(configPath);
		const logDir = WindowsFiles.logDir(configPath);
		const logFile = WindowsFiles.logFile(configPath);
		const task = WindowsFiles.TASK_NAME;

		const steps: InstallPlan.Step[] = [
			{ type: "run", argv: ["schtasks", "/End", "/TN", task], ignoreFailure: true },
			{ type: "run", argv: ["schtasks", "/Delete", "/TN", task, "/F"], ignoreFailure: true },
			{ type: "remove", path: binaryTarget },
			{ type: "rmdir", path: win32.dirname(binaryTarget) },
			{ type: "remove", path: logFile },
			{ type: "remove", path: `${logFile}.1` },
			{ type: "rmdir", path: logDir },
		];
		if (purge) {
			steps.push({ type: "remove", path: configPath }, { type: "rmdir", path: configDir });
		} else {
			// The agent's account doesn't need the config anymore.
			steps.push({
				type: "run",
				argv: WindowsFiles.configAclAdminsOnly(configDir),
				ignoreFailure: true,
			});
		}
		return steps;
	}

	/** After `pair`: restart a running agent with the new credential. */
	static restart(): InstallPlan.Step[] {
		return [
			{ type: "run", argv: ["schtasks", "/End", "/TN", WindowsFiles.TASK_NAME], ignoreFailure: true },
			{ type: "run", argv: ["schtasks", "/Run", "/TN", WindowsFiles.TASK_NAME] },
		];
	}
}

export namespace WindowsPlan {
	export type InstallOptions = {
		/** The running binary. */
		binarySource: string;
		/** Where the task runs it from. */
		binaryTarget: string;
		configPath: string;
	};

	export type UninstallOptions = {
		binaryTarget: string;
		configPath: string;
		purge: boolean;
	};
}
