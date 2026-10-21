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

	private static logHistory: string[] = [];

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

	private static record(level: string, args: unknown[]) {
		this.logHistory.push(
			`[${new Date(Date.now()).toISOString()}] [${level}] ${args
				.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
				.join(" ")}`,
		);
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
