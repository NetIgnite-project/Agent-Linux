import { AppError } from "../utils/errors";

/**
 * A NetIgnite server address: `https://netignite.example.com`, `http://192.168.1.10:18232` or
 * a server below a sub-path such as `https://example.com/netignite`. A missing scheme means
 * `https://`. Credentials, query strings and fragments are rejected.
 */
export class ServerUrl {
	private constructor(
		readonly secure: boolean,
		/** Host name or IP address; IPv6 in brackets, as in a URL. */
		readonly host: string,
		readonly port: number,
		/** Path prefix without a trailing slash (`""` or e.g. `/netignite`). */
		readonly basePath: string,
	) {}

	static parse(text: string): ServerUrl {
		const value = text.trim();
		if (!value) throw new ServerUrl.ParseError("The server URL is empty");
		if (value.length > 512) throw new ServerUrl.ParseError("The server URL is too long");

		const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;

		let url: URL;
		try {
			url = new URL(withScheme);
		} catch {
			throw new ServerUrl.ParseError(`"${value}" is not a valid URL`);
		}

		if (url.protocol !== "https:" && url.protocol !== "http:") {
			throw new ServerUrl.ParseError(
				`Unsupported scheme "${url.protocol.slice(0, -1)}" (use http:// or https://)`,
			);
		}
		if (url.username || url.password) {
			throw new ServerUrl.ParseError("The server URL must not contain a user name or password");
		}
		if (url.search || url.hash || value.includes("?") || value.includes("#")) {
			throw new ServerUrl.ParseError("The server URL must not contain a query (?) or fragment (#)");
		}
		if (!url.hostname) {
			throw new ServerUrl.ParseError("The server URL has no host");
		}

		const secure = url.protocol === "https:";
		const port = url.port ? Number(url.port) : secure ? 443 : 80;
		const basePath = url.pathname.replace(/\/+$/, "");

		return new ServerUrl(secure, url.hostname, port, basePath);
	}

	/** `https://host[:port]`, the port only if it isn't the scheme's default. */
	get origin() {
		const defaultPort = this.secure ? 443 : 80;
		const port = this.port === defaultPort ? "" : `:${this.port}`;
		return `${this.secure ? "https" : "http"}://${this.host}${port}`;
	}

	/** The normalized URL as stored in the config: origin plus base path. */
	toString() {
		return `${this.origin}${this.basePath}`;
	}

	/** An HTTP(S) URL below the server, e.g. `httpUrl("/api/v1/agents/enroll")`. */
	httpUrl(path: string) {
		return `${this.origin}${this.basePath}${path}`;
	}

	/** The WebSocket URL of a path: `wss://` for HTTPS servers, `ws://` for HTTP. */
	wsUrl(path: string) {
		return this.httpUrl(path).replace(/^http/, "ws");
	}
}

export namespace ServerUrl {
	export class ParseError extends AppError {}
}
