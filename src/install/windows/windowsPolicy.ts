/**
 * Windows: `LOCAL SERVICE` can't shut the machine down by default — the "Shut down the system"
 * user right isn't granted to that account (on servers not even ordinary users have it). The
 * agent's only way to shut down is `shutdown.exe`, which needs that right, so `install` grants it
 * to the account's SID in the local security policy and `uninstall` takes it back — the Windows
 * answer to what the root units do on Linux.
 *
 * This goes through `secedit`: it exports the whole local policy as an INF, the agent adds its SID
 * to the `SeShutdownPrivilege` line, and `secedit /configure` applies the file again. Only that
 * one line changes; everything else in the file is written back as it was.
 */
export class WindowsPolicy {
	static readonly RIGHT = "SeShutdownPrivilege";
	static readonly SID = "*S-1-5-19";

	/**
	 * The exported policy's text (secedit writes it as UTF-16 with BOM or as ASCII/UTF-8), and
	 * which encoding to write it back in.
	 */
	static decode(buffer: Buffer): { text: string; encoding?: "utf16le-bom" } {
		if (buffer[0] === 0xff && buffer[1] === 0xfe) {
			return { text: buffer.subarray(2).toString("utf16le"), encoding: "utf16le-bom" };
		}
		return { text: buffer.toString("utf8"), encoding: undefined };
	}

	/** The INF with the agent's SID in SeShutdownPrivilege, or null if it is already there. */
	static merge(inf: string): string | null {
		return WindowsPolicy.edit(inf, "add");
	}

	/** The INF with the agent's SID removed from SeShutdownPrivilege, or null if it wasn't there. */
	static split(inf: string): string | null {
		return WindowsPolicy.edit(inf, "remove");
	}

	private static edit(inf: string, mode: "add" | "remove"): string | null {
		const lines = inf.split(/\r?\n/);
		const section = /^\s*\[Privilege Rights\]\s*$/i;
		const right = /^\s*SeShutdownPrivilege\s*=/i;
		const isOurs = (entry: string) => entry.trim().toLowerCase() === WindowsPolicy.SID.toLowerCase();
		const header = lines.findIndex((line) => section.test(line));
		const at = header === -1 ? -1 : lines.findIndex((line, i) => i > header && right.test(line));

		if (mode === "add") {
			if (at !== -1) {
				const existing = lines[at] ?? "";
				const value = WindowsPolicy.value(existing);
				if (value.some(isOurs)) return null;
				lines[at] = `${existing},${WindowsPolicy.SID}`;
				return lines.join("\r\n");
			}
			const line = `${WindowsPolicy.RIGHT} = ${WindowsPolicy.SID}`;
			if (header === -1) return [...lines, "", "[Privilege Rights]", line].join("\r\n");
			lines.splice(header + 1, 0, line);
			return lines.join("\r\n");
		}

		if (at === -1) return null;
		const line = lines[at] ?? "";
		const value = WindowsPolicy.value(line);
		const kept = value.filter((entry) => !isOurs(entry));
		if (kept.length === value.length) return null;
		if (kept.length === 0) {
			lines.splice(at, 1);
		} else {
			// The right's name, "= " and the entries that stay.
			lines[at] = `${line.slice(0, line.indexOf("=") + 1).trimEnd()} ${kept.join(",")}`;
		}
		return lines.join("\r\n");
	}

	/** A right line's value, as trimmed entries: `*S-1-5-19` of `SeShutdownPrivilege = *S-1-5-19`. */
	private static value(line: string) {
		return line
			.slice(line.indexOf("=") + 1)
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
	}
}
