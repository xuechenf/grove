# Grove Copilot Redesign Proposal

Status: proposal (not yet implemented). The living implementation spec remains `copilot-spec.md`.
Date: 2026-06-11

## Goal

Make Grove Copilot the center stage of Grove: the primary actor that drives most VM
operations, with the tabbed workspace demoted to an instrument panel the copilot (and the
user) can open into.

Hard requirements:

1. The copilot brain is **kimi-code CLI** (`kimi`), not a hand-rolled chat-completions loop.
2. The agent runs **locally** on the user's machine. No agent process is installed on VMs.
   A short-lived helper on a VM is allowed only where strictly necessary (long-running ops).
3. Dual context: an **"All VMs"** entry in the left inventory bar gives fleet-wide context;
   selecting a VM focuses the copilot on that machine.
4. **Persistent history**: the copilot remembers what it did across restarts, per scope.
5. The UI stays **fast and responsive**: streamed output, no blocking round-trips, cheap
   re-renders.

## Core Decision

Replace `server/copilotAgent.ts` (custom Moonshot tool loop) with:

- **kimi-code CLI running locally in ACP mode** (`kimi acp`) as a long-lived child process
  of the Grove backend. ACP (Agent Client Protocol) is JSON-RPC over stdio with native
  multi-session support, streamed updates, permission requests, and cancellation.
- **Grove backend as the ACP client** and as an **MCP server** that exposes all VM
  operations as tools. kimi never talks to a VM directly; every SSH/SFTP byte still flows
  through `SshSessionManager` and the existing safety boundary in `server/commandProfiles.ts`.

This split keeps the division of trust exactly where it is today:

- kimi-code CLI = reasoning, planning, tool selection, conversational memory.
- Grove backend = transport, credentials, command classification, confirmation,
  audit, and the only path to a VM.

```text
┌─────────────┐   WS /api/events (stream)   ┌──────────────────────────────┐
│  React UI   │◄───────────────────────────►│  Grove backend (Express)     │
│  (copilot   │   HTTP /api/*               │                              │
│  center)    │                             │  ┌────────────────────────┐  │
└─────────────┘                             │  │ CopilotSupervisor      │  │
                                            │  │ (ACP client)           │  │
                       stdio JSON-RPC (ACP) │  └─────────┬──────────────┘  │
                ┌───────────────────────────┼────────────┘                 │
                ▼                           │                              │
        ┌──────────────┐   HTTP MCP         │  ┌────────────────────────┐  │
        │  kimi acp    │───────────────────►│  │ Grove MCP server       │  │
        │  (local      │  /api/mcp?scope=…  │  │ (scoped VM tools)      │  │
        │  child proc) │                    │  └─────────┬──────────────┘  │
        │  sessions:   │                    │  ┌─────────▼──────────────┐  │
        │  fleet,      │                    │  │ GroveStore +           │  │
        │  vm-a, vm-b… │                    │  │ SshSessionManager      │  │
        └──────────────┘                    │  └─────────┬──────────────┘  │
                                            └────────────┼─────────────────┘
                                                         │ ssh2 exec / sftp / pty
                                                   ┌─────▼─────┐
                                                   │   VMs     │
                                                   └───────────┘
```

## Why ACP mode (and the fallback)

`kimi acp` is the primary integration because it maps one-to-one onto what Grove needs:

| Grove need | ACP feature |
| --- | --- |
| One warm agent, many contexts | multi-session server; `session/new` per scope |
| Streaming UI | `session/update` notifications (message chunks, tool calls, plans) |
| Confirmation proposals | `session/request_permission` — blocks the tool call until the user answers |
| Stop button | `session/cancel` |
| History memory | persistent sessions, resumable by id (`--session`, `session/load`) |
| Scoped tools | `session/new` carries cwd + MCP server list per session |

The blocking permission flow is the single biggest behavioral upgrade: today a proposal is
confirmed *after* the chat ends and the model never sees the result. Under ACP, a mutating
tool call pauses mid-run, the user confirms in the timeline, the command executes, and the
model **sees the output and verifies the fix** in the same turn.

**Fallback driver** (feature flag `GROVE_COPILOT_DRIVER=print`): if ACP proves unstable on
Windows stdio, the same supervisor interface shells out per turn:

```bash
kimi --print --output-format stream-json \
     --session <scope-session-id> \
     --work-dir .grove/copilot/workspaces/<scope> \
     --mcp-config-file .grove/copilot/mcp/<scope>.json \
     --yolo -p "<user message>"
```

Same MCP boundary, same event mapping, but permissions become non-blocking proposals again
and `--yolo` auto-approves kimi's *built-in* tools too — so the print driver additionally
disables kimi's built-in shell/web tools via agent config. ACP stays the default because
the Grove policy engine answers every permission request itself.

## Components

### 1. CopilotSupervisor (`server/copilotSupervisor.ts`, new)

Owns the `kimi acp` child process:

- Spawns it lazily on first copilot use; restarts with backoff on crash; surfaces process
  health as a `copilot.runtime` event (shown in Settings).
- Speaks ACP JSON-RPC over stdio: `initialize`, `session/new`, `session/load`,
  `session/prompt`, `session/cancel`.
- Translates `session/update` notifications into Grove `ServerEvent`s
  (`copilot.delta`, `copilot.toolcall.updated`, `copilot.plan`, `copilot.progress`).
- Answers `session/request_permission` through the policy engine (below), bridging to a
  proposal card in the UI when a human decision is needed.
- Maps Grove scopes to ACP session ids; persists the mapping in
  `.grove/copilot/sessions.yaml` so a backend restart resumes the same kimi sessions.
- Reconciles on startup: turns and permission requests that were in flight when the
  backend died are marked `interrupted` in the journal and their proposals re-rendered as
  re-runnable drafts — nothing is left dangling as "running".

`server/copilotAgent.ts` (custom loop, tool schemas, MAX_TOOL_LOOPS, evidence summarizer)
is deleted. `isAgentReadOnlyCommand` moves next to `classifyCommand` in
`server/commandProfiles.ts`, which remains the security-sensitive boundary.

### 2. Scopes: "All VMs" + per-VM focus

```ts
type CopilotScope = 'fleet' | `vm:${string}`
```

- The sidebar gets a pinned **All VMs** entry above the inventory list. Selecting it sets
  scope `fleet`; selecting a VM sets scope `vm:<id>`. The copilot panel, timeline, history,
  and busy state are all keyed by scope (today they are keyed by vmId only).
- **One kimi session per scope**, created lazily, resumed by stored id. Switching scopes in
  the UI is instant — it just changes which session the next prompt goes to and which
  timeline is rendered; no process churn.
- Each scope gets a **workspace directory** that is the session's `--work-dir` / cwd:

```text
.grove/copilot/
  sessions.yaml                 # scope -> kimi session id
  policy.yaml                   # remembered "always allow" rules
  journal/
    fleet.jsonl                 # operation journal per scope (see History)
    vm-<id>.jsonl
  workspaces/
    fleet/
      AGENTS.md                 # generated: inventory table, fleet health, safety rules
      notes.md                  # agent-maintained durable memory
    vm-<id>/
      AGENTS.md                 # generated: identity, connection, services, metrics, rules
      notes.md
```

- `AGENTS.md` is **generated by Grove** and is how kimi natively picks up project context.
  It contains only **stable** facts: identity, connection metadata, tracked services, the
  safety rules, and how to use the Grove tools. It is regenerated only when inventory
  changes. Volatile runtime state (metrics, health, processes) is deliberately excluded —
  a long-lived session would otherwise carry stale snapshots in context — and is fetched
  live through `get_vm` / `refresh_vm_state` instead. The VM variant embeds a one-line
  fleet summary so a focused session knows its siblings exist; the fleet variant links to
  each VM's notes.
- **Scope enforcement is physical, not prompt-based**: each session's MCP endpoint is
  `http://127.0.0.1:8787/api/mcp?scope=<signed-token>`. In a `vm:<id>` session the tools
  are pinned to that VM (no `vmId` parameter accepted); fleet-only tools
  (`list_vms`, `fleet_run_command`) simply do not exist in a VM session, and vice versa.

### 3. Grove MCP server (`server/mcp/`, new)

A streamable-HTTP MCP endpoint mounted on the existing Express app. Tools delegate to
`GroveStore` and carry MCP annotations (`readOnlyHint`, `destructiveHint`) so the
permission policy is data-driven.

| Tool | Scope | Gate |
| --- | --- | --- |
| `get_vm`, `refresh_vm_state` | both | read-only, auto-allowed |
| `list_vms` | fleet | read-only, auto-allowed |
| `run_command { command, reason, longRunning? }` | vm | classified: read-only → runs now; mutating → permission request |
| `read_logs { unit?, grep?, lines }` | vm | read-only (bounded journalctl/tail wrapper) |
| `service_status { name }` | vm | read-only |
| `sftp_list { path }` | vm | read-only |
| `sftp_transfer { direction, source, target }` | vm | permission request; executes via `createTransfer` (structured, not a shell string — fixes today's caveat) |
| `apprunner_list / deploy / remove / restart` | vm | deploy/remove/restart gated |
| `fleet_run_command { targets, command, reason }` | fleet | permission request; **freezes the target VM list at proposal time** (resolves the open design question); reports per-VM results |
| `record_note { content }` | both | appends to the scope's `notes.md` |
| `get_history { query?, limit? }` | both | searches the scope journal |
| `op_status / op_logs { opId }` | vm | read-only (long-running ops, below) |

Every executed command is still recorded as a `CommandRun` plus an audit `ActivityEvent`,
exactly as today.

**Concurrency.** Scopes run concurrently — a fleet prompt and a vm-focused prompt may both
be active, and the user can act through the UI at the same time. `GroveStore` therefore
gains a per-VM **mutation lock**: mutating work (copilot tool calls from any session,
confirmed proposals, user UI actions, AppRunner deploys) serializes per target VM, while
read-only inspections bypass the lock. UI busy state becomes per-scope
(`copilotBusyByScope` replaces `copilotBusyByVm`), and a tool call waiting on the lock
reports "queued behind <operation>" as progress instead of silently hanging.

**Closing the local-API side door.** Scope tokens only bind the MCP path. kimi's built-in
local shell could otherwise simply `curl http://127.0.0.1:8787/api/vms/<other-vm>/commands`
— today's Grove API is an unauthenticated loopback service, an assumption that stops
holding the moment an agent runs on the same machine. Fix: mutating Grove HTTP routes
require a **per-boot bearer token** that is handed to the React UI at page load and never
appears in any agent context, workspace file, or MCP config. MCP scope tokens are random
per scope per boot. The agent's only path to a VM is then its own scoped MCP endpoint,
regardless of what its local tools do.

### 4. Permission flow (proposals, unified)

`ActionProposal` becomes the UI face of an ACP permission request:

1. kimi calls `run_command` with a mutating command → Grove MCP classifies it, creates a
   proposal with status `awaiting_confirmation`, and the supervisor surfaces it as the
   pending answer to `session/request_permission`.
2. The timeline shows a confirmation card with **Allow once / Always allow / Deny** (and
   the exact command, risk classification, and target VM(s)).
3. Allow → the tool call resumes, executes over SSH, and the model receives the output to
   verify. Deny → the model receives a structured denial and adapts. Timeout (10 min) →
   deny with "user did not respond"; the card stays re-runnable as a draft.
4. "Always allow" appends a narrow rule (`scope + command prefix`) to
   `.grove/copilot/policy.yaml`; the policy engine auto-answers matching future requests.
   Policy rules are visible and revocable in Settings.
5. Pending permission requests surface **globally**, not only in the requesting scope's
   timeline: the sidebar entry for that scope gets an attention badge and the UI raises a
   toast. A blocking request from the fleet session must not stall silently for 10 minutes
   because the user happens to be focused on one VM. Completed long-running operations use
   the same attention surface.

kimi's built-in tools (local file edits, local shell) hit the same permission path. Default
policy: auto-allow reads/writes inside the scope workspace, require confirmation for
anything else on the local machine. The copilot still never types into the user's live
terminal — that invariant is unchanged.

### 5. History memory

Three layers, cheapest first:

1. **kimi native sessions** — full conversational memory per scope, resumed by id across
   backend restarts. Free.
2. **Operation journal** (`server/copilotJournal.ts`, new) — append-only JSONL per scope:
   messages, tool calls, command runs, proposals and their outcomes. This is the source of
   truth for the UI timeline (hydrated on restart — today chat history evaporates when the
   backend restarts), for the Activity tab, and for the `get_history` tool so the model can
   answer "what did we change on this box last week?".
3. **Distilled notes** (`notes.md` per scope) — the system prompt instructs the agent to
   `record_note` durable facts after significant operations ("nginx config lives in
   /etc/nginx/sites-enabled/grove.conf", "this VM runs shadowsocks on 8388"). Notes live in
   the workspace, so kimi reads them natively on session start.

Sessions are working memory, not the archive. A scope's kimi session is **rotated** —
fresh session, same scope — when it grows past a context budget or when the user clicks
"New conversation": the replacement is seeded by `AGENTS.md` + `notes.md` + a short digest
of recent journal entries. Relying on one eternally-resumed session would slowly trade
answer quality for context pressure; with the journal and notes as continuity, rotation
costs nothing.

### 6. UI changes

Layout stays `Sidebar | CopilotPanel (center) | workspace panel`, with these changes:

- **Sidebar**: pinned "All VMs" entry (fleet health roll-up: n running / n warning) above
  the inventory; each VM row gets a status dot and a small spinner when the copilot is
  actively operating on it (visible even when you're focused elsewhere).
- **CopilotPanel** becomes scope-aware and gets new timeline item types:
  - streaming assistant text (token deltas);
  - collapsible **tool-call cards**: live status, the exact command, truncated output,
    "open in Terminal/Files" deep links into the workspace panel;
  - **permission cards** (Allow once / Always allow / Deny);
  - **plan card** when kimi emits a plan (ACP plan updates) — checklist that ticks off as
    steps complete;
  - a **Stop** button (`session/cancel`) — fixes the "no cancellation path" gap.
- **Terminal → copilot bridge** (user-initiated): select text in the terminal — or grab
  the last N lines of scrollback — and click "Ask copilot" to attach it to the scope
  prompt. Strictly read-only and strictly user-triggered, so the never-type-into-the-
  terminal invariant is untouched; it puts the copilot inside the debugging loop where the
  user actually lives.
- **Performance budget** (requirement 5):
  - deltas arrive over the existing `WS /api/events` as `copilot.delta` and are batched
    client-side with a `requestAnimationFrame` flush, so token streams cost one render per
    frame, not per token;
  - the timeline is **virtualized** (render only visible items) since journals are now
    long-lived;
  - markdown rendering is memoized per completed message; the streaming message renders as
    plain text until finalized;
  - scope switches render from already-hydrated journal state — no fetch on click;
  - no snapshot refetches; everything stays event-driven as today.

### 7. On-VM footprint (requirement 2)

No resident agent on any VM. All operations remain SSH exec / SFTP channels from the local
backend. The one concession: `run_command` with `longRunning: true` wraps the command in a
transient unit on the VM —

```bash
systemd-run --unit grove-op-<id> --collect <command>   # nohup fallback if no systemd
```

— so an `apt upgrade` or a build survives an SSH disconnect. `op_status` / `op_logs` poll
it over fresh exec channels. The unit is garbage-collected on completion. A persistent
slave daemon (for streaming log-follow, file watching) is an explicit non-goal until a
concrete need appears.

### 8. Provider & runtime configuration

- Settings → "Copilot runtime" panel: detected `kimi` binary + version, login state
  (`kimi login` is run by the user once, outside Grove), ACP process health, session store
  location, model selection (passed through to kimi config), policy rule list.
- `GROVE_MOONSHOT_*` env plumbing is kept only as a kimi provider passthrough; Grove no
  longer calls the Moonshot API itself.
- If `kimi` is not installed or not logged in, the copilot panel shows a setup card with
  the install/login commands instead of inventing a local answer mode (same spirit as the
  current missing-API-key rule).

## Testing and offline mode

Grove's existing pattern — `MockSshSessionManager` plus `apiDisabled()` fixtures — extends
to the copilot. The supervisor is defined as a small driver interface (`prompt`, `cancel`,
`onUpdate`, `answerPermission`) with three implementations: **ACP** (default),
**print-mode** (fallback flag), and a **mock driver** that replays scripted update
sequences. Vitest and offline UI development run against the mock — CI machines have no
`kimi` binary or login, and the suite must not depend on one. Streaming, permission cards,
scope switching, and journal hydration are all testable through scripted mock sequences.

## Contract changes (update together, per SPEC.md rules)

- `src/types.ts`: add `CopilotScope`; `CopilotMessage.scope` (replaces `contextVmId`);
  `ActionProposal.scope`, `targetVmIds: string[]`, status `awaiting_confirmation`,
  decision `allow_once | always_allow | deny`; new events `copilot.delta`,
  `copilot.toolcall.updated`, `copilot.plan`, `copilot.permission.requested`,
  `copilot.runtime`.
- `server/app.ts`: `POST /api/copilot/messages` takes `{ scope, message }`;
  `POST /api/copilot/proposals/:id/decision` replaces `/confirm`;
  `POST /api/copilot/cancel { scope }`; MCP mount at `/api/mcp`.
- `src/lib/api.ts`, `server/store.ts`, tests: follow.

## Phasing

1. **Phase 1 — swap the brain.** CopilotSupervisor + ACP client + Grove MCP server with
   parity tools (`run_command`, `sftp_list`, proposals), per-VM scope only. Streaming
   deltas, tool-call cards, Stop. Delete `copilotAgent.ts`. Print-mode fallback flag.
   Foundations land here, not later: per-VM mutation lock, API bearer token, mock driver.
2. **Phase 2 — dual context + memory.** "All VMs" sidebar entry, fleet session, scope
   workspaces + generated `AGENTS.md`, journal persistence + timeline hydration, blocking
   permission flow with Allow/Always/Deny, session rotation, global attention badges.
3. **Phase 3 — depth.** Structured `sftp_transfer` execution, `fleet_run_command` with
   frozen targets, long-running ops via `systemd-run`, `record_note`/`get_history`,
   policy management UI, terminal → copilot bridge, timeline virtualization polish.

## Risks

- **ACP maturity on Windows stdio** — mitigated by the print-mode fallback behind the same
  supervisor interface.
- **kimi built-in tools escaping the sandbox** — mitigated by the policy engine answering
  every permission request, workspace-scoped auto-allow, the per-boot API bearer token
  closing the loopback side door, and disabling built-in shell/web tools in the print
  driver where confirmation can't block.
- **CLI startup latency** — mitigated by the warm long-lived ACP process and lazy session
  creation; the fallback driver pays startup per turn, which is another reason ACP is
  primary.
- **Prompt bloat in fleet scope** — generated `AGENTS.md` stays summary-level; detail is
  pulled through tools on demand.
