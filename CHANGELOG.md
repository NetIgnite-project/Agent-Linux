# Changelog

## Unreleased

SSH and the Windows and macOS agents need the NetIgnite server release after 2.0.0. With server
2.0.0, the Linux agent works as before, but without SSH.

- **Windows and macOS.** The same agent now runs on Windows 10/11 and macOS (host mode: status,
  shutdown, reboot; Wake-on-LAN mode stays Linux-only, so `pair --wol` there warns and stores host
  mode, and there are no SSH keys). Windows: a scheduled task started at boot as `LOCAL SERVICE`,
  which runs `shutdown.exe` with fixed arguments; the config folder is restricted to SYSTEM and
  Administrators (plus read for the agent, which `uninstall` takes back). macOS: launchd daemons, the
  agent as the hidden user `_netignite`, which asks a root daemon per action (`QueueDirectories`)
  to run `/sbin/shutdown`, like the systemd units on Linux. New binaries
  `netignite-agent-windows-x64.exe`, `netignite-agent-macos-arm64` and `netignite-agent-macos-x64`.
- **Shutdown and reboot no longer need polkit.** They failed with "Access denied" on machines
  without polkit. The agent now asks by creating a file in its runtime directory
  (`/run/netignite-agent`, writable only by its user), and two root units that `install` sets up
  (`netignite-agent-shutdown.path`/`.service`, `netignite-agent-reboot.path`/`.service`) run
  `systemctl poweroff` or `reboot`, and nothing else. Run `sudo netignite-agent install` again
  after updating; it also removes the old polkit rule.
- **SSH with the agent's own keys.** The agent no longer gets passwords or private keys from the
  server. On Linux, `pair` (and `install` or `wol-mode on` for older configs) creates two Ed25519
  key pairs in the config, one for shutdown and one for reboot; HELLO reports only the public keys
  (`ssh_keys`), and the dashboard shows them as `authorized_keys` lines with forced commands.
  Requests are renamed: `SSH_EXEC` is now `SSH_POWER`, the capability `ssh` is now `ssh.power`.
  `SSH_CHECK` logs in with both keys and reports which ones the device accepts.
- SSH is only offered over an `https://` server address, and the agent makes at most 10 SSH
  logins a minute. Pairing again keeps the SSH keys. A config with an unusable SSH key still
  loads (without SSH); `install`, `pair` or `wol-mode on` create new keys.
- Windows: `install` grants the `LOCAL SERVICE` account the right to shut the machine down (via
  `secedit`; Windows doesn't grant it to that account itself), `uninstall` takes it back — the
  Windows way of the polkit rule this release replaces on Linux.
- Windows: `pair` restricts the config folder it creates to SYSTEM, Administrators and the
  account running it, so other local users can't read the secret before `install` applies the
  agent's access rights.
- `run --log-file <path>`: also log to a file (1 MB, then one `.1`); the Windows task and the macOS
  daemon use it.
- `status` no longer waits 5 seconds after the credential check before it exits.
- Folders that `pair` and `install` create on the way to the config or the log (for example
  `/usr/local/etc` on a new Mac) get mode 0755, so the service user can reach its files.
- The log history kept for crash reports is capped at 200 lines (it grew with every line before).

## 1.0.0 (2026-10-21)

The first stable release of the NetIgnite agent for Linux, for NetIgnite server 2.0.0 or newer. No
changes since 1.0.0-beta.1; everything it can do is listed below.

Install it from the dashboard: create a Linux agent and run the command its page shows,
`curl -fsSL https://<server>/install/linux.sh | sudo sh -s -- <token>`. It replaces the v1
"server" agent, which can't connect to a v2 server.

## 1.0.0-beta.1 (2026-10-21)

The first release of the NetIgnite agent for Linux, for NetIgnite server 2.0.0-beta.2 or newer.

- `pair <server-url> <token>`: enrolls with a single-use token from the dashboard; the agent
  generates its own secret and stores it in `/etc/netignite/agent.json` (0600).
- `install` / `uninstall`: a systemd service running as the unprivileged user `netignite`, and a
  polkit rule that only allows it to power off and reboot. `--dry-run` shows every step.
- Host mode: the dashboard sees whether the machine is online and can shut it down or reboot it.
- Wake-on-LAN mode (`run --wol`, `wol-mode on`): wakes other devices in the network, checks their
  status (ping, TCP port, IPv6 link-local from the MAC) and logs in to them over SSH for status
  checks and shutdown/reboot (fixed commands, trusted host key).
- A revoked or deleted agent stops (exit code 78) instead of retrying forever.
- Binaries: `netignite-agent-linux-x64`, `-x64-baseline` (CPUs without AVX2) and `-arm64`, with
  `SHA256SUMS`. The server's `/install/linux.sh` picks the right one.
