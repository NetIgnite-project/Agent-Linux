import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";

/**
 * Logger (CLI) — the backend Logger plus a `logHistory` buffer for crash dumps.
 *
 * CLI tools keep a buffer of recent log lines so that on a critical failure they can dump the
 * last lines to a notification (ntfy) or stderr before exiting (`Logger.getLogHistory()`).
 * Web services use the simpler `shared/backend/src/utils/logger.ts`. See docs/09-config-and-logging.md
 * and docs/11-cli-and-infra.md.
 */
export class Logger {
	private static readonly logLevelMap = {
		debug: 0,
		info: 1,
		warn: 2,
		error: 3,
		critical: 4,
	} as const;

	private static logLevel: (typeof this.logLevelMap)[Logger.LogLevel] = this.logLevelMap.info;

	/** The last lines, for crash dumps. Capped: the agent runs for months. */
	private static logHistory: string[] = [];
	static readonly HISTORY_LINES = 200;

	/** Also append every line to this file (Windows' scheduled task has no console). */
	private static logFile: { path: string; maxBytes: number } | null = null;

	static setLogLevel(level: Logger.LogLevel) {
		if (this.logLevelMap[level] === undefined) {
			throw new Error(`Invalid log level: ${level}`);
		}
		this.logLevel = this.logLevelMap[level];
	}

	static getLogLevel(): Logger.LogLevel {
		const match = Object.entries(this.logLevelMap).find(([, value]) => value === this.logLevel);
		return (match ? match[0] : "info") as Logger.LogLevel;
	}

	static getLogHistory(): string[] {
		return this.logHistory;
	}

	/**
	 * Writes the log to `path` too. When it grows past `maxBytes`, it moves to `<path>.1` (replacing
	 * the previous one) and a new file starts, so at most twice `maxBytes` stay on disk.
	 */
	static setFile(path: string | null, maxBytes = 1024 * 1024) {
		this.logFile = path ? { path, maxBytes } : null;
	}

	private static record(level: string, args: unknown[]) {
		const line = `[${new Date(Date.now()).toISOString()}] [${level}] ${args
			.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
			.join(" ")}`;
		this.logHistory.push(line);
		if (this.logHistory.length > Logger.HISTORY_LINES) this.logHistory.shift();
		if (this.logFile) this.writeFile(this.logFile, line);
	}

	private static writeFile(file: { path: string; maxBytes: number }, line: string) {
		try {
			if (existsSync(file.path) && statSync(file.path).size > file.maxBytes) {
				renameSync(file.path, `${file.path}.1`);
			}
			appendFileSync(file.path, `${line}\n`);
		} catch {
			// The log file is a convenience; never fail because of it.
		}
	}

	static debug(...args: unknown[]) {
		if (this.logLevel <= this.logLevelMap.debug) {
			this.record("DEBUG", args);
			console.debug(`[${new Date(Date.now()).toISOString()}]`, "[DEBUG]", ...args);
		}
	}

	static log(...args: unknown[]) {
		if (this.logLevel <= this.logLevelMap.info) {
			this.record("INFO", args);
			console.log(`[${new Date(Date.now()).toISOString()}]`, "[INFO]", ...args);
		}
	}

	static info(...args: unknown[]) {
		if (this.logLevel <= this.logLevelMap.info) {
			this.record("INFO", args);
			console.info(`[${new Date(Date.now()).toISOString()}]`, "[INFO]", ...args);
		}
	}

	static warn(...args: unknown[]) {
		if (this.logLevel <= this.logLevelMap.warn) {
			this.record("WARN", args);
			console.warn(`[${new Date(Date.now()).toISOString()}]`, "[WARN]", ...args);
		}
	}

	static error(...args: unknown[]) {
		if (this.logLevel <= this.logLevelMap.error) {
			this.record("ERROR", args);
			console.error(`[${new Date(Date.now()).toISOString()}]`, "[ERROR]", ...args);
		}
	}

	static critical(...args: unknown[]) {
		if (this.logLevel <= this.logLevelMap.critical) {
			this.record("CRITICAL", args);
			console.error(`[${new Date(Date.now()).toISOString()}]`, "[CRITICAL]", ...args);
		}
	}
}

export namespace Logger {
	export type LogLevel = "debug" | "info" | "warn" | "error" | "critical";
}
