import { Socket } from "node:net";

/** Checks whether a host answers on a TCP port. */
export class TcpProbe {
	static readonly TIMEOUT_MS = 1500;

	/**
	 * True if the connection is accepted **or refused**: a refusal (RST) also proves the host is
	 * up. Timeouts and unreachable networks/hosts mean no answer.
	 */
	static probe(address: string, port: number, timeoutMs = TcpProbe.TIMEOUT_MS): Promise<boolean> {
		return new Promise((resolve) => {
			const socket = new Socket();
			let settled = false;

			const finish = (online: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				resolve(online);
			};

			const timer = setTimeout(() => finish(false), timeoutMs);

			socket.once("connect", () => finish(true));
			socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED"));

			try {
				socket.connect({ host: address, port });
			} catch {
				finish(false);
			}
		});
	}
}
