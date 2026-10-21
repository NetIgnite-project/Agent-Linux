import { chmod, copyFile, mkdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { AppError } from "../utils/errors";
import { Logger } from "../utils/logger";
import { InstallPlan } from "./installPlan";

/** Executes an {@link InstallPlan} (or, for `--dry-run`, only prints it). */
export class PlanRunner {
	static async run(steps: InstallPlan.Step[], options: { dryRun: boolean }) {
		if (options.dryRun) {
			Logger.info(`Dry run, nothing is changed. The ${steps.length} steps would be:`);
			for (const step of steps) PlanRunner.print(step);
			return;
		}

		for (const step of steps) {
			Logger.debug(InstallPlan.describe(step));
			await PlanRunner.execute(step);
		}
	}

	private static print(step: InstallPlan.Step) {
		const description = InstallPlan.describe(step);
		if (step.type !== "write") {
			Logger.info(`  ${description}`);
			return;
		}
		const content = step.content
			.trimEnd()
			.split("\n")
			.map((line) => `      | ${line}`)
			.join("\n");
		Logger.info(`  ${description}\n${content}`);
	}

	private static async execute(step: InstallPlan.Step) {
		switch (step.type) {
			case "run":
				return await PlanRunner.runCommand(step.argv, step.ignoreFailure ?? false);

			case "write": {
				// Write next to the target and rename, so a crash never leaves half a file.
				const temp = `${step.path}.netignite-tmp`;
				await writeFile(temp, step.content, { mode: step.mode });
				await chmod(temp, step.mode);
				await rename(temp, step.path);
				return;
			}

			case "copy": {
				// Rename over the target: replacing a running binary in place fails (ETXTBSY).
				const temp = `${step.to}.netignite-tmp`;
				await copyFile(step.from, temp);
				await chmod(temp, step.mode);
				await rename(temp, step.to);
				return;
			}

			case "mkdir":
				try {
					await stat(step.path);
				} catch {
					await mkdir(step.path, { recursive: true, mode: step.mode });
				}
				return;

			case "remove":
				await rm(step.path, { force: true });
				return;

			case "rmdir":
				try {
					await rmdir(step.path);
				} catch {
					Logger.debug(`Kept ${step.path} (not empty)`);
				}
				return;
		}
	}

	private static async runCommand(argv: string[], ignoreFailure: boolean) {
		let exitCode: number;
		let stderr = "";
		try {
			const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
			[exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		} catch (error) {
			if (ignoreFailure) return;
			throw new AppError(
				`Couldn't run ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		if (exitCode === 0) return;

		const message = `"${argv.join(" ")}" failed (exit ${exitCode})${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
		if (ignoreFailure) {
			Logger.debug(message);
			return;
		}
		throw new AppError(message);
	}
}
