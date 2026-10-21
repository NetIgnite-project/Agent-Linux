import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

/** The repository root (the CLI runs from here). */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** A fresh temporary directory; remove it with {@link removeTempDir}. */
export function makeTempDir() {
	return mkdtemp(join(tmpdir(), "netignite-agent-test-"));
}

export async function removeTempDir(dir: string) {
	await rm(dir, { recursive: true, force: true });
}

/** Starts `bun src/index.ts <args>` (the CLI as users run it, minus the compile step). */
export function spawnCLI(args: string[]) {
	return Bun.spawn([process.execPath, "src/index.ts", ...args], {
		cwd: REPO_ROOT,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1" },
	});
}

/** Collects a CLI process's output. */
export async function finishCLI(child: Subprocess<"ignore", "pipe", "pipe">) {
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr, output: `${stdout}\n${stderr}` };
}

/** Runs the CLI to completion. */
export async function runCLI(args: string[], timeoutMs = 20_000) {
	const child = spawnCLI(args);
	const timer = setTimeout(() => child.kill(), timeoutMs);
	try {
		return await finishCLI(child);
	} finally {
		clearTimeout(timer);
	}
}
