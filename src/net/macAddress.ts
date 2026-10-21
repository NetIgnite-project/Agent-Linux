/** A 48-bit MAC address, e.g. the target of a Wake-on-LAN packet. */
export class MacAddress {
	private constructor(readonly bytes: Uint8Array) {}

	/**
	 * Parses `AA:BB:CC:DD:EE:FF`, `aa-bb-cc-dd-ee-ff` (one separator throughout) or 12 hex digits.
	 * Returns null for anything else.
	 */
	static parse(text: string): MacAddress | null {
		const value = text.trim();

		let hex: string;
		if (/^[0-9a-fA-F]{12}$/.test(value)) {
			hex = value;
		} else if (/^[0-9a-fA-F]{2}([:-])(?:[0-9a-fA-F]{2}\1){4}[0-9a-fA-F]{2}$/.test(value)) {
			hex = value.replace(/[:-]/g, "");
		} else {
			return null;
		}

		const bytes = new Uint8Array(6);
		for (let i = 0; i < 6; i++) {
			bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
		}
		return new MacAddress(bytes);
	}

	/** `AA:BB:CC:DD:EE:FF` */
	toString() {
		return [...this.bytes].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":");
	}

	equals(other: MacAddress) {
		return this.bytes.every((byte, i) => byte === other.bytes[i]);
	}

	/**
	 * The IPv6 link-local address a host derives from this MAC with modified EUI-64 (RFC 4291):
	 * flip the universal/local bit and insert `ff:fe` in the middle, e.g.
	 * `52:54:00:12:34:56` → `fe80::5054:ff:fe12:3456`. Hosts that use privacy or stable-privacy
	 * addresses (RFC 7217) don't answer on it.
	 */
	linkLocalIPv6() {
		const b = this.bytes;
		const address = new Uint8Array(16);
		address.set([0xfe, 0x80]);
		address.set(
			[(b[0] ?? 0) ^ 0x02, b[1] ?? 0, b[2] ?? 0, 0xff, 0xfe, b[3] ?? 0, b[4] ?? 0, b[5] ?? 0],
			8,
		);
		return MacAddress.formatIPv6(address);
	}

	/** Formats 16 bytes as an IPv6 address, with the longest run of zero groups as `::` (RFC 5952). */
	static formatIPv6(address: Uint8Array) {
		const groups: number[] = [];
		for (let i = 0; i < 8; i++) {
			groups.push(((address[i * 2] ?? 0) << 8) | (address[i * 2 + 1] ?? 0));
		}

		let bestStart = -1;
		let bestLength = 0;
		for (let i = 0; i < 8; ) {
			if (groups[i] !== 0) {
				i++;
				continue;
			}
			let j = i;
			while (j < 8 && groups[j] === 0) j++;
			if (j - i > bestLength && j - i >= 2) {
				bestStart = i;
				bestLength = j - i;
			}
			i = j;
		}

		const hex = groups.map((group) => group.toString(16));
		if (bestStart < 0) return hex.join(":");
		return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
	}
}
