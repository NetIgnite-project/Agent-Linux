import { tmpdir } from "node:os";
import { win32 } from "node:path";
import type { InstallPlan } from "../installPlan";
import type { WindowsFacts } from "./windowsFacts";
import { WindowsFiles } from "./windowsFiles";
import { WindowsPolicy } from "./windowsPolicy";

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
		steps.push(...WindowsPlan.shutdownRight(options.policy, "add"));
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
			// The agent's account doesn't need the config anymore: its read access goes too.
			steps.push({
				type: "run",
				argv: WindowsFiles.configAclUninstall(configDir),
				ignoreFailure: true,
			});
		}
		steps.push(...WindowsPlan.shutdownRight(options.policy, "remove"));
		return steps;
	}

	/**
	 * Grants (`mode: "add"`) or takes back (`remove`) LOCAL SERVICE's right to shut the machine
	 * down: the plan rewrites the `SeShutdownPrivilege` line of the policy that the command
	 * exported at its start ({@link WindowsFacts.policy}) and secedit applies the file. Without
	 * facts (`--dry-run` as a non-admin, or a failed export) there are no steps.
	 */
	private static shutdownRight(
		policy: WindowsFacts.Policy | null | undefined,
		mode: "add" | "remove",
	): InstallPlan.Step[] {
		const changed = !policy
			? null
			: mode === "add"
				? WindowsPolicy.merge(policy.text)
				: WindowsPolicy.split(policy.text);
		if (changed === null) return [];

		const base = win32.join(tmpdir(), `netignite-secedit-${process.pid}`);
		const inf = `${base}.inf`;
		const db = `${base}.sdb`;
		return [
			{ type: "remove", path: inf },
			{ type: "remove", path: db },
			{ type: "write", path: inf, content: changed, mode: 0o600, encoding: policy?.encoding },
			{ type: "run", argv: ["secedit", "/configure", "/db", db, "/cfg", inf, "/quiet"] },
			{ type: "remove", path: inf },
			{ type: "remove", path: db },
		];
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
		/** The exported local policy; without it the shutdown right isn't touched. */
		policy?: WindowsFacts.Policy | null;
	};

	export type UninstallOptions = {
		binaryTarget: string;
		configPath: string;
		purge: boolean;
		/** The exported local policy; without it the shutdown right isn't touched. */
		policy?: WindowsFacts.Policy | null;
	};
}
