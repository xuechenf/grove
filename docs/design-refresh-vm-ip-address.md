# Design: Refresh VM IP Address

Status: design proposal (no code changes yet)
Date: 2025 (task tsk_6UaUSQK6qaljsoEbXHnY)

## 1. Problem statement

A managed VM's IP address can change out from under Grove: cloud VMs without an
elastic/static IP get a new public IP on stop/start, and DHCP-assigned lab machines
can move. Today the VM's address is frozen in two places:

- `VmConfig.host` in `inventory.yaml` (source of truth for the SSH connection), and
- `VM.ipAddress` / `VM.connection.host` derived from it via `vmFromConfig()`
  (`server/inventory.ts`).

The only way to fix a stale address is to hand-edit the connection profile
(`PATCH /api/vms/:vmId` → `store.updateVm`). Grove already knows the *current* IP
in many cases: `CloudControlService.listMachines()` returns `ProviderMachine`
records with `publicIp` / `privateIp` for every credential profile, and
`store.getVmOverview()` already matches a VM to its cloud machine by IP
(`server/store.ts` ~1144). We should turn that match into a one-click (and
copilot-callable) "Refresh IP address" feature.

## 2. Goals / non-goals

**In scope**

- A `POST /api/vms/:vmId/refresh-ip` endpoint that re-resolves the VM's current
  public IP and updates the stored connection profile atomically.
- Matching order: (a) explicit cloud-machine link if configured, (b) cloud
  inventory match by instance name, (c) legacy match by current/old IP.
- UI: "Refresh IP" action on the VM detail page showing old → new IP and failure
  reasons; disabled with an explanation when the VM can't be resolved to a cloud
  machine.
- An MCP tool so the copilot can refresh an IP when SSH starts failing.
- Activity-log entry recording old IP, new IP, and resolution source.
- Correct handling of the SSH session cache (drop cached connections on host
  change — `updateVm` already does this via `ssh.closeVmConnection`).

**Out of scope**

- Automatic background IP watching/polling or push-based updates.
- Updating application DNS records that point at the old IP (noted as follow-up;
  `applicationDomainManager` reconcile already exists).
- Private-IP-only refreshes for VPC-internal VMs (first cut refreshes `publicIp`;
  fallback to `privateIp` only when no public IP exists).
- Provider-specific "allocate elastic IP" flows.

## 3. Current-state trace

- `store.updateVm(vmId, VmConnectionInput)` (`server/store.ts:1327`) is the
  single, tested write path for changing a VM's host: it validates, enforces
  endpoint uniqueness (`assertUniqueEndpoint`), closes the cached SSH session on
  host/port/user/key change, persists `inventory.yaml` atomically via
  `saveInventory`, and logs an activity event. **The refresh feature must reuse
  this path rather than mutating configs directly.**
- `CloudControlService.listMachines(profileId?)` (`server/cloudProvider.ts`)
  aggregates `ProviderMachine` records across credential profiles and adapters
  (AWS, Azure, Alibaba), each carrying `nativeId`, `name`, `state`, `publicIp`,
  `privateIp`.
- `getVmOverview` already implements an IP-set match between a VM and cloud
  machines; that matching logic is the natural seed for the resolver but needs
  to be hardened (see §5) because IP-based matching breaks precisely when the IP
  has *changed* — which is exactly when the user needs this feature.
- `CloudMachine` ids are stable hashes (`createHash` in `cloudProvider.ts`), so a
  stored link survives restarts.

## 4. Proposed design

### 4.1 Data model

Add an optional link on the VM config so resolution doesn't depend on matching
the (possibly stale) IP:

```ts
// src/types.ts — VmConfig
cloudLink?: {
  profileId: string     // credential profile that owns the machine
  machineNativeId: string // provider instance id (stable across IP changes)
}
```

- Persisted in `inventory.yaml` via the existing `vmConfigSchema`
  (`server/inventory.ts`) — add an optional strict object; old files without it
  still parse (backward compatible, no migration needed).
- Populated lazily: the first successful refresh (by any match strategy) writes
  the link, so subsequent refreshes are deterministic.

### 4.2 Resolution strategy (server, `store.refreshVmIp(vmId)`)

1. Load VM + config; require it exists.
2. Call `listCloudMachines()` once; collect `warnings`.
3. Resolve the cloud machine:
   1. If `config.cloudLink` → find machine with that `nativeId` under that
      profile. If not found → **fail with `cloud_link_stale`** (do not silently
      re-match by name/IP; surface that the machine may be terminated).
   2. Else match by name (case-insensitive, exact) across machines whose
      profile provider equals `vm.provider.name` when set; require exactly one
      candidate.
   3. Else legacy match: current `vm.ipAddress` / `connection.host` ∈
      {`publicIp`, `privateIp`} — same rule as `getVmOverview`.
   4. Zero or multiple candidates → fail with `no_match` / `ambiguous_match`
      plus enough context (candidate names) for the UI to render guidance.
4. Pick the new IP: `publicIp ?? privateIp`; if neither → fail `no_ip`
   (e.g., machine stopped and IP released).
5. If new IP equals current host → return `unchanged` (idempotent; no write, no
   activity spam).
6. Otherwise call `this.updateVm(vmId, { ...currentConnection, ipAddress: newIp })`
   so all existing invariants (uniqueness, session-cache invalidation,
   persistence, activity log) apply. Persist `cloudLink` in the same config
   write.
7. Return `{ vm, previousIp, newIp, source: 'link' | 'name' | 'ip', warnings }`.

**State / failure table**

| Condition | Result |
|---|---|
| VM unknown | 404 (existing `requireVm`) |
| Cloud discovery failed (credentials, network) | 502 with adapter warnings; VM untouched |
| No / ambiguous cloud machine | 409 `no_match` / `ambiguous_match`; VM untouched |
| Linked machine gone | 409 `cloud_link_stale`; VM untouched |
| Machine has no IP (stopped) | 409 `no_ip`; VM untouched |
| IP unchanged | 200 `unchanged: true` |
| Success | 200, updated `VM`, activity event |

Unknown remote state is never guessed: any resolution doubt is an explicit
failure, never a silent write.

### 4.3 API

```
POST /api/vms/:vmId/refresh-ip
→ 200 { vm, previousIp, newIp, unchanged, source, warnings }
→ 409 { error: { code, message, candidates? } }
→ 502 { error: { code: 'cloud_unavailable', warnings } }
```

- Registered in `server/app.ts` next to the other `/api/vms/:vmId/*` routes,
  behind the existing API-token auth and `mutationLock` (it mutates inventory,
  like `updateVm`).
- Request body: none for v1 (optional `{ prefer: 'public' | 'private' }` later).

### 4.4 Frontend

- VM detail header, next to the connection info: "Refresh IP" button with a
  spinner state. On success show a transient confirmation `1.2.3.4 → 5.6.7.8`
  and the store's updated VM replaces local state (same pattern as the existing
  `updateVm` form save).
- On 409 show the error code's message; on `ambiguous_match` list candidate
  machine names so the user can rename or link manually.
- The IP shown elsewhere (`vm.ipAddress`, overview, terminal banner) updates for
  free because everything derives from the single stored VM.

### 4.5 MCP / copilot

Add one scoped tool in `server/mcp/tools.ts`:

```
refresh_vm_ip { vmId } → { previousIp, newIp, unchanged } | structured error
```

Policy: this is a *mutating* tool — gate it like the existing
firewall/power tools in `copilotPolicy` (require the cloud/VM mutation scope),
and journal it in the copilot journal with old/new IP.

### 4.6 Concurrency & idempotency

- Refresh is idempotent (re-running with no change is a no-op) and safe under
  the existing mutation lock; concurrent refresh + `updateVm` serializes the
  same way other inventory writes do.
- `listCloudMachines` is read-only and may be slow (multi-provider fan-out);
  the endpoint should have a reasonable timeout and surface per-profile
  warnings instead of failing wholesale when one provider errors.

## 5. Key tradeoffs

- **Name matching is heuristic.** Matching by VM name when no link exists can
  hit duplicates. Mitigated by requiring a unique candidate and failing
  loudly with `ambiguous_match` rather than guessing. Once a refresh succeeds,
  the persisted `cloudLink` removes the heuristic from then on.
- **Reuse `updateVm` vs. a dedicated write path.** Reusing `updateVm` keeps one
  write path (uniqueness checks, session invalidation, persistence, activity).
  The cost is a slightly awkward "build a VmConnectionInput from the existing
  config" step — accepted, it keeps invariants in one place.
- Alternative considered: a periodic background poller that auto-heals IPs.
  Rejected for v1 — silent host changes are a security-sensitive event (SSH
  host-key/fingerprint implications); the user (or copilot) should trigger the
  change explicitly and see it in the activity log.

## 6. Security notes

- A refreshed IP changes where Grove opens SSH sessions. After refresh,
  `connection.testStatus` resets to `idle` and the fingerprint from the old host
  must not be carried over as "trusted" — `updateVm` already rebuilds the
  connection from `vmFromConfig` and only preserves `lastConnected`/test fields
  deliberately; keep the fingerprint reset behavior and verify it in tests.
- No secrets are involved: cloud calls use the existing credential vault; the
  endpoint returns IPs only.
- Rate-limit nothing new; reuse API token auth. Log old→new IP in the activity
  feed for auditability.

## 7. Testing plan

- `server` unit tests (vitest, alongside `store`/`cloudApi` tests):
  - refresh with linked machine → host updated, inventory persisted, SSH cache
    close invoked, activity event written.
  - match-by-name success; duplicate names → `ambiguous_match`.
  - stale link → `cloud_link_stale`, inventory untouched.
  - machine without public IP → `no_ip`; unchanged IP → no write.
  - provider failure → 502 with warnings.
  - fingerprint/testStatus reset after refresh.
- API test through `app.ts` for route wiring, auth, and error-shape mapping.
- MCP tool test mirroring the existing cloud tool tests (`cloudMcp.test.ts`).
- Frontend: component test for the button states (loading/success/409).

## 8. Rollout / rollback

Purely additive: new optional schema field, one endpoint, one MCP tool, one UI
button. Rollback = revert; existing inventories without `cloudLink` are
unaffected.
