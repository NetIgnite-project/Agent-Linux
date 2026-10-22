import { createHash } from "node:crypto";
import { utils } from "ssh2";

/**
 * SSH host key fingerprints, and the agent's own key pairs: one Ed25519 key for shutdown and one
 * for reboot. The private keys stay in the agent's config; the server and the devices only ever
 * see the public keys.
 */
export class SshKeys {
	/**
	 * OpenSSH's fingerprint format (`ssh-keygen -lf`): `SHA256:` + the unpadded base64 of the
	 * SHA-256 of the raw public key blob. 32 bytes are 43 base64 characters without the `=`.
	 */
	static readonly FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;

	/** OpenSSH-format Ed25519 private keys are about 400 bytes. */
	static readonly MAX_PRIVATE_KEY_LENGTH = 4 * 1024;

	static readonly ACTIONS = ["shutdown", "reboot"] as const;

	/** The fingerprint of a raw public key blob (what ssh2's `hostVerifier` gets). */
	static fingerprint(blob: Uint8Array) {
		const hash = createHash("sha256").update(blob).digest("base64");
		return `SHA256:${hash.replace(/=+$/, "")}`;
	}

	/**
	 * Two new key pairs, as unencrypted OpenSSH private keys (what `ssh-keygen -N ""` writes).
	 * ssh2 (1.17) drops the leading byte of a public key that starts with 0x00, about 1 key in
	 * 256: such a key doesn't parse, so it is made again.
	 */
	static generate(agentID: number): SshKeys.PrivateKeys {
		const key = (action: SshKeys.Action) => {
			for (let attempt = 0; attempt < 20; attempt++) {
				const generated = utils.generateKeyPairSync("ed25519", {
					comment: `netignite-agent-${agentID}-${action}`,
				}).private;
				if (SshKeys.isUsablePrivateKey(generated)) return generated;
			}
			throw new Error("Couldn't generate an SSH key");
		};
		return { shutdown: key("shutdown"), reboot: key("reboot") };
	}

	/**
	 * Whether this is an unencrypted Ed25519 private key ssh2 can log in with. Never says why not,
	 * so no part of the key ends up in an error message.
	 */
	static isUsablePrivateKey(text: string) {
		if (text.length === 0 || text.length > SshKeys.MAX_PRIVATE_KEY_LENGTH) return false;
		try {
			const parsed = utils.parseKey(text);
			if (parsed instanceof Error) return false;
			const key = Array.isArray(parsed) ? parsed[0] : parsed;
			return key?.isPrivateKey() === true && key.type === "ssh-ed25519";
		} catch {
			return false;
		}
	}

	/** `ssh-ed25519 <base64>` of a private key, as HELLO reports it (no comment). */
	static publicKey(privateKey: string) {
		const parsed = utils.parseKey(privateKey);
		const key = Array.isArray(parsed) ? parsed[0] : parsed;
		if (!key || key instanceof Error) throw new Error("Invalid SSH private key");
		return `${key.type} ${key.getPublicSSH().toString("base64")}`;
	}

	static publicKeys(keys: SshKeys.PrivateKeys): SshKeys.PublicKeys {
		return { shutdown: SshKeys.publicKey(keys.shutdown), reboot: SshKeys.publicKey(keys.reboot) };
	}
}

export namespace SshKeys {
	export type Action = (typeof SshKeys.ACTIONS)[number];
	export type PrivateKeys = Record<Action, string>;
	export type PublicKeys = Record<Action, string>;
}
