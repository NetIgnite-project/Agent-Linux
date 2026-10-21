# NetIgnite Agent for Linux

`netignite-agent` connects a Linux machine to a [NetIgnite](https://github.com/NetIgnite-project)
server, so the dashboard can:

- **Host mode** (always on): show whether this machine is online, and **shut it down or reboot
  it**.
- **Wake-on-LAN mode** (optional): also **wake other devices** on this machine's network and
  **check whether they are up** (ICMP ping, TCP port, IPv6 link-local via MAC). This is what a
  NetIgnite ESP32 agent does, on a machine you already have running (a Raspberry Pi, a NAS, a
  home server).

It is a single binary that runs as a systemd service under its own unprivileged user. It talks to
the server over one outgoing WebSocket (protocol v2). Nothing listens on this machine.

## Requirements

- Linux with systemd (`install` sets up a systemd service).
- polkit for shutdown and reboot (`apt install polkitd`, `dnf install polkit`). Without it the
  agent still runs, but shutdown/reboot from the dashboard fail.
- Wake-on-LAN mode: `ping` (iputils or BusyBox) and `ip` (iproute2) for status checks.

| Binary | For |
| --- | --- |
| `netignite-agent-linux-x64` | x86-64 CPUs from about 2013 on (AVX2) |
| `netignite-agent-linux-x64-baseline` | any x86-64 CPU; use it if the other one crashes with "Illegal instruction" |
| `netignite-agent-linux-arm64` | 64-bit ARM, e.g. Raspberry Pi 3/4/5 with a 64-bit OS |

## Install

1. In the dashboard, create an agent of type **Linux**. Its page shows a pair command with a
   single-use enrollment token (valid 15 minutes).
2. Download the binary and check it:

   ```bash
   arch=x64   # or x64-baseline, arm64
   base=https://github.com/NetIgnite-project/Agent-Linux/releases/latest/download
   curl -fsSLO "$base/netignite-agent-linux-$arch"
   curl -fsSLO "$base/SHA256SUMS"
   sha256sum --check --ignore-missing SHA256SUMS
   chmod +x "netignite-agent-linux-$arch"
   ```

3. Pair and install. `install` copies the binary to `/usr/local/bin/netignite-agent`:

   ```bash
   sudo ./netignite-agent-linux-$arch pair https://netignite.example.com netignite_enroll_…
   sudo ./netignite-agent-linux-$arch install
   ```

The agent shows up as online in the dashboard. Assign it to the device as its host agent to get
Shutdown and Reboot.

`install` does the following. `sudo netignite-agent install --dry-run` prints every step, and the
files' contents, without changing anything:

- creates the system user `netignite` (no home, no login shell)
- copies the binary to `/usr/local/bin/netignite-agent`
- makes the config readable for the service: `/etc/netignite` `root:netignite 0750`, the config
  `netignite:netignite 0600`
- writes `/etc/systemd/system/netignite-agent.service`
- writes the polkit rule `/etc/polkit-1/rules.d/50-netignite-agent.rules` (plus a `.pkla` file on
  polkit < 0.106, e.g. Debian 11)
- runs `systemctl daemon-reload`, `enable` and `restart`

Check on it with `sudo netignite-agent status` and `journalctl -u netignite-agent -f`.

## Pair

```bash
sudo netignite-agent pair <server-url> <enrollment-token> [--wol] [--config <path>]
```

- The agent generates its own secret (32 random bytes), sends it with the token to
  `POST <server>/api/v1/agents/enroll`, and stores the result in `/etc/netignite/agent.json`.
  Neither the secret nor the token is printed.
- `<server-url>` is the dashboard's address, including a sub-path if the server runs below one
  (`https://example.com/netignite`). A missing scheme means `https://`. User names, passwords,
  queries and fragments are refused.
- Pairing again (new token from the dashboard) replaces the credential. The server disconnects the
  old one, and an installed service is restarted with the new one.
- An ESP32 agent's token is refused: create a Linux agent for this machine instead. The server
  has already replaced that ESP32's credential by then, so set the ESP32 up again.

## Wake-on-LAN mode

```bash
sudo netignite-agent wol-mode on     # or: pair --wol, or: run --wol
sudo netignite-agent wol-mode off
```

In this mode the agent also advertises `wake`, `status.ip`, `status.host`, `status.tcp` and
`status.link_local`. The server can then send it:

- **WAKE**: a magic packet (6 × `FF` + 16 × the MAC) over UDP broadcast to `255.255.255.255`
  and each interface's broadcast address, 3 rounds.
- **STATUS**: online if the device answers a ping (`ping -c 1 -W 1`), a TCP connect on the
  requested port (a refused connection counts too), or, for link-local checks, shows up in the
  neighbor table (`ip neigh`) or answers on its EUI-64 IPv6 address. The answer always comes
  within 4.5 s.

`wol-mode` updates an installed service and restarts it. In Wake-on-LAN mode the unit grants
`CAP_NET_RAW`, which `ping` needs.

To test from the command line: `netignite-agent wol AA:BB:CC:DD:EE:FF [--port 9]`.

## Uninstall

```bash
sudo netignite-agent uninstall           # keeps /etc/netignite/agent.json (root-only again)
sudo netignite-agent uninstall --purge   # also deletes the config with the credential
```

This stops and disables the service and removes the unit, the polkit rule, the user `netignite`
and `/usr/local/bin/netignite-agent`. `--dry-run` shows the steps. Delete the agent in the
dashboard too.

## Commands

| Command | |
| --- | --- |
| `pair <server-url> <token>` | Enroll and write the config (`--wol`, `--config`). |
| `install` | Set up and start the systemd service (`--config`, `--dry-run`). |
| `uninstall` | Remove the service (`--purge`, `--config`, `--dry-run`). |
| `run` | The daemon, in the foreground (`--wol`, `--config`). |
| `status` | Config, server, agent id, service state, server and credential check. Never shows the secret. |
| `wol-mode on\|off` | Switch Wake-on-LAN mode. |
| `wol <mac>` | Send a magic packet from here (`--port`, default 9). |
| `version` | Print the version. |

Global flags go before the command: `netignite-agent --log-level debug run`. The default config
path is `/etc/netignite/agent.json`.

Exit codes: `0` success, `1` error, `78` the server rejected the credential. The service does
not restart after 78; pair again.

## Connection

The agent keeps one WebSocket to `<server>/ws/agent` (`wss://` for https servers) with
`Authorization: Bearer netignite_agent_<token_id>:<secret>`. It sends `HELLO` first (protocol 2,
kind `linux`, version, capabilities, and hostname, OS, kernel, architecture, uptime and IP
addresses for the dashboard), then answers the server's requests.

- It reconnects with backoff from 5 s up to 60 s. If the server sends nothing for 100 s (it pings
  every 30 s), the agent drops the connection and reconnects.
- It gives up for good, and exits with 78, when the server answers the upgrade with HTTP 401 or
  closes with 4003 (credential revoked, for example after pairing again) or 4004 (agent deleted).
- On 4000 (another connection with the same credential took over) it waits 60 s before
  reconnecting, so two copies of the agent don't keep kicking each other out.

## Security model

- **Fixed actions only.** The server can ask for exactly these: `PING`; `HOST_CONTROL` with
  `shutdown` or `reboot`, which runs `systemctl --no-ask-password poweroff|reboot`, about 1 s
  after the answer was sent; and in Wake-on-LAN mode `WAKE` and `STATUS`. Every parameter is
  validated: MAC addresses, ports, IP literals, host names. Commands run without a shell, and
  only IP literals reach `ping`. Anything else is answered with an error. No remote shell, no
  file access, no configuration changes from the server.
- **The secret** is generated on this machine and never leaves it except in the `Authorization`
  header. The server stores only a hash. It lives in `/etc/netignite/agent.json`, mode `0600`,
  owned by root until `install`, then by `netignite`. It is never printed, not even by `status`.
  Use an `https://` server URL for anything outside your LAN, or the header crosses the network
  in clear text.
- **The service** runs as the system user `netignite` with no capabilities in host mode (only
  `CAP_NET_RAW` in Wake-on-LAN mode, for `ping`). Its hardening: `NoNewPrivileges`,
  `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `ReadOnlyPaths` of the
  config directory, `ProtectKernel*`, `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`,
  `RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality`,
  `SystemCallArchitectures=native` and `RestrictAddressFamilies` (Unix, IPv4, IPv6, netlink).
- **polkit** lets the user `netignite` (and nobody else) use exactly
  `org.freedesktop.login1.power-off`, `power-off-multiple-sessions`, `reboot` and
  `reboot-multiple-sessions`. The `*-multiple-sessions` actions apply when other users are
  logged in, e.g. over SSH. The `*-ignore-inhibit` actions are not granted, so a block inhibitor
  (a running package upgrade, for example) still stops a remote shutdown.
- **`NoNewPrivileges` and polkit work together.** `systemctl poweroff` as `netignite` asks logind
  over D-Bus, and logind asks polkit. No setuid helper (`sudo`, `pkexec`) is involved, which is
  what `NoNewPrivileges` would block. The unit's seccomp-based options imply `NoNewPrivileges`
  for a service with `User=` anyway.
- The compiled binary does not load `.env` or `bunfig.toml` from the working directory, so a
  stray file there can't change how a root-run `pair` or `install` behaves.

## Development

```bash
bun install
bun run dev version               # bun run --watch src/index.ts version
bun test                          # unit + integration tests (fake server in tests/helpers)
bun run typecheck
bun run check                     # Biome
bun run compile all --no-version-tag   # build/bin/netignite-agent-linux-{x64,x64-baseline,arm64}
```

The protocol's source of truth is the server: `server/lib/agents/protocol.ts`, `gateway.ts`,
`registry.ts` and `connection.ts`, and the enroll route in
`server/lib/api/versions/v1/routes/agents/`. `tests/helpers/server-protocol.ts` copies its schemas,
so the tests check what the agent sends against the server's rules.

Releases: bump `version` in `package.json`, then push the tag `v<version>`. The release workflow
attaches `netignite-agent-linux-x64`, `netignite-agent-linux-x64-baseline`,
`netignite-agent-linux-arm64` and `SHA256SUMS`. Versions with a suffix (`1.0.0-beta.1`) become
pre-releases, which `releases/latest` skips.

## License

AGPL-3.0
