import { MacAddress } from "../net/macAddress";
import type { StatusProbe } from "../net/statusProbe";
import { AgentProtocol } from "../protocol/agentProtocol";
import type { SshRemote } from "../ssh/sshRemote";
import { AppConstants } from "../utils/constants";
import { Logger } from "../utils/logger";
import { HostControl } from "./hostControl";

/** Turns server requests into answers. Requests are independent and may run concurrently. */
export class RequestHandler {
	private hostControlPending = false;

	constructor(private readonly options: RequestHandler.Options) {}

	async handle(cmd: string, payload: Record<string, unknown>): Promise<RequestHandler.Outcome> {
		switch (cmd) {
			case "PING":
				return { ok: true, p: {} };
			case "WAKE":
				return await this.wake(payload);
			case "STATUS":
				return await this.status(payload);
			case "HOST_CONTROL":
				return await this.hostControl(payload);
			case "SSH_CHECK":
				return await this.sshCheck(payload);
			case "SSH_POWER":
				return await this.sshPower(payload);
			default:
				return { ok: false, err: `Unknown command ${cmd}` };
		}
	}

	private wolDisabled(): RequestHandler.Outcome {
		return {
			ok: false,
			err: `Wake-on-LAN mode is off on this agent (enable it with: sudo ${AppConstants.BINARY_NAME} wol-mode on)`,
		};
	}

	private async wake(payload: Record<string, unknown>): Promise<RequestHandler.Outcome> {
		if (!this.options.wolEnabled) return this.wolDisabled();

		const request = AgentProtocol.parseRequest(AgentProtocol.WakeRequest, payload);
		if (!request.ok) return { ok: false, err: request.error };

		const mac = MacAddress.parse(request.data.mac);
		if (!mac) return { ok: false, err: "Invalid MAC address" };

		try {
			await this.options.wake(mac, request.data.port);
			return { ok: true, p: {} };
		} catch (error) {
			return { ok: false, err: error instanceof Error ? error.message : String(error) };
		}
	}

	private async status(payload: Record<string, unknown>): Promise<RequestHandler.Outcome> {
		if (!this.options.wolEnabled) return this.wolDisabled();

		const request = AgentProtocol.parseRequest(AgentProtocol.StatusRequest, payload);
		if (!request.ok) return { ok: false, err: request.error };

		const online = await this.options.statusProbe.check(request.data);
		return { ok: true, p: { online } };
	}

	/** The SSH client, or why this agent doesn't log in over SSH. */
	private sshClient(): RequestHandler.SshClient | RequestHandler.Outcome {
		if (!this.options.wolEnabled) return this.wolDisabled();
		if (!this.options.ssh) {
			return { ok: false, err: this.options.sshUnavailable ?? "SSH isn't available on this agent" };
		}
		return this.options.ssh;
	}

	private async sshCheck(payload: Record<string, unknown>): Promise<RequestHandler.Outcome> {
		const ssh = this.sshClient();
		if ("ok" in ssh) return ssh;

		const request = AgentProtocol.parseRequest(AgentProtocol.SshCheckRequest, payload);
		if (!request.ok) return { ok: false, err: request.error };

		const outcome = await ssh.check(request.data);
		return outcome.ok ? { ok: true, p: outcome.result } : { ok: false, err: outcome.error };
	}

	private async sshPower(payload: Record<string, unknown>): Promise<RequestHandler.Outcome> {
		const ssh = this.sshClient();
		if ("ok" in ssh) return ssh;

		const request = AgentProtocol.parseRequest(AgentProtocol.SshPowerRequest, payload);
		if (!request.ok) return { ok: false, err: request.error };

		const result = await ssh.power(request.data);
		return result.ok ? { ok: true, p: {} } : { ok: false, err: result.error };
	}

	private async hostControl(payload: Record<string, unknown>): Promise<RequestHandler.Outcome> {
		const request = AgentProtocol.parseRequest(AgentProtocol.HostControlRequest, payload);
		if (!request.ok) return { ok: false, err: request.error };

		const executor = this.options.hostControl;
		if (!executor) {
			return { ok: false, err: `Host control isn't supported on ${process.platform}` };
		}
		if (this.hostControlPending) {
			return { ok: false, err: "A shutdown or reboot is already in progress" };
		}

		const { action } = request.data;

		// The command runs after the answer, so check now whether it would be allowed.
		const refused = (await this.options.hostControlCheck?.(action)) ?? null;
		if (refused) return { ok: false, err: refused };

		// Answer first, act afterwards: once the machine goes down the answer couldn't be sent.
		// If the answer can't be sent, nothing happens.
		return {
			ok: true,
			p: {},
			afterSend: () => {
				this.hostControlPending = true;
				setTimeout(() => {
					executor(action)
						.catch((error) => {
							Logger.error(`Host control (${action}) failed:`, error);
						})
						.finally(() => {
							this.hostControlPending = false;
						});
				}, this.options.hostControlDelayMs ?? HostControl.DELAY_MS);
			},
		};
	}
}

export namespace RequestHandler {
	export type Options = {
		/** WAKE, STATUS, SSH_CHECK and SSH_POWER are only answered in Wake-on-LAN mode. */
		wolEnabled: boolean;
		statusProbe: Pick<StatusProbe, "check">;
		wake: (mac: MacAddress, port: number) => Promise<void>;
		/** Null without SSH keys or without TLS to the server; `sshUnavailable` says which. */
		ssh: SshClient | null;
		sshUnavailable?: string;
		/** Null where host control isn't possible (not Linux). */
		hostControl: HostControl.Perform | null;
		/** Asks whether host control is allowed right now (logind); null/undefined: don't ask. */
		hostControlCheck?: HostControl.Check | null;
		hostControlDelayMs?: number;
	};

	export type SshClient = Pick<SshRemote, "check" | "power">;

	export type Outcome =
		| {
				ok: true;
				p: Record<string, unknown>;
				/** Called once the answer was sent. */
				afterSend?: () => void;
		  }
		| { ok: false; err: string };
}
