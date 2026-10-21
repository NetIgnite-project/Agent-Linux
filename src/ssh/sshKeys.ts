import { createHash } from "node:crypto";
import { utils } from "ssh2";

/** SSH host key fingerprints and private key checks. */
export class SshKeys {
	/**
	 * OpenSSH's fingerprint format (`ssh-keygen -lf`): `SHA256:` + the unpadded base64 of the
	 * SHA-256 of the raw public key blob. 32 bytes are 43 base64 characters without the `=`.
	 */
	static readonly FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;

	/** Larger than any RSA-16384 key in OpenSSH format; Ed25519 keys are about 400 bytes. */
	static readonly MAX_PRIVATE_KEY_LENGTH = 16 * 1024;

	/** The fingerprint of a raw public key blob (what ssh2's `hostVerifier` gets). */
	static fingerprint(blob: Uint8Array) {
		const hash = createHash("sha256").update(blob).digest("base64");
		return `SHA256:${hash.replace(/=+$/, "")}`;
	}

	/**
	 * Whether ssh2 can log in with this key: an unencrypted private key it can parse (OpenSSH
	 * format Ed25519, ECDSA or RSA, or the older PEM formats). Never says why it can't, so no part
	 * of the key ends up in an error message.
	 */
	static isUsablePrivateKey(text: string) {
		if (text.length === 0 || text.length > SshKeys.MAX_PRIVATE_KEY_LENGTH) return false;
		try {
			const parsed = utils.parseKey(text);
			if (parsed instanceof Error) return false;
			const key = Array.isArray(parsed) ? parsed[0] : parsed;
			return key?.isPrivateKey() === true;
		} catch {
			return false;
		}
	}
}
