# Grove Project Spec

Last analyzed: 2026-06-10

## Purpose

Grove is a local-first, single-user VM management console for Linux machines reachable over SSH. It gives the user one desktop web app for:

- Managing SSH connection profiles for a small fleet of VMs.
- Inspecting live runtime health, services, processes, and filesystem state.
- Running interactive SSH terminal sessions and explicit command actions.
- Moving files between the local machine and remote VMs over SFTP.
- Deploying simple app services through AppRunner into `~/services`.
- Using Moonshot/Kimi-backed Grove Copilot for operational help with strict confirmation boundaries.

The app is intentionally local-machine scoped. The frontend is a React/Vite UI; the backend is a local Node/TypeScript service that owns all SSH, SFTP, terminal, persistence, and copilot tool execution.

## Architecture And Ownership

- Frontend: React 19, Vite, TypeScript, Tailwind CSS, Radix UI primitives, lucide-react icons, and xterm.js. Main state orchestration is in `src/App.tsx`; reusable views live under `src/components/`.
- Backend: Express 5 HTTP API plus `ws` WebSocket endpoints. `server/index.ts` starts the service, `server/app.ts` defines routes and Zod request validation, and `server/store.ts` owns app behavior and event publication.
- Shared contracts: `src/types.ts` is the source of truth for domain objects, API payloads, and WebSocket event shapes. Any route, event, or UI state change should update these types first.
- SSH/SFTP layer: `server/sshSessionManager.ts` provides both real and mock adapters. The real adapter uses `ssh2`, caches clients by VM id, retries one channel-open failure after resetting the client, supports SFTP file transfer, and opens interactive PTY shells for terminal tabs.
- Copilot layer: the brain is **kimi-code CLI** running locally, driven by `server/copilotSupervisor.ts` over a `CopilotDriver` (ACP, print, or mock). kimi reaches VM operations only through Grove's scoped MCP tools (`server/mcp/`), which delegate to `GroveStore`. See `copilot-spec.md` for the full design.
- Runtime state: project-local state defaults to `.grove/`, can be overridden with `GROVE_STATE_DIR`, and is ignored by Git.

Important local state files:

```text
.grove/
  .env.local        # Moonshot provider config and local secrets
  inventory.yaml    # VM connection metadata only
  apprunner.yaml    # AppRunner service metadata
  keys/             # optional private keys, never tracked
  downloads/
  local-files/
```

## Product Behavior

- VM inventory comes from `.grove/inventory.yaml` unless `GROVE_USE_FIXTURES=true` or the inventory is missing, in which case fixture VMs are used.
- Inventory entries may reference SSH key paths or SSH agent usage, but must never contain private key material or passwords. Relative key paths resolve from the project state directory, so `keys/example.pem` means `.grove/keys/example.pem`.
- The UI has six tabs: Overview, Files, Terminal, AppRunner, Activity, and Settings.
- Overview shows health, metrics, alerts, services, and top processes from SSH runtime sampling.
- Files is a dual-pane local/remote browser. Local listing uses the backend filesystem; remote listing and upload/download use SFTP.
- Terminal uses an interactive SSH PTY over `WS /api/vms/:vmId/terminal`. In API-disabled test mode it falls back to an in-browser mock shell.
- Activity events are audit-oriented and should be emitted for failed SSH/SFTP work, command runs, confirmed copilot actions, file transfers, VM changes, and AppRunner changes.
- Settings owns SSH profile editing, connection testing, VM metadata display, and Moonshot/Kimi provider setup.

## Public Interfaces

Current HTTP routes:

- `GET /api/health`
- `GET /api/snapshot`
- `GET /api/vms`
- `POST /api/vms`
- `GET /api/vms/:vmId`
- `PATCH /api/vms/:vmId`
- `DELETE /api/vms/:vmId`
- `GET /api/vms/:vmId/metrics`
- `POST /api/vms/:vmId/actions/reboot`
- `GET /api/vms/:vmId/files?path=/remote/path`
- `POST /api/vms/:vmId/commands`
- `GET /api/vms/:vmId/app-services`
- `POST /api/vms/:vmId/app-services`
- `PATCH /api/vms/:vmId/app-services/:serviceName`
- `DELETE /api/vms/:vmId/app-services/:serviceName`
- `GET /api/local/files?path=/local/path`
- `GET /api/local/defaults`
- `POST /api/local/open-folder`
- `GET /api/transfers`
- `POST /api/transfers`
- `GET /api/bootstrap` (UI token + copilot runtime status)
- `POST /api/copilot/messages` (`{ scope, message }`)
- `POST /api/copilot/cancel` (`{ scope }`)
- `GET /api/copilot/runtime`
- `GET /api/copilot/provider`
- `POST /api/copilot/provider`
- `POST /api/copilot/proposals`
- `POST /api/copilot/proposals/:proposalId/decision` (`{ decision }`)
- `POST /api/copilot/proposals/:proposalId/confirm` (allow-once alias)
- `GET /api/mcp/tools`, `POST /api/mcp/call` (scope-token-authenticated MCP endpoint kimi uses)

Current WebSocket routes:

- `WS /api/events` publishes `ServerEvent` values and sends an initial `snapshot`.
- `WS /api/vms/:vmId/terminal` streams terminal status and PTY data.

When changing a public interface, update all of these together:

- Shared type definitions in `src/types.ts`.
- Frontend API helpers in `src/lib/api.ts`.
- Backend validation and route handling in `server/app.ts`.
- Store behavior and event publication in `server/store.ts`.
- Tests covering the new or changed contract.

## Safety And Security Invariants

- Do not commit `.grove/`, `*.pem`, `.env*` other than `.env.example`, logs, downloads, build output, or dependency folders.
- Do not print or document real values from `.grove/.env.local`, private keys, or real inventories. If inspection is needed, summarize structure without exposing secrets.
- Copilot must not type into or control the user's live terminal. Interactive terminal streams and copilot SSH exec jobs stay separate.
- Copilot may directly run only read-only inspections (`isReadOnlyCommand` in `server/commandProfiles.ts`) through the scoped MCP `run_command`/`read_logs`/`service_status`/`list_files` tools. Mutating commands, package operations, file writes, deletes, service restarts, reboots, privilege escalation, and destructive actions pause for explicit user confirmation before executing.
- Free-form copilot chat needs a configured Moonshot key (for kimi) or `kimi login`. Without it the kimi driver surfaces an error runtime state instead of inventing a local answer mode.
- Confirmed copilot actions execute through `GroveStore` under a per-VM mutation lock and produce activity events. Fleet commands freeze their target VM list when proposed, execute one SSH command run per VM, and report per-VM results.
- The command classifier in `server/commandProfiles.ts` is a safety boundary. Treat changes there as security-sensitive.
- Mutating HTTP routes require the per-boot UI token (`server/apiToken.ts`); the scoped MCP endpoint requires a per-scope token. Neither token is ever placed in agent-readable context.
- The generated kimi config (`.grove/runtime/kimi-config.toml`) embeds the Moonshot key; it lives only under gitignored `.grove/runtime/` and must never be committed.

## AppRunner Rules

- AppRunner deploys services under `$HOME/services/<service-name>` and writes a systemd unit named `grove-apprunner-<service-name>.service`.
- Service names must be lowercase slugs with letters, numbers, and hyphens. Renaming is intentionally unsupported; remove and recreate instead.
- Ports must be unique per VM and in the range `1..65535`.
- Sources can be local folders or GitHub repositories. GitHub URLs must point to `github.com` and must not include embedded credentials.
- Local source uploads must filter generated folders and gitignored files through `collectLocalProjectFiles`.
- AppRunner metadata belongs in `.grove/apprunner.yaml`, not in VM inventory.

## Development Guidance

- Prefer existing patterns over new abstractions. Most behavior belongs in `GroveStore`; route files should validate and delegate.
- Keep `src/types.ts` aligned with backend responses and WebSocket payloads. Avoid duplicate ad hoc payload shapes.
- Preserve the fixture/local fallback path used by tests and offline UI development. `apiDisabled()` is true in Vitest and when `VITE_DISABLE_API=true`.
- UI should feel like a dense operational console: restrained colors, compact panels, predictable tabs, icon buttons where appropriate, and no marketing-style landing page.
- Continue using Tailwind utility classes and existing Radix primitives. `src/App.css` appears to be leftover starter CSS and is not imported; prefer `src/index.css` plus component classes.
- For frontend changes, test realistic user flows with Testing Library and keep accessible labels stable.
- For backend changes, prefer Zod validation at the route boundary and focused Vitest/Supertest coverage.

## Verification Commands

```bash
npm test
npm run lint
npm run build
```

Use narrower Vitest runs while iterating, then run the full suite before finishing behavior changes.
