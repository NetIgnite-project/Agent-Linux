import { isIP } from "node:net";
import { Logger } from "../utils/logger";
import { Platform } from "../utils/platform";

/**
 * ICMP echo through the system `ping` binary (iputils), which brings its own permission to send
 * ICMP: an unprivileged ICMP socket (`net.ipv4.ping_group_range`) or `CAP_NET_RAW`.
 */
export class Ping {
	/** Seconds `ping` waits for the reply. */
	static readonly REPLY_TIMEOUT_S = 1;
	/** Hard limit for the process, in case `ping` hangs (e.g. on a slow name lookup). */
	static readonly PROCESS_TIMEOUT_MS = 2500;

	/**
	 * The command line that sends one echo request to an IP address (IPv6 may carry a zone,
	 * `fe80::1%eth0`), or null if the address isn't an IP literal. `ping6` is used for IPv6 when
	 * it exists, because older iputils' `ping` doesn't know `-6`. Only options that both iputils
	 * and BusyBox know (BusyBox has no `-n`; with `-q` and an IP literal nothing is looked up).
	 */
	static command(address: string, options: { hasPing6: boolean }): string[] | null {
		const family = isIP(address.split("%")[0] ?? "");
		if (family === 0) return null;

		const args = ["-c", "1", "-W", String(Ping.REPLY_TIMEOUT_S), "-q", address];
		if (family === 4) return ["ping", ...args];
		return options.hasPing6 ? ["ping6", ...args] : ["ping", "-6", ...args];
	}

	/** Pings an address once; true if it answered. Only on Linux (other systems: always false). */
	static async probe(address: string): Promise<boolean> {
		if (!Platform.isLinux()) {
			Logger.debug("ICMP probes need Linux; treating as no answer");
			return false;
		}

		const command = Ping.command(address, { hasPing6: Bun.which("ping6") !== null });
		if (!command) return false;

		try {
			const child = Bun.spawn(command, {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
				timeout: Ping.PROCESS_TIMEOUT_MS,
			});
			const exitCode = await child.exited;
			if (child.signalCode) {
				Logger.debug(`ping ${address} was stopped after ${Ping.PROCESS_TIMEOUT_MS} ms`);
				return false;
			}
			// 0: a reply arrived; 1: no reply; anything else: ping couldn't run.
			if (exitCode !== 0 && exitCode !== 1) {
				const stderr = (await new Response(child.stderr).text()).trim();
				Logger.warn(`ping ${address} failed (exit ${exitCode})${stderr ? `: ${stderr}` : ""}`);
			}
			return exitCode === 0;
		} catch (error) {
			Logger.warn(`Couldn't run ping: ${error instanceof Error ? error.message : error}`);
			return false;
		}
	}
}
