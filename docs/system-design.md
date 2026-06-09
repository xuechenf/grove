# Grove System Design v1

## Summary

Grove is a local-first VM management webapp for a small set of Linux VMs reachable over SSH. The React/Vite UI talks to a local Node/TypeScript backend that owns SSH, SFTP, metrics polling, terminal sessions, file transfers, activity logging, and copilot tool execution.

The first real version is single-user and local-machine scoped. Runtime app information is stored in a project-local `.grove/` directory that is ignored by Git.

## Architecture

- Frontend: React/Vite app using API clients and WebSocket event streams.
- Local backend: Node/TypeScript HTTP and WebSocket service on localhost.
- SSH layer: pooled per-VM SSH/SFTP session manager interface with idle timeout, reconnect, operation timeout, and clear connection state.
- State: config and runtime artifacts live under `.grove/`, overridable as a group with `GROVE_STATE_DIR`.
- Inventory: `.grove/inventory.yaml` references SSH key paths or SSH agent usage; it never stores private key material or passwords.
- Metrics: agentless SSH polling using safe Linux command profiles.
- Copilot: local backend agent with Moonshot/Kimi tool calling, local SSH/SFTP skills, and a propose-and-confirm model for mutating actions.

## Copilot, Terminal, And SSH

The copilot does not directly type into or control the user's live terminal session.

The backend exposes two SSH execution paths:

- Interactive terminal sessions use user-owned PTY sessions streamed over `WS /api/vms/:vmId/terminal`.
- Copilot command runs use non-interactive SSH `exec` jobs routed through the SSH Session Manager.

Copilot receives context from the selected VM, active tab, metrics, file selections, recent activity, and optionally user-selected terminal output. Free-form chat is routed through a backend Moonshot/Kimi agent. If `GROVE_MOONSHOT_API_KEY` is missing, chat returns a setup error instead of using a local answer mode. Kimi may run live read-only SSH/SFTP inspections, or propose commands with a preview, risk label, affected VM/path, and expected result.

Read-only inspection commands can run only through approved command profiles or built-in diagnostics, such as `uptime`, `df -h`, `free -h`, service status, process/listener checks, limited log reads, and the Shadowsocks service/process/socket diagnostic. Mutating commands always require confirmation, including reboot, file writes, deletes, service restarts, package operations, and privilege escalation.

Confirmed copilot actions execute through backend APIs, not by injecting text into the live terminal. The terminal may offer an insert-command affordance later, but the user must run inserted text manually. If a live terminal is active while copilot runs a command, the two streams remain separate to avoid interleaved output and confusing state.

## APIs

- `GET /api/snapshot`
- `GET /api/vms`
- `GET /api/vms/:vmId`
- `POST /api/vms/:vmId/actions/reboot`
- `DELETE /api/vms/:vmId`
- `GET /api/vms/:vmId/metrics`
- `GET /api/vms/:vmId/files?path=/remote/path`
- `GET /api/local/defaults`
- `POST /api/vms/:vmId/commands`
- `POST /api/transfers`
- `GET /api/transfers`
- `POST /api/copilot/messages`
- `GET /api/copilot/provider`
- `POST /api/copilot/provider`
- `POST /api/copilot/proposals`
- `POST /api/copilot/proposals/:proposalId/confirm`
- `WS /api/events`
- `WS /api/vms/:vmId/terminal`

## Copilot Provider Config

Backend startup loads `.grove/.env.local` before reading process environment. Keep secrets in `.grove/.env.local` or the shell environment, not in tracked source.

```bash
GROVE_MOONSHOT_API_KEY=...
GROVE_MOONSHOT_BASE_URL=https://api.moonshot.cn/v1
GROVE_MOONSHOT_MODEL=kimi-k2.6
```

The Settings tab saves these values to `.grove/.env.local` through `POST /api/copilot/provider`.

## Behavior Rules

- Top VM actions remain: status indicator, `Reboot`, and `Delete`.
- `Reboot` runs a confirmed backend action over SSH.
- `Delete` removes the VM from Grove inventory only.
- Start, stop, suspend, snapshot, and clone are out of v1 because SSH alone cannot reliably perform those without hypervisor integration.
- Mutating operations always require confirmation.
- Failed SSH, failed SFTP, stale metrics, rejected confirmations, and copilot executions produce Activity events.

## Parallel Workstreams

- Frontend Integration: API clients, WebSocket event handling, loading/error states.
- Backend Core: local service, inventory loader, route validation, shared types.
- SSH/SFTP: pooled sessions, command execution, terminal bridge, transfer jobs.
- Metrics/Activity: polling, parsers, thresholds, audit events.
- Copilot: Moonshot/Kimi chat provider, tool schema, context packaging, proposal schema, confirmation flow, safety rules.
- Testing/DevEx: mock SSH/SFTP harness, API tests, UI integration tests, run scripts.

## Implementation Status

The current implementation includes the local backend API shape, event WebSocket, terminal WebSocket, config-file inventory validation, real and mock SSH/SFTP adapters, frontend API hydration, Moonshot/Kimi-backed copilot tool calling, copilot proposal confirmation through the backend, and tests.
