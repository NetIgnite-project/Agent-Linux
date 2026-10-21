# AGENTS.md — operating manual for AI coding agents

You are working in the NetIgnite Agent for Linux (`netignite-agent`), a LeiCraftMC CLI tool built
from the `cli-tool` template. Follow the LeiCraftMC Style Guides:
https://github.com/LeiCraftMC/Style-Guides.

## Must read

- [docs/00-overview.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/00-overview.md)
- [docs/11-cli-and-infra.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/11-cli-and-infra.md)
- `README.md`: what the agent does, the protocol it speaks, the security model.

## Non-negotiable

- Use `@cleverjs/cli` for command handling. `src/utils/caseSensitiveCLIApp.ts` replaces
  `CLIApp.handle()`, which lower-cases every argument (URLs, paths, tokens).
- CLI Logger from `src/utils/logger.ts` (with `logHistory` for crash dumps).
- Global `--log-level` flag on the app (it goes before the command).
- `VersionCMD` reads `process.env.APP_VERSION`.
- Compile script in `scripts/compile/` supports `auto`, `all`, and platform targets.
- Format with Biome before finishing.
- Conventional Commits.

## Layout

- `src/commands/`: one `CLIBaseCommand` per command (`pair`, `install`, `uninstall`, `run`,
  `status`, `wol-mode`, `wol`, `version`).
- `src/agent/`: `AgentClient` (WebSocket, HELLO, reconnects, giving up on 401/4003/4004),
  `RequestHandler` (PING, WAKE, STATUS, HOST_CONTROL), `HostControl` (the two fixed
  `systemctl` commands), `HostInfo` (HELLO info).
- `src/protocol/agentProtocol.ts`: protocol v2 frames and request schemas.
- `src/net/`: MAC addresses, magic packets, server URLs, ping / TCP / neighbor-table probes.
- `src/install/`: `InstallPlan` (pure list of steps), `SystemFiles` (unit file and polkit rule,
  pure), `PlanRunner` (executes or prints a plan), `SystemFacts` (read-only system checks).
- `src/config/agentConfig.ts`: `/etc/netignite/agent.json` (holds the secret; always 0600).

## Rules for changes

- The server is the source of truth for the protocol: `server/lib/agents/{protocol,gateway,
  registry,connection,auth}.ts` and the enroll route in the Server repo (branch `v2`). Keep
  `tests/helpers/server-protocol.ts` a copy of the server's schemas.
- The server may only trigger fixed actions. Never pass anything from a request to a shell or
  a command line except validated IP literals for `ping`.
- Never print or log the secret, the bearer credential or the enrollment token.
- Anything that changes the system goes through `InstallPlan` + `PlanRunner`, so `--dry-run`
  shows it and the plan can be tested.
- Exit status 78 means "the server rejected the credential". The unit has
  `RestartPreventExitStatus=78`; keep both in sync (`SystemFiles.EXIT_CREDENTIAL_REJECTED`).
- The release asset names (`netignite-agent-linux-{x64,x64-baseline,arm64}`, `SHA256SUMS`) are
  used by the server's install script. Don't rename them.

## Tests

- `bun test`: unit tests plus integration tests against `tests/helpers/fake-server.ts` (a
  Bun.serve stand-in for the server's enroll route and `/ws/agent`).
- `tests/agent.integration.test.ts` runs the client in-process with injected executors and short
  timings. `tests/cli.integration.test.ts` runs `bun src/index.ts` as a subprocess. Never send
  `HOST_CONTROL` to a subprocess agent: on Linux it would run the real `systemctl`.
- Tests that need POSIX file modes or signals use `test.skipIf(process.platform === "win32")`.
- systemd, polkit and a real shutdown can't be tested automatically. Before a release, check them
  by hand on a Linux host with systemd: pair, `install`, shutdown and reboot from the dashboard,
  `wol-mode on` + a WAKE, `uninstall --purge`.
