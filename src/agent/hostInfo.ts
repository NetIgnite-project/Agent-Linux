import { readFile } from "node:fs/promises";
import { hostname, type NetworkInterfaceInfo, networkInterfaces, release, uptime } from "node:os";
import { AgentProtocol } from "../protocol/agentProtocol";
import { AppConstants } from "../utils/constants";

/** What the agent tells the server about the machine (HELLO `info`, HOST_STATUS). */
export class HostInfo {
	static readonly OS_RELEASE_FILES = ["/etc/os-release", "/usr/lib/os-release"];

	/** Parses os-release(5): `KEY=value` lines, values optionally quoted. */
	static parseOsRelease(text: string) {
		const values: Record<string, string> = {};

		for (const line of text.split("\n")) {
			const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
			if (!match?.[1]) continue;

			let value = match[2] ?? "";
			const quote = value[0];
			if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
				value = value.slice(1, -1);
				if (quote === '"') value = value.replace(/\\(["$`\\])/g, "$1");
			}
			values[match[1]] = value;
		}

		return values;
	}

	/** A readable OS name from os-release values (`PRETTY_NAME`, else `NAME VERSION`). */
	static osName(values: Record<string, string>) {
		if (values.PRETTY_NAME) return values.PRETTY_NAME;
		const name = [values.NAME, values.VERSION].filter(Boolean).join(" ");
		return name || null;
	}

	/** The machine's external IP addresses. */
	static addresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>) {
		const ipv4: string[] = [];
		const ipv6: string[] = [];

		for (const entries of Object.values(interfaces)) {
			for (const entry of entries ?? []) {
				if (entry.internal) continue;
				if (entry.family === "IPv4") ipv4.push(entry.address);
				else ipv6.push(entry.address);
			}
		}

		return { ipv4: [...new Set(ipv4)], ipv6: [...new Set(ipv6)] };
	}

	static async readOsName() {
		for (const path of HostInfo.OS_RELEASE_FILES) {
			try {
				return HostInfo.osName(HostInfo.parseOsRelease(await readFile(path, "utf8")));
			} catch {
				// Try the next file.
			}
		}
		return null;
	}

	/** The HELLO `info`: shown as key/value pairs in the dashboard. */
	static async collect(wolEnabled: boolean): Promise<Record<string, unknown>> {
		const { ipv4, ipv6 } = HostInfo.addresses(networkInterfaces());
		const os = await HostInfo.readOsName();

		return {
			hostname: hostname(),
			...(os ? { os } : {}),
			kernel: release(),
			arch: process.arch,
			uptime_s: Math.floor(uptime()),
			...(ipv4.length ? { ipv4: ipv4.join(", ") } : {}),
			...(ipv6.length ? { ipv6: ipv6.join(", ") } : {}),
			wake_on_lan: wolEnabled ? "on" : "off",
		};
	}

	static async hello(wolEnabled: boolean): Promise<AgentProtocol.Hello> {
		return {
			protocol: AgentProtocol.VERSION,
			kind: AppConstants.AGENT_KIND,
			version: AppConstants.version(),
			capabilities: AgentProtocol.capabilities(wolEnabled),
			info: await HostInfo.collect(wolEnabled),
		};
	}

	static status(): AgentProtocol.HostStatus {
		return { hostname: hostname(), uptime_s: Math.floor(uptime()) };
	}
}
