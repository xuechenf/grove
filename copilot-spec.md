# Grove Copilot Spec

Last updated: 2026-06-11

This file is the living working spec for Grove Copilot. Keep it updated whenever we change copilot behavior, VM state tracking, operation execution, or SSH/SFTP connection handling.

## Current Role

Grove Copilot is intended to be the main actor for VM operations, but the current implementation keeps it inside strict local backend boundaries:

- The React UI gathers the selected VM, active tab, chat text, proposals, and progress UI.
- The local Node backend owns all real SSH, SFTP, terminal, inventory, activity, and provider work.
- Moonshot/Kimi is used only through the backend agent in `server/copilotAgent.ts`.
- Copilot can directly run read-only inspections on the selected VM.
- Copilot cannot directly mutate a VM from free-form chat. Mutating work must become an `ActionProposal`, and only a confirmed proposal runs SSH commands.
- Copilot never types into the user's live terminal. Interactive terminal sessions and copilot command runs use separate SSH channels.

## Source Map

- Shared contracts: `src/types.ts`
  - `VM`, `VMMetrics`, `ServiceInfo`, `ProcessInfo`, `ActivityEvent`
  - `TransferJob`, `CommandRun`, `TerminalSession`
  - `CopilotMessage`, `CopilotProviderStatus`, `CopilotProgressEvent`
  - `ActionProposal`, `AppSnapshot`, `ServerEvent`
- Backend routes: `server/app.ts`
  - HTTP validation and route-to-store delegation.
- Backend runtime state: `server/store.ts`
  - `GroveStore` owns VM arrays, transfer jobs, copilot messages, proposals, event publication, and activity entries.
- Copilot agent: `server/copilotAgent.ts`
  - Builds Kimi prompts, exposes tool schemas, loops through tool calls, classifies read-only SSH commands, and formats tool results.
- Command safety: `server/commandProfiles.ts`
  - `classifyCommand` and mutating command patterns.
- SSH/SFTP/terminal transport: `server/sshSessionManager.ts`
  - `SshSessionManager`, `MockSshSessionManager`, and `RealSshSessionManager`.
- WebSocket bridge: `server/index.ts`
  - `WS /api/events` and `WS /api/vms/:vmId/terminal`.
- Frontend API client: `src/lib/api.ts`
  - Copilot routes, snapshot loading, event socket, terminal socket.
- Frontend state shell: `src/App.tsx`
  - Snapshot hydration, event handling, copilot busy/progress state, proposal creation/confirmation.
- Copilot UI: `src/components/CopilotPanel.tsx`
  - Chat timeline, current execution progress, suggestions, proposal cards, confirmation button.
- Terminal UI: `src/components/TerminalTab.tsx`
  - Interactive PTY sessions; explicitly displays that copilot uses separate SSH exec/SFTP channels.

## VM And Fleet State

The core state shape is `AppSnapshot`:

```ts
{
  vms: VM[]
  transfers: TransferJob[]
  messages: CopilotMessage[]
  proposals: ActionProposal[]
}
```

`GroveStore` keeps this state in memory. VM connection definitions are loaded from `.grove/inventory.yaml` through `server/inventory.ts`, unless fixtures are enabled or the inventory is missing. AppRunner service metadata is loaded separately from `.grove/apprunner.yaml`.

Each VM object combines three kinds of state:

- Inventory identity and connection metadata: id, name, host, user, port, key label, OS, labels, provider.
- Runtime sample state: lifecycle, health, metrics, services, processes, alerts, last connected, SSH test status.
- Operation history: VM-local `activity`, plus globally visible `TransferJob`, `CopilotMessage`, `CopilotProgressEvent`, and `ActionProposal` events.

`GroveStore.refreshAllVmInfoOnce()` refreshes every VM on first snapshot/list request, unless fixtures are enabled. It uses `Promise.allSettled`, so a failed VM refresh does not block the rest of the fleet.

`GroveStore.refreshVmInfo(vmId)` runs a generated read-only shell command over SSH. The command emits marked sections for metrics, processes, and services. The store parses stdout into `VMMetrics`, `ProcessInfo[]`, and `ServiceInfo[]`, then replaces that VM in the `vms` array and publishes `vm.updated`.

Fleet operations currently do not have a separate persistent operation object. They are represented by:

- one proposal, usually `actionType: "patch_vms"`;
- one `CommandRun` per target VM at confirmation time;
- one activity entry per target VM;
- a proposal result string summarizing per-VM outcomes.

Important current behavior: a fleet patch proposal computes its title/description from running VMs when the proposal is created, but confirmation recalculates `runningVms(this.vms)` from live store state. Future work should decide whether fleet proposals should freeze their target set or intentionally stay live.

## Copilot Chat Flow

1. The frontend calls `POST /api/copilot/messages` via `sendCopilotMessage({ vmId, activeTab, message })`.
2. `server/app.ts` validates `vmId`, `activeTab`, and `message`, then calls `GroveStore.sendCopilotMessage`.
3. The store creates and publishes a user `CopilotMessage`.
4. The store publishes a `copilot.progress` event: `Queued copilot request`.
5. The store builds a per-request `CopilotToolRuntime` and calls `copilot.respond(...)`.
6. `CopilotAgent` builds Kimi messages with:
   - system instructions;
   - selected VM summary;
   - fleet summary;
   - selected VM transfer summary;
   - recent VM-scoped chat history;
   - current user message.
7. Kimi may answer directly or call tools.
8. Tool calls are executed by the store-provided runtime.
9. The store records read-only `CommandRun`s as `Copilot SSH inspection` activity entries.
10. The store persists any generated proposals in memory and publishes `copilot.proposal.updated`.
11. The store creates and publishes the assistant `CopilotMessage`.
12. The store publishes final `copilot.progress`: `Copilot response ready`.

The agent has a fixed tool-loop budget (`MAX_TOOL_LOOPS = 5`). If Kimi repeatedly asks for tools, the agent asks for a final no-tool response. If that fails, it locally summarizes recent tool evidence.

## Copilot Tools

The current tool schema in `server/copilotAgent.ts` exposes:

- `inspect_system`
  - Built-in diagnostics only.
  - Current checks: `shadowsocks_running`, `shadowsocks_installed`.
  - Runs predefined read-only shell scripts through SSH exec.
- `ssh_exec`
  - Read-only SSH exec on the selected VM.
  - Rejected unless `isAgentReadOnlyCommand(command)` approves it.
- `sftp_list`
  - Lists remote files over SFTP on the selected VM.
- `create_known_proposal`
  - Creates one built-in proposal type.
  - Current types: `inspect_logs`, `restart_service`, `snapshot`, `transfer_file`, `explain_metrics`, `patch_vms`.
- `propose_ssh_command`
  - Creates a `custom_command` proposal. It does not execute immediately.
- `plan_sftp_transfer`
  - Creates a `transfer_file` proposal. It does not execute the transfer.

Tool results are compacted before returning to Kimi. Command stdout and stderr are truncated in `toolResultFromCommandRun` to keep prompts bounded.

## Operation And Proposal Flow

There are two proposal creation paths:

- User clicks a suggestion in `CopilotPanel`.
  - Frontend calls `POST /api/copilot/proposals`.
  - Store calls `proposalFor(...)`.
- Kimi asks for a proposal tool during chat.
  - Store runtime appends the proposal to a per-request `proposals` array.
  - After the response, proposals are prepended to store state and published.

Confirmation path:

1. User clicks `Confirm action` in `CopilotPanel`.
2. Frontend calls `POST /api/copilot/proposals/:proposalId/confirm`.
3. Store finds the proposal by id.
4. For `patch_vms`, store loops over live running VMs and runs the proposal command once per VM with `actor: "copilot"` and `mutating: true`.
5. For all other proposal types, store runs the proposal command on `proposal.vmId` with `actor: "copilot"` and mutating status from `classifyCommand`.
6. Store updates proposal status to `executed` on command success, or `dismissed` on command failure/no fleet targets.
7. Store adds activity entries with `proposalId` and `commandRunId`.
8. Store publishes `copilot.proposal.updated` and `activity.created`.

Current caveat: `transfer_file` proposals confirm by running the displayed `sftp ...` command through SSH exec. They do not yet execute the structured transfer plan via `createTransfer`.

## SSH, SFTP, And Terminal Connections

All VM connectivity goes through `SshSessionManager`.

`RealSshSessionManager` uses `ssh2` and caches one SSH client promise per VM id:

```ts
private readonly clients = new Map<string, Promise<Client>>()
```

The cached client is shared by operation type, but each operation opens its own channel:

- Metrics, AppRunner, user commands, and copilot inspections use `client.exec(command)`.
- Remote file listing and transfers use `client.sftp(...)`.
- Interactive terminal sessions use `client.shell(...)`.

Connection details come from `VM.connection`:

- `host`
- `port`
- `user`
- `keyLabel`

`keyLabel` is resolved through `resolveProjectStateReference`:

- `~/...` resolves under the OS home directory.
- absolute paths stay absolute.
- relative paths resolve under `.grove/`.

If the key exists, it is read and passed as `privateKey`. If no private key is available, the current code does not explicitly enable agent forwarding; it relies on ssh2 defaults and the provided config.

`executeCommand` retries once on channel-open style failures:

- "channel open failure"
- "open failed"
- "session open refused"

For those failures it evicts and ends the cached client, then runs once more on a fresh connection.

Late SSH client errors remove the cached client. The next operation creates a new SSH connection.

## Terminal Separation

The terminal WebSocket path is:

```text
WS /api/vms/:vmId/terminal
```

`server/index.ts` opens `GroveStore.openTerminalShell`, returns a `TerminalSession`, and bridges browser messages to an SSH PTY stream.

Copilot does not write to that stream. Copilot uses:

- `executeCommand` for SSH exec;
- `listFiles` for SFTP listing;
- proposal confirmation for mutating commands.

This is a central invariant. Future copilot features may offer "insert into terminal" as an explicit user action, but automatic typing into a live terminal should remain out of bounds.

## Safety Boundaries

Current read-only enforcement is layered:

- `server/commandProfiles.ts` marks obvious mutating patterns.
- `isAgentReadOnlyCommand` rejects commands classified as mutating.
- `isAgentReadOnlyCommand` also requires an approved prefix, such as `df`, `free`, `journalctl`, `ls`, `ps`, `ss`, `systemctl status`, `uptime`, and similar inspection commands.
- Built-in Shadowsocks diagnostics are allowed by exact command string.

Mutating examples that must become proposals:

- package operations;
- service restart/start/stop/enable/disable;
- file writes, deletes, moves, copies, ownership or mode changes;
- reboot;
- firewall changes;
- process kills;
- shell pipes from curl/wget into sh/bash.

Provider safety:

- Free-form copilot chat requires a configured Moonshot API key.
- Settings writes `GROVE_MOONSHOT_API_KEY`, `GROVE_MOONSHOT_BASE_URL`, and `GROVE_MOONSHOT_MODEL` to `.grove/.env.local`.
- The system prompt tells Copilot not to reveal API keys, private key contents, or hidden environment values.
- Inventory validation rejects private key material and passwords.

## Frontend State Handling

`src/App.tsx` hydrates from `GET /api/snapshot` and subscribes to `WS /api/events`.

Relevant event handling:

- `snapshot` replaces VMs, transfers, messages, and proposals.
- `vm.updated` upserts a VM.
- `vm.deleted` removes a VM and selects another available VM.
- `transfer.updated` upserts a transfer.
- `copilot.message` appends/replaces a chat message.
- `copilot.progress` updates per-VM progress and busy state.
- `copilot.proposal.updated` upserts a proposal.

`CopilotPanel` filters messages and proposals to the selected VM:

- messages are shown if `contextVmId` is absent or matches the selected VM;
- proposals are filtered by `proposal.vmId`;
- progress passed to the panel is filtered by `event.vmId`.

Current busy state is tracked by VM id in `copilotBusyByVm`. A running progress event sets that VM busy; a completed or failed progress event clears it.

## Current Gaps And Design Questions

- Fleet target set: should a `patch_vms` proposal freeze its target VM ids when created?
- Structured operation tracking: multi-step or multi-VM operations currently live across proposals, command runs, progress events, and activity entries. A first-class `Operation` model would make Copilot easier to reason about as the main actor.
- Structured SFTP proposals: `plan_sftp_transfer` creates a textual proposal, but confirmation does not call the transfer API.
- Provider portability: Copilot is currently Moonshot-specific in types and route names.
- SSH agent behavior: inventory supports `useAgent`, but `RealSshSessionManager.createClient` does not explicitly configure an agent socket.
- Read-only command policy: prefix allowlists are simple and should be treated as security-sensitive.
- VM connection status: `VmRuntimeState.connectionStatus` exists in types but is not wired as the primary runtime state model.
- Operation cancellation: command runs and copilot requests have no cancellation path yet.
- Concurrency visibility: the SSH client is shared per VM, but channel concurrency is not surfaced in UI or operation state.

## Maintenance Rules For This File

Update this file when:

- adding or changing copilot tools;
- changing proposal types or confirmation behavior;
- changing SSH/SFTP/session management;
- introducing operation state, cancellation, or multi-VM orchestration;
- changing event payloads or route contracts;
- changing safety classification or read-only policy;
- changing frontend copilot progress/proposal/message behavior.

When implementation and this file disagree, treat implementation as the current truth, then update this file in the same change.
