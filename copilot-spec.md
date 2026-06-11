# Grove Copilot Spec

Last updated: 2026-06-11

This file is the living working spec for Grove Copilot. Keep it updated whenever we change
copilot behavior, scopes, MCP tools, the kimi runtime, the permission flow, the journal, the
mutation lock, or SSH/SFTP connection handling. When implementation and this file disagree,
treat implementation as the current truth, then update this file in the same change.

## Current Role

Grove Copilot is the center stage of Grove and the primary actor for VM operations. Its
brain is **kimi-code CLI** running **locally** on the user's machine; Grove is the only path
to a VM. The division of trust:

- **kimi-code CLI** = reasoning, planning, tool selection, conversational memory.
- **Grove backend** = transport, credentials, command classification, confirmation, audit,
  journaling, and the only SSH/SFTP path to a VM.

kimi reaches VM operations exclusively through Grove's scoped **MCP** tools. It never holds
SSH keys, never opens its own SSH connection, and never types into the user's live terminal.
Mutating commands pause mid-turn for explicit user confirmation before they execute.

## Scopes

```ts
type CopilotScope = 'fleet' | `vm:${string}`   // src/types.ts
```

- **fleet** — the "All VMs" sidebar entry. Fleet-wide context and fleet-only tools.
- **vm:<id>** — a focused single machine. Selecting a VM in the sidebar sets this scope.

Each scope is independent: its own kimi session, workspace, journal file, busy state, and
timeline. The UI keys messages, tool calls, proposals, progress, and busy state by scope.

## Source Map

- Shared contracts: `src/types.ts`
  - `CopilotScope`, `vmScope`, `scopeVmId`
  - `CopilotMessage` (`scope`, `createdAt`, `streaming`), `CopilotToolCall` (`origin`
    distinguishes Grove-executed steps from agent-reported ones; `kind: 'think'` is a
    streamed thought block), `CopilotPlanState`/`CopilotPlanEntry`,
    `CopilotPermissionDecision`, `CopilotRuntimeStatus`, `CopilotProgressEvent`,
    `ActionProposal` (`scope`, `targetVmIds`, `toolCallId`, `decision`, `awaiting_confirmation`)
  - `AppSnapshot` (adds `toolCalls`, `plans`, `runtime`), `ServerEvent` (adds `copilot.delta`,
    `copilot.toolcall.updated`, `copilot.plan`, `copilot.runtime`)
- Backend routes: `server/app.ts` — validation, MCP mount, UI-token gate, scoped routes.
- Backend runtime state: `server/store.ts` — `GroveStore` implements `CopilotToolHost`; owns
  messages, tool calls, proposals, the per-VM mutation lock, pending permissions, journal
  hydration, and event publication.
- Driver contracts: `server/copilotTypes.ts` — `CopilotToolHost`, `CopilotDriver`,
  `DriverUpdate`, `PromptRequest`, `McpServerSpec`, `ToolResult`.
- Supervisor: `server/copilotSupervisor.ts` — owns the kimi process/driver, per-scope
  workspace + generated `AGENTS.md`, scoped MCP config, notes.
- Drivers: `server/drivers/acpDriver.ts`, `server/drivers/printDriver.ts`,
  `server/drivers/mockDriver.ts`.
- ACP transport: `server/acpClient.ts` — newline-delimited JSON-RPC over child stdio.
- MCP layer: `server/mcp/tools.ts` (scoped tool registry), `server/mcp/endpoint.ts`
  (HTTP endpoint + `ScopeTokenRegistry`), `server/mcp/groveStdioProxy.mjs` (stdio bridge
  kimi spawns).
- Provider/config: `server/copilotProvider.ts` — Moonshot env + generated kimi config file.
- Safety: `server/commandProfiles.ts` — `classifyCommand`, `isReadOnlyCommand`,
  `readOnlyCommandPrefixes`.
- Policy: `server/copilotPolicy.ts` — "always allow" rules.
- History: `server/copilotJournal.ts` — append-only JSONL per scope.
- Mutation lock: `server/mutationLock.ts` — `KeyedMutex`.
- API token: `server/apiToken.ts` — per-boot UI bearer token + middleware.
- Frontend client: `src/lib/api.ts` — bootstrap/token handshake, scoped routes, events.
- Frontend shell: `src/App.tsx` — scope state, event handling, rAF delta batching.
- UI: `src/components/Sidebar.tsx` (All VMs + per-VM, busy/attention markers),
  `src/components/CopilotPanel.tsx` (TUI-style transcript: execution steps, thinking,
  plan checklist, permission cards, Stop/Esc), `src/components/Markdown.tsx`
  (dependency-free markdown renderer for assistant output).

## kimi Runtime And Drivers

The supervisor talks to one `CopilotDriver`. Selection (`server/copilotSupervisor.ts`):

- `GROVE_USE_FIXTURES=true` or `GROVE_COPILOT_DRIVER=mock` → **MockDriver** (tests, offline).
- `GROVE_COPILOT_DRIVER=acp` → **AcpDriver** (one warm `kimi acp` process, many sessions;
  needs `kimi login` or a config providing credentials).
- default → **PrintDriver**: `kimi --print --output-format stream-json --yolo --work-dir
  <scope-workspace> --mcp-config-file <scope-mcp.json> --session <scope> --config-file
  <grove-kimi-config>`. Works non-interactively with the saved Moonshot key, no global login.

The default is print mode because it runs with the user's saved key via a Grove-local config
file (`.grove/runtime/kimi-config.toml`, generated from `GROVE_MOONSHOT_*`, never committed,
never put in any agent-readable workspace). `--yolo` auto-approves kimi's *built-in* tools
only; Grove's MCP layer still gates every mutating VM command. ACP is available for warm,
streamed, cancellable turns once the user has logged kimi in.

`DriverUpdate` values (`message_delta`, `thought`, `tool_call`, `plan`, `progress`) are the
common stream the store translates into Grove events regardless of driver.

## Execution Step Surfacing

Everything the agent does during a turn is a first-class timeline item, mirroring the
kimi-code TUI (`GroveStore.applyDriverUpdate`):

- **Agent tool calls** (`tool_call` updates) upsert a `CopilotToolCall` with
  `origin: 'agent'` and id `agent-<scope>-<callId>`, streaming status
  pending → running → completed/failed with args (`detail`) and output. Updates whose
  normalized title names a tool Grove instruments itself (`run_command`, `read_logs`,
  `service_status`, `list_files`, `fleet_run_command`, `inspect_vm`, `diagnose_service`)
  are **dropped** — the Grove-side
  card created by the tool host (real command, real SSH output, linked proposal) is the
  single authoritative step. Uninstrumented MCP reads (`get_vm`, `list_vms`,
  `get_history`, `record_note`) and kimi's built-in tools surface from the agent's view.
- **Thought chunks** stream into one open think-block per run (`CopilotToolCall` with
  `kind: 'think'`, `origin: 'agent'`, text in `output`). The block closes (status
  `completed`) when any non-thought update arrives or the turn ends; it is journaled once
  on close, not per chunk.
- **Plan updates** upsert one `CopilotPlanState` per turn (`plan-<assistantMessageId>`),
  published as `copilot.plan` and journaled; entries tick pending → in_progress →
  completed in place.
- **Answer anchoring**: the assistant message's `createdAt` is re-set to the arrival of its
  first text token, so the timeline reads steps-then-answer like the TUI transcript.
- Tool output stored on cards preserves line structure (`clipBlock`, capped at 200
  lines/8k chars) rather than being flattened to one line.

## MCP Tool Layer

Grove is an MCP server. kimi spawns `server/mcp/groveStdioProxy.mjs` (a dependency-free Node
stdio script) which forwards `tools/list` and `tools/call` to the backend over loopback HTTP
with a scope token. The backend builds the tool set per scope (`buildToolsForScope`):

Shared (both scopes): `list_vms`, `get_vm`, `get_history`, `record_note`, and `inspect_vm`
(composite: refreshes and returns live metrics + services + top processes in **one SSH
round-trip**, reusing the UI refresh path; vmId pinned in vm scope, required argument in
fleet scope).
VM scope only: `run_command`, `read_logs`, `service_status`, `list_files` (vmId is pinned,
never an argument), and `diagnose_service` (composite: systemctl status + recent journal +
listening ports for one unit in one exec).
Fleet scope only: `fleet_run_command` — once confirmed, targets run in **parallel** with
bounded concurrency (default 4, `GROVE_FLEET_CONCURRENCY`), still serialized per VM by the
mutation lock; results aggregate in target order.

Latency posture: the per-scope AGENTS.md steers the agent toward the composite tools and
toward packing multiple read-only probes into a single `run_command` script. The backend
warms the VM's SSH connection when a vm-scope prompt arrives (handshake overlaps kimi
startup), and every exec carries a timeout (120s read / 600s mutating, `timeoutMs` to
override) so a hung command fails the tool call instead of hanging the turn.

**Scope enforcement is physical, not prompt-based.** Each scope gets a random per-boot token
(`ScopeTokenRegistry`) carried in the MCP config's env. A `vm:<id>` session literally has no
tool that accepts another vmId and no fleet tool; a fleet session has no single-VM mutators.

## Permission Flow

`run_command` and `fleet_run_command` are the gate (`GroveStore.runScopedCommand` /
`fleetRunCommand`):

1. Read-only command (`isReadOnlyCommand`) → runs immediately over SSH, recorded as a tool
   call + activity, result returned to kimi in the same turn.
2. Policy allows it (`CopilotPolicy.allows`) → executes without a new prompt.
3. Otherwise → an `ActionProposal` with status `awaiting_confirmation` is created and the
   tool call **blocks** (`awaitDecision`) until the user decides or a 10-minute timeout
   denies it.

Decisions (`POST /api/copilot/proposals/:id/decision`, body `{ decision }`):

- `allow_once` → resume the tool call, execute under the per-VM mutation lock, return output.
- `always_allow` → same, plus a narrow `scope + command-prefix` rule saved to
  `.grove/copilot/policy.yaml`.
- `deny` → tool call returns a structured refusal; kimi adapts.

`/confirm` remains as an `allow_once` alias. Suggestion-button proposals
(`POST /api/copilot/proposals`) still execute directly via `runLegacyProposal`.

Fleet commands **freeze their target VM list** when the proposal is created, run one SSH
command per target under the lock, and report per-VM results. The copilot still never writes
to the interactive terminal stream.

## Concurrency: Per-VM Mutation Lock

`KeyedMutex` (`server/mutationLock.ts`) serializes mutating work per VM id across all
sources — copilot tool calls from any scope, confirmed proposals, fleet runs. Read-only
inspections bypass the lock. A queued call publishes "Queued behind work on <vm>" progress.

## History Memory

Three layers:

1. **kimi sessions** — per-scope conversational memory (`--session <scope>`), resumable.
2. **Operation journal** (`server/copilotJournal.ts`) — append-only JSONL per scope under
   `.grove/copilot/journal/`. Records messages, tool calls, proposals, and plans
   (upsert-by-id, last write wins). Hydrates the UI timeline on backend restart
   (`GroveStore` constructor) and backs the `get_history` tool. Disabled in fixtures/test
   mode so tests never touch real `.grove`. On load it **reconciles** interrupted work:
   streaming messages are finalized, running tool calls become `failed` (interrupted
   think-blocks become `completed` — a thought has no failure mode),
   `awaiting_confirmation` proposals become re-runnable `pending_confirmation` drafts.
3. **Distilled notes** (`notes.md` per scope workspace) — written by the `record_note` tool,
   read natively by kimi on session start.

## Scope Workspaces

`.grove/copilot/` holds per-scope state:

```text
.grove/copilot/
  journal/<scope>.jsonl       # operation journal
  policy.yaml                 # always-allow rules
  mcp/<scope>.json            # kimi --mcp-config-file pointing at the stdio proxy + token
  workspaces/<scope>/
    AGENTS.md                 # generated, stable facts only; refreshed each prompt
    notes.md                  # agent-maintained durable memory
```

`AGENTS.md` contains only **stable** facts (identity, connection, tracked services, how to
use the tools, fleet siblings). Volatile runtime state (metrics/health/processes) is
deliberately excluded — long-lived sessions fetch it live via `get_vm`/`run_command`.

## Security: UI Bearer Token

`server/apiToken.ts` generates a per-boot token (`generateUiToken`), persisted to
`.grove/runtime/ui-token`. Mutating HTTP routes require it in `x-grove-token`
(`uiTokenMiddleware`); reads, `/api/health`, `/api/bootstrap`, and `/api/mcp/*` are exempt
(MCP carries its own scope token). The UI fetches the token from `/api/bootstrap` at load
(`setApiToken`). The token never appears in any agent context, workspace file, or MCP
config, so a co-resident kimi process cannot reach mutating routes by `curl localhost` — its
only path to a VM is its own scoped MCP endpoint. This is defense-in-depth for a single-user
local tool, not an absolute boundary against same-user code.

## Frontend State And Streaming

`src/App.tsx` hydrates from `/api/bootstrap` (token + runtime) and `/api/snapshot`, then
subscribes to `WS /api/events`. The events socket **auto-reconnects with backoff**
(`createEventsSocket` in `src/lib/api.ts`): the dev backend restarts on every server-file
save, which would otherwise leave an open tab deaf and — because the UI token is per-boot —
unable to perform any mutating action. On each (re)connection the server pushes a fresh
`snapshot`, and the client re-runs the bootstrap handshake to pick up the rotated token.
Scope-relevant events:

- `snapshot` — replaces vms/transfers/messages/proposals/toolCalls/plans/runtime.
- `copilot.message` — append/replace (clears the delta buffer when finalized; also
  re-published when the first answer token re-anchors the message's `createdAt`).
- `copilot.delta` — token chunks, buffered and flushed once per `requestAnimationFrame` so a
  token stream costs one render per frame, not per token.
- `copilot.toolcall.updated` — upsert execution steps (grove + agent + think blocks).
- `copilot.plan` — upsert the turn's plan checklist.
- `copilot.progress` — drives per-scope busy state and the working indicator.
- `copilot.proposal.updated` — upsert permission/suggestion cards.
- `copilot.runtime` — kimi driver/state for the panel header and Settings.

`CopilotPanel` renders a single scope's interleaved timeline as a kimi-code-TUI-style
transcript:

- user input echoed as a `>`-prefixed monospace line;
- execution steps as `⏺ title(args)` lines with status-colored bullets (pulsing while
  running, green/red on completion) and `⎿`-connected output blocks, previewing the first
  5 lines with a `… +N lines` expander;
- thought blocks as dim italic `✻ Thinking…` text, live while streaming and collapsed
  behind a `Thought` toggle once closed;
- the plan as a checklist that ticks off in place (☐ pending, ▸ in progress, ✓ completed
  with strikethrough);
- permission cards with Allow once / Always allow / Deny and the exact command; a decided
  card acknowledges the click immediately ("Allowed — executing…" with the buttons gone,
  optimistically client-side and via a broadcast decision update server-side) and flips to
  Executed/Dismissed when the command finishes;
- **one confirmation at a time, in order**: a per-scope queue in the store
  (`requestConfirmation`) holds parallel gated tool calls so their cards surface strictly
  in arrival order — the next card appears only once the previous one is decided, and a
  queued call re-checks policy at the head so an always-allow grant skips its card. The
  panel additionally renders buttons only on the oldest undecided card ("Queued — decide
  the command above first." on the rest). Cancelling a scope releases its paused
  confirmations as dismissed ("Cancelled.") so the queue never blocks the next turn;
- completed assistant turns rendered as full markdown (`src/components/Markdown.tsx`:
  headings, fenced code with language label, inline code, bold/italic/strikethrough,
  links, nested + task lists, blockquotes, pipe tables, rules); the streaming message
  stays plain text with a cursor until finalized (perf budget);
- a `✻ <progress>… (esc to interrupt)` status line while busy; Esc and the Stop button
  both cancel (`POST /api/copilot/cancel`).

The sidebar shows an attention dot when a scope has an awaiting proposal and a spinner when
a scope is busy, even when focused elsewhere.

## Public Interfaces (copilot)

HTTP:

- `GET /api/bootstrap` — `{ token, runtime }`.
- `POST /api/copilot/messages` — `{ scope, message }`.
- `POST /api/copilot/cancel` — `{ scope }`.
- `GET /api/copilot/runtime` — `CopilotRuntimeStatus`.
- `POST /api/copilot/proposals` — suggestion-button proposal `{ vmId, activeTab, actionType }`.
- `POST /api/copilot/proposals/:id/decision` — `{ decision }`.
- `POST /api/copilot/proposals/:id/confirm` — `allow_once` alias.
- `GET /api/copilot/provider`, `POST /api/copilot/provider` — Moonshot key (passed to kimi).
- `GET /api/mcp/tools`, `POST /api/mcp/call` — scope-token-authenticated MCP endpoint.

WebSocket: `WS /api/events` (adds `copilot.delta`, `copilot.toolcall.updated`,
`copilot.plan`, `copilot.runtime`), `WS /api/vms/:vmId/terminal` (unchanged).

When changing a public interface, update together: `src/types.ts`, `src/lib/api.ts`,
`server/app.ts`, `server/store.ts`, and tests.

## Safety Boundaries

- `server/commandProfiles.ts` is the security boundary: `classifyCommand` flags mutating
  patterns; `isReadOnlyCommand` requires both non-mutating classification and an approved
  prefix from `readOnlyCommandPrefixes`. Treat changes here as security-sensitive.
- Mutating commands always require explicit confirmation (or a stored always-allow rule).
- Free-form chat needs a configured Moonshot key (for kimi) or kimi login; without it the
  driver surfaces an error state instead of inventing a local answer mode.
- The kimi config file embeds the API key and lives only under gitignored `.grove/runtime/`.

## Testing And Offline Mode

`MockSshSessionManager` + `apiDisabled()` fixtures extend to the copilot via `MockDriver`,
which replays scripted `DriverUpdate` sequences. Its default script walks the full update
surface (thought, plan, tool-call lifecycle, streamed text) so offline development renders
the same timeline a real kimi turn does. `GroveStore` accepts a `driver` option so tests
inject a scripter. Covered in Vitest: streaming/scoped chat, agent step surfacing +
grove-tool dedup, thought blocks, plan events and hydration, answer anchoring, read-only vs
gated mutating commands, allow/deny decisions, cancel, scoped MCP tool exposure + auth,
fleet-tool scoping, the UI token gate, journal hydration/reconciliation, and the mutation
lock.

## Current Gaps And Future Work

- ACP driver is implemented but secondary; print mode is the verified default. The ACP
  `session/update` and `session/request_permission` shapes are mapped leniently and should be
  pinned against a specific kimi ACP version when ACP becomes primary.
- Print driver's `stream-json` parser is intentionally lenient across kimi versions; tighten
  once the schema is stable.
- `sftp_transfer` structured execution and long-running ops via `systemd-run` are designed in
  `docs/copilot-redesign.md` but not yet built.
- Policy management UI (list/revoke always-allow rules) and the terminal→copilot bridge are
  planned (Phase 3 in the redesign doc).
- Global attention surfacing is in the sidebar; a toast for off-scope permission requests is
  still pending.
