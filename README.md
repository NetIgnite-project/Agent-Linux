# NetIgnite Agent

`netignite-agent` connects a Linux, macOS or Windows machine to a
[NetIgnite](https://github.com/NetIgnite-project) server, so the dashboard can:

- **Host mode** (always on, every platform): show whether this machine is online, and **shut it
  down or reboot it**.
- **Wake-on-LAN mode** (optional, Linux only): also **wake other devices** on this machine's
  network, **check whether they are up** (ICMP ping, TCP port, IPv6 link-local via MAC), and
  **log in to them over [SSH](#ssh)** to shut them down or reboot them. This is what a NetIgnite
  ESP32 agent does, on a machine you already have running (a Raspberry Pi, a NAS, a home server).

It is a single binary that runs as a service under an account without rights to the machine:
systemd on Linux, launchd on macOS ([macOS](#macos)), a scheduled task on Windows
([Windows](#windows)). It talks to the server over one outgoing WebSocket (protocol v2). Nothing
listens on this machine. This repository is still called Agent-Linux; the binaries for every
platform are in its releases.

## Requirements

- Linux with systemd (`install` sets up a systemd service). Nothing else is needed for shutdown
  and reboot: no polkit, no sudo.
- Wake-on-LAN mode: `ping` (iputils or BusyBox) and `ip` (iproute2) for status checks.
- macOS 13 or newer, Windows 10 or 11 (64-bit x86).

| Binary | For |
| --- | --- |
| `netignite-agent-linux-x64` | x86-64 CPUs from about 2013 on (AVX2) |
| `netignite-agent-linux-x64-baseline` | any x86-64 CPU; use it if the other one crashes with "Illegal instruction" |
| `netignite-agent-linux-arm64` | 64-bit ARM, e.g. Raspberry Pi 3/4/5 with a 64-bit OS |
| `netignite-agent-macos-arm64` | Macs with Apple silicon |
| `netignite-agent-macos-x64` | Intel Macs |
| `netignite-agent-windows-x64.exe` | Windows 10/11 on 64-bit x86 |

## Install

1. In the dashboard, create an agent of the kind **Linux agent**. Its page shows a pair command
   with a single-use enrollment token (valid 15 minutes).
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
- writes the shutdown and reboot units `netignite-agent-shutdown.path`/`.service` and
  `netignite-agent-reboot.path`/`.service` (see [Shutdown and reboot](#shutdown-and-reboot))
- removes the polkit rule of versions before 1.0.0, if there is one
- runs `systemctl daemon-reload`, enables and starts the two `.path` units, then enables and
  (re)starts the service

Check on it with `sudo netignite-agent status` and `journalctl -u netignite-agent -f`.

## Windows

In the dashboard, create an agent of the kind **Windows agent**; its page shows a PowerShell
one-liner. Or by hand, in PowerShell opened with **Run as administrator**:

```powershell
.\netignite-agent-windows-x64.exe pair https://netignite.example.com netignite_enroll_…
.\netignite-agent-windows-x64.exe install
```

`pair` writes `C:\ProgramData\NetIgnite\agent.json` and first restricts that folder to SYSTEM
and Administrators (below ProgramData every user may read otherwise). `install`:

- copies the binary to `C:\Program Files\NetIgnite\netignite-agent.exe`,
- gives the account `LOCAL SERVICE` read access to the config folder and write access to its
  `logs` folder (by SID, so translated account names don't matter),
- registers the scheduled task **NetIgnite Agent**: started at boot as `LOCAL SERVICE`, restarted
  once a minute if it stops, no time limit, also on battery,
- starts it.

`LOCAL SERVICE` has no rights to your files or the system, but it may shut the PC down, so the
agent runs `shutdown.exe /s|/r /t 0 /d p:0:0` itself; there is nothing else it can run. It logs to
`C:\ProgramData\NetIgnite\logs\agent.log` (1 MB, then `agent.log.1`). `netignite-agent status`
shows the task's state, `uninstall [--purge]` removes it again. Wake-on-LAN mode isn't available
on Windows.

## macOS

In the dashboard, create an agent of the kind **macOS agent**; its page shows a one-liner. Or by
hand:

```bash
sudo ./netignite-agent-macos-arm64 pair https://netignite.example.com netignite_enroll_…
sudo ./netignite-agent-macos-arm64 install
```

The config is `/usr/local/etc/netignite/agent.json`. `install`:

- creates the hidden system user and group `_netignite` (id 400–499, no shell, no home),
- copies the binary to `/usr/local/bin/netignite-agent`,
- makes the config readable for `_netignite` only,
- creates the request folders `/usr/local/var/netignite-agent/shutdown` and `…/reboot` (owned by
  `_netignite`, mode 0700) and the log folder `/usr/local/var/log/netignite-agent`,
- writes three launchd daemons to `/Library/LaunchDaemons`: `dev.netignite.agent` (the agent, as
  `_netignite`, restarted by launchd), and `dev.netignite.agent.shutdown` /
  `dev.netignite.agent.reboot` (root),
- loads them with `launchctl bootstrap`.

Shutdown and reboot work like on Linux: the agent has no right to either. It creates a file in its
request folder; the root daemon for that action (launchd `QueueDirectories`) empties the folder
and runs `/sbin/shutdown -h now` (or `-r now`) if the request is less than a minute old. Older
requests (a power cut right after one, say) are only removed. The agent logs to
`/usr/local/var/log/netignite-agent/agent.log`. Wake-on-LAN mode isn't available on macOS.

The binaries aren't signed by Apple. macOS only runs Apple silicon binaries with a signature, so
the install script signs the downloaded file ad hoc (`codesign --force --sign -`) after checking it
against `SHA256SUMS`; do the same when you download one by hand.

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
- An ESP32 agent's token is refused, and stays valid for that ESP32: create a Linux agent for this
  machine instead.

## Wake-on-LAN mode

```bash
sudo netignite-agent wol-mode on     # or: pair --wol, or: run --wol
sudo netignite-agent wol-mode off
```

In this mode the agent also advertises `wake`, `status.ip`, `status.host`, `status.tcp` and
`status.link_local` (and `ssh.power`, see [SSH](#ssh)). The server can then send it:

- **WAKE**: a magic packet (6 × `FF` + 16 × the MAC) over UDP broadcast to `255.255.255.255`
  and each interface's broadcast address, 3 rounds.
- **STATUS**: online if the device answers a ping (`ping -c 1 -W 1`), a TCP connect on the
  requested port (a refused connection counts too), or, for link-local checks, shows up in the
  neighbor table (`ip neigh`) or answers on its EUI-64 IPv6 address. The answer always comes
  within 4.5 s.

`wol-mode` updates an installed service and restarts it. In Wake-on-LAN mode the unit grants
`CAP_NET_RAW`, which `ping` needs.

To test from the command line: `netignite-agent wol AA:BB:CC:DD:EE:FF [--port 9]`.

## SSH

In Wake-on-LAN mode the agent can also log in to devices on its network over SSH, to shut down or
reboot devices that can't run an agent themselves (a NAS, a BSD box, a Windows PC with OpenSSH
Server). The server's admin has to turn SSH on (Server Settings), and the agent only offers it
(capability `ssh.power`) over an `https://` server address. Host mode never does SSH: it only
controls its own machine.

**The agent's own keys.** `pair` (and `install` or `wol-mode on` for older configs) creates two
Ed25519 key pairs, one for shutdown and one for reboot, in `/etc/netignite/agent.json`. The
private keys never leave the machine; HELLO reports the public keys (`ssh_keys`), and the
dashboard turns them into two `authorized_keys` lines for the device, each with its forced
command. There are no passwords and no credentials from the server: requests only say where to
log in.

- **SSH_CHECK** (Test login in the dashboard): for each key, connect, check the host key,
  authenticate, disconnect. It **never opens a session or channel**, so the forced commands
  don't run. Answers:
  - `{"online": false}`: no TCP connection (refused, unreachable, or no answer within 3 s). With
    an `error` only when the host name doesn't resolve.
  - `{"online": true, "host_key": "SHA256:…", "shutdown": true, "reboot": true}`: which keys
    the device accepted.
  - `{"online": true, "host_key": "SHA256:…", "shutdown": false, "reboot": false, "error": "host_key_mismatch"}`:
    the device presented a different key. The agent stopped before offering a key.
  - `{"online": true, "shutdown": false, "reboot": false, "error": "<message>"}`: not an SSH
    server, handshake failure, timeout.
- **SSH_POWER** (shutdown/reboot): only with a known host key. Checks it, logs in with the
  action's key, requests one fixed command and waits up to 5 s for its exit status. Exit status
  0, or the connection dropping before an exit status (the machine is going down), count as
  success. A non-zero exit status fails with the start of the command's error output, e.g.
  `"sudo -n shutdown -h now" failed with exit code 1: sudo: a password is required`.

  | | posix | posix, `sudo` | windows |
  | --- | --- | --- | --- |
  | shutdown | `shutdown -h now` | `sudo -n shutdown -h now` | `shutdown /s /t 0` |
  | reboot | `shutdown -r now` | `sudo -n shutdown -r now` | `shutdown /r /t 0` |

Every login is answered within 8 s, and the agent makes at most 10 SSH logins a minute (a check
takes two).

**Host keys** are trusted on first use: the first check runs without a known key and reports the
device's fingerprint (`SHA256:…`, the same as `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
on the device). Once you confirm it in the dashboard, every check and command insists on it.

### Setting up a Linux, macOS or BSD device

Use a dedicated user on the device (here `netignite`) without other rights:

1. Add the two lines from the dashboard's SSH tab to `~netignite/.ssh/authorized_keys`:

   ```text
   restrict,command="sudo -n shutdown -h now" ssh-ed25519 AAAA… netignite-agent-3-shutdown
   restrict,command="sudo -n shutdown -r now" ssh-ed25519 AAAA… netignite-agent-3-reboot
   ```

   `restrict` turns off forwarding, the agent and a PTY. The forced command means each key can
   run exactly its command, whatever the client asks for. Add `from="<this machine's IP>",`
   after `restrict,` to accept the keys only from the agent.

2. `sudo visudo -f /etc/sudoers.d/netignite`:

   ```text
   netignite ALL=(root) NOPASSWD: /usr/sbin/shutdown -h now, /usr/sbin/shutdown -r now, /sbin/shutdown -h now, /sbin/shutdown -r now
   ```

   `-n` makes sudo fail at once instead of asking for a password, so a missing sudoers line shows
   up in the dashboard as `sudo: a password is required`.

### Setting up a Windows device

Install OpenSSH Server (Settings → System → Optional features), start the `sshd` service, choose
**Windows** as the OS in the dashboard and put the two lines (`restrict,command="shutdown /s /t 0"
ssh-ed25519 …`) into `C:\ProgramData\ssh\administrators_authorized_keys` (only Administrators and
SYSTEM may have access). Windows only shuts down for administrators, so the username must be an
administrator account; the forced commands still limit each key to its command.

### Security

- The commands are fixed (table above). Nothing from the request ends up in them: the server only
  picks shutdown or reboot, posix or windows, and sudo or not. The agent requests no PTY, sets no
  environment and opens no forwarding; `SSH_POWER` opens one session for one command.
- No key is offered before the host key matched. `SSH_POWER` without a known host key is refused,
  so commands only ever go to a device whose key the owner confirmed.
- The server never has a credential: it can only make the agent log in where the agent's keys are
  allowed, which is exactly where shutdown and reboot are allowed anyway. The login limit keeps a
  compromised server from using the agent to probe the network.
- Outside Wake-on-LAN mode, without keys or without TLS, SSH requests are refused before anything
  is parsed.

## Uninstall

```bash
sudo netignite-agent uninstall           # keeps /etc/netignite/agent.json (root-only again)
sudo netignite-agent uninstall --purge   # also deletes the config with the credential
```

This stops and disables the service and the shutdown and reboot units, removes their unit files,
the user `netignite` and `/usr/local/bin/netignite-agent`. `--dry-run` shows the steps. Delete the agent in the
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
  `shutdown` or `reboot` (see [Shutdown and reboot](#shutdown-and-reboot)), about 1 s after the
  answer was sent; and in Wake-on-LAN mode `WAKE`, `STATUS`, `SSH_CHECK` and
  `SSH_POWER` (one of four fixed commands on another device, with the agent's own keys, see
  [SSH](#ssh)). Every parameter is validated: MAC addresses, ports, IP literals, host names,
  user names, host key fingerprints. Commands run without a shell, and only IP literals reach `ping`.
  Anything else is answered with an error. No remote shell, no file access, no configuration
  changes from the server.
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
- **The agent can't shut down on its own.** It can only ask, by creating a file in its runtime
  directory; two small root units do the shutdown or reboot and nothing else (next section).
- The compiled binary does not load `.env` or `bunfig.toml` from the working directory, so a
  stray file there can't change how a root-run `pair` or `install` behaves.

## Shutdown and reboot

The service user `netignite` has no right to shut the machine down. Instead:

1. The service has its own runtime directory `/run/netignite-agent` (`RuntimeDirectory=`, a tmpfs,
   owned by `netignite`, mode `0700`). Only the agent and root can write to it.
2. For a shutdown, the agent creates `/run/netignite-agent/shutdown` (`reboot` for a reboot).
3. `netignite-agent-shutdown.path` (`PathExists=`) sees the file and starts
   `netignite-agent-shutdown.service`, a root `oneshot` unit that removes the file and runs
   `systemctl --no-block poweroff` (or `reboot`). That's all it can do.
4. The agent waits up to 5 s for the file to disappear. If nothing picks it up, it deletes the
   file again (so it can't fire later) and the dashboard shows the error.

Before answering the server, the agent checks that the `.path` unit is active and asks logind for
block inhibitors (`ListInhibitors`): while something such as a package upgrade blocks shutdowns,
the dashboard says so and nothing happens. When the agent stops, systemd deletes its runtime
directory, and a pending request with it.

Versions before 1.0.0 used a polkit rule instead, which failed on machines without polkit
("Access denied"). `install` removes that rule.

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

SSH uses the [`ssh2`](https://github.com/mscdex/ssh2) package in pure JavaScript. `bunfig.toml`
turns dependency install scripts off (`ignoreScripts`), so its optional native addons (and
`cpu-features`) are never built, and the compile step marks `cpu-features` external. Without
that, a machine with a C toolchain (CI) would build NAN addons that `bun build --compile` embeds
in the binaries. The SSH tests use ssh2's own server (`tests/helpers/ssh-server.ts`); no sshd is
needed.

Releases: bump `version` in `package.json`, then push the tag `v<version>`. The release workflow
attaches `netignite-agent-linux-x64`, `netignite-agent-linux-x64-baseline`,
`netignite-agent-linux-arm64` and `SHA256SUMS`. Versions with a suffix (`1.0.0-beta.1`) become
pre-releases, which `releases/latest` skips.

## License

AGPL-3.0
