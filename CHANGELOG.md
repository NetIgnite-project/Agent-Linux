# Changelog

## 1.0.0 (2026-10-21)

The first stable release of the NetIgnite agent for Linux, for NetIgnite server 2.0.0 or newer.

### Changes since 1.0.0-beta.1

- **Shutdown and reboot no longer need polkit.** They failed with "Access denied" on machines
  without polkit. The agent now asks by creating a file in its runtime directory
  (`/run/netignite-agent`, writable only by its user), and two root units that `install` sets up
  (`netignite-agent-shutdown.path`/`.service`, `netignite-agent-reboot.path`/`.service`) run
  `systemctl poweroff` or `reboot`, and nothing else. Run `sudo netignite-agent install` again
  after updating; it also removes the old polkit rule.

Install it from the dashboard: create a Linux agent and run the command its page shows,
`curl -fsSL https://<server>/install/linux.sh | sudo sh -s -- <token>`. It replaces the v1
"server" agent, which can't connect to a v2 server.

## 1.0.0-beta.1 (2026-10-21)

The first release of the NetIgnite agent for Linux, for NetIgnite server 2.0.0-beta.2 or newer.

- `pair <server-url> <token>`: enrolls with a single-use token from the dashboard; the agent
  generates its own secret and stores it in `/etc/netignite/agent.json` (0600).
- `install` / `uninstall`: a systemd service running as the unprivileged user `netignite`, and a
  polkit rule that only allows it to power off and reboot (replaced in 1.0.0). `--dry-run` shows
  every step.
- Host mode: the dashboard sees whether the machine is online and can shut it down or reboot it.
- Wake-on-LAN mode (`run --wol`, `wol-mode on`): wakes other devices in the network, checks their
  status (ping, TCP port, IPv6 link-local from the MAC) and logs in to them over SSH for status
  checks and shutdown/reboot (fixed commands, trusted host key).
- A revoked or deleted agent stops (exit code 78) instead of retrying forever.
- Binaries: `netignite-agent-linux-x64`, `-x64-baseline` (CPUs without AVX2) and `-arm64`, with
  `SHA256SUMS`. The server's `/install/linux.sh` picks the right one.
