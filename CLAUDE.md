# CLAUDE.md — Claude Code specifics

Read `AGENTS.md` first. This file adds Claude-Code-specific notes.

## Slash commands

Defined in `.claude/settings.json`:

- `/verify` — typecheck + relevant tests.
- `/typecheck` — `bun run typecheck`.
- `/test` — `bun test`.
- `/compile` — build the standalone binary.

Before finishing: `bun test`, `bun run typecheck` and `bun run check` must pass. The only Biome
warnings left are the template logger's `noThisInStatic` ones.

## Windows

Development happens on Windows, but the binaries are Linux-only. `bun run compile` cross-compiles
them; they can't run on the host. To try one, use WSL without root (`version`, `pair`, `run`,
`status`, `install --dry-run`). Don't run `install`, `uninstall` or `HOST_CONTROL` on a
machine you don't mean to change or shut down.

To try SSH with a compiled binary: WSL Debian has no sshd, and its apt lists are stale (no root
for `apt-get update`). Download `openssh-server` (plus `libwrap0`, `libwtmpdb0`) from
`deb.debian.org/debian/pool/` into the home directory, `dpkg -x` it, and run `sshd -f` as the
user with its own config (`Port` > 1024, `UsePAM no`, `StrictModes no`, `AuthorizedKeysFile`,
`SshdSessionPath`/`SshdAuthPath` pointing at the extracted binaries, `LD_LIBRARY_PATH` for the
libs). Give every key a forced command that only logs, never a real `shutdown`. WSL's bun
(`~/.bun/bin/bun`) can run `tests/helpers/fake-server.ts` from `/mnt/l/...`. `wsl.exe` expands
`$VAR` in its arguments: put shell code in a script file.

## Releases

`.github/workflows/release.yml` runs on `v*` tags. The tag must equal `v` + `"version"` in
`package.json` (the binaries report that version). It attaches `netignite-agent-linux-x64`,
`netignite-agent-linux-x64-baseline`, `netignite-agent-linux-arm64` and `SHA256SUMS`. Versions
with a suffix become pre-releases.

```bash
git tag v1.2.3
git push origin v1.2.3
```
