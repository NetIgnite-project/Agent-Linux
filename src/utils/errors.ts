import { Logger } from "./logger";

/** An error with a message meant for the user (no stack trace needed). */
export class AppError extends Error {}

/** Logs an error from a command: just the message for {@link AppError}s, everything otherwise. */
export function reportError(error: unknown) {
	if (error instanceof AppError) {
		Logger.error(error.message);
	} else {
		Logger.error("Unexpected error:", error);
	}
}
