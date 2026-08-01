# Design: Rotate VM Public IP Address

Status: design proposal (no code changes yet)
Date: 2025 (task tsk_FOD5AxemfyYNeKyDlaXm)

## 1. Problem statement

Sometimes the operator *wants* a fresh public IP deliberately — e.g., the current one is blocklisted or targeted. Grove cannot do this today: the operator must use the cloud console to disassociate and release the old public IP, allocate a new one, associate it with the VM, and then fix Grove's stored connection by hand.

This feature adds a **"Rotate IP"** button that performs the whole rotation in one action against the cloud provider: **remove** the current public IP from the VM (disassociate it from the instance's network interface), **delete** (release) that public IP so it returns to the provider's pool, **create** a new public IP from the provider's dynamic pool, and **attach** it to the VM — then update Grove's stored connection profile.

## 2. Goals / non-goals

**In scope**

- A `POST /api/vms/:vmId/rotate-ip` endpoint that executes the full
  remove → delete → create → attach sequence via the cloud adapter, then
  updates the stored connection atomically.
- UI: "Rotate IP" button on the VM detail page with a confirmation dialog
  (the old IP is released permanently and active SSH sessions drop), a
  progress state, and an old → new IP result.
- An MCP tool so the copilot can rotate an IP when asked, gated like other
  destructive mutating tools.
- Activity-log entry recording old IP, new IP, and provider.
- Correct handling of the SSH session cache (drop cached connections on host
  change — `updateVm` already does this via `ssh.closeVmConnection`).

**Out of scope**

- Rotating *private* IPs or VPC-internal addressing.
- Static/elastic IP inventory management: v1 allocates from the provider's
  standard dynamic public-IP pool.
- Updating application DNS records that point at the old IP (noted as
  follow-up; `applicationDomainManager` reconcile already exists).
- Automatic or scheduled rotation.

## 3. Current-state trace

- `store.updateVm(vmId, VmConnectionInput)` (`server/store.ts:1327`) is the
  single, tested write path for changing a VM's host: it validates, enforces
  endpoint uniqueness (`assertUniqueEndpoint`), closes the cached SSH session on
  host/port/user/key change, persists `inventory.yaml` atomically via
  `saveInventory`, and logs an activity event. **The rotation feature must reuse
  this path for the final host update rather than mutating configs directly.**
- `CloudControlService` (`server/cloudProvider.ts`) aggregates provider
  adapters (AWS, Azure, Alibaba) behind credential profiles and exposes
  `ProviderMachine` records (`nativeId`, `name`, `state`, `publicIp`,
  `privateIp`) via `listMachines()`. Adapters already implement mutating power
  operations (start/stop/reboot); per-provider public-IP lifecycle operations
  follow the same pattern.
- `getVmOverview` matches a VM to its cloud machine by IP
  (`server/store.ts` ~1144); that match identifies the target machine for
  rotation. Matching must be hardened because the stored IP is exactly the
  thing being replaced — see §4.2.

## 4. Proposed design

### 4.1 Provider adapter API

Extend the provider adapter interface with public-IP lifecycle operations:

```ts
interface ProviderAdapter {
  // ... existing operations ...
  detachPublicIp(profile, machineNativeId, publicIp): Promise<void>
  releasePublicIp(profile, publicIpOrAllocationId): Promise<void>
  allocatePublicIp(profile, machineNativeId): Promise<{ publicIp: string }>
  attachPublicIp(profile, machineNativeId, allocation): Promise<void>
}
```

Per-provider mapping:

- **AWS**: disassociate + release the Elastic IP, allocate a new one, associate
  it. Auto-assigned (non-EIP) dynamic public IPs can only be swapped by
  stop/start — v1 fails with `not_supported` rather than power-cycling the
  user's VM implicitly; Elastic IPs are the supported AWS path.
- **Azure**: disassociate the public IP resource from the NIC, delete the
  public IP resource, create a new dynamic public IP, associate it.
- **Alibaba**: equivalent EIP disassociate / release / allocate / associate
  flow.

Unsupported provider or IP type → explicit `not_supported` error, never a
silent partial operation.

### 4.2 Rotation flow (server, `store.rotateVmPublicIp(vmId)`)

1. Load VM + config; require it exists.
2. Resolve the cloud machine via `listCloudMachines()`: match by current
   `vm.ipAddress` / `connection.host` against `publicIp`/`privateIp` (same
   rule as `getVmOverview`), plus an exact name match as fallback. Zero or
   multiple candidates → fail `no_match` / `ambiguous_match` with candidate
   names for UI guidance.
3. Require the machine's current `publicIp` to equal the stored host; if they
   already diverge, fail `stale_host` and tell the user to fix the connection
   first — never rotate an address Grove isn't using.
4. Execute the rotation via the adapter, in order:
   1. `detachPublicIp(oldIp)` — remove the IP from the VM.
   2. `releasePublicIp(oldIp)` — delete it back to the provider pool.
   3. `allocatePublicIp()` → `newIp` — create a new public IP.
   4. `attachPublicIp(newIp)` — attach it to the VM.
5. Only after the provider confirms the new IP is attached, call
   `this.updateVm(vmId, { ...currentConnection, ipAddress: newIp })` so all
   existing invariants (uniqueness, session-cache invalidation, persistence,
   activity log) apply in one write.
6. Return `{ vm, previousIp, newIp, warnings }`.

**Mid-sequence failure handling.** The risky window is a failure after detach
but before attach, leaving the VM with no public IP:

- On any step failure the service attempts best-effort recovery (re-attach the
  old IP if it wasn't released yet, or attach the newly allocated one).
- The error always states which step failed and the VM's current known IP
  state, so the UI can render actionable guidance.
- `inventory.yaml` is only written after the provider confirms the new IP is
  attached; a failed rotation never changes Grove's config.

**State / failure table**

| Condition | Result |
|---|---|
| VM unknown | 404 (existing `requireVm`) |
| Cloud discovery failed (credentials, network) | 502 with adapter warnings; VM untouched |
| No / ambiguous cloud machine | 409 `no_match` / `ambiguous_match`; VM untouched |
| Stored host ≠ machine publicIp | 409 `stale_host`; VM untouched |
| Provider/IP type unsupported (e.g. AWS auto-assigned) | 409 `not_supported`; VM untouched |
| Rotation failed mid-sequence | 502 `rotate_failed` with `failedStep` and recovery outcome; config untouched unless the new IP is confirmed attached |
| Success | 200, updated `VM`, activity event with old → new IP |

### 4.3 API

```
POST /api/vms/:vmId/rotate-ip
→ 200 { vm, previousIp, newIp, warnings }
→ 409 { error: { code, message, candidates? } }
→ 502 { error: { code: 'rotate_failed' | 'cloud_unavailable', failedStep?, message, warnings } }
```

- Registered in `server/app.ts` next to the other `/api/vms/:vmId/*` routes,
  behind the existing API-token auth and `mutationLock` (it mutates both
  cloud state and inventory).
- No request body for v1.

### 4.4 Frontend

- VM detail header: "Rotate IP" button opening a **confirmation dialog** that
  warns: the current public IP will be released permanently, active SSH
  sessions will drop, and DNS pointing at the old IP must be updated manually.
  Confirm → spinner while the multi-step provider call runs.
- On success show a transient confirmation `203.0.113.10 → 203.0.113.77`;
  the store's updated VM replaces local state (same pattern as the existing
  `updateVm` form save), so the IP shown everywhere updates for free.
- On `rotate_failed` show which step failed and the recovery outcome (e.g.
  "old IP re-attached" or "VM currently has no public IP — attach one from
  the cloud console").

### 4.5 MCP / copilot

Add one scoped tool in `server/mcp/tools.ts`:

```
rotate_vm_public_ip { vmId } → { previousIp, newIp } | structured error
```

Policy: this is a *destructive, mutating* tool — gate it in `copilotPolicy`
with the cloud/VM mutation scope (like the existing firewall/power tools),
require explicit user confirmation, and journal it in the copilot journal
with old/new IP.

### 4.6 Concurrency & idempotency

- Rotation is **not** idempotent (each run allocates a fresh IP); it
  serializes under the existing mutation lock with other inventory/cloud
  mutations so concurrent rotate + `updateVm` cannot interleave.
- Provider calls are slow multi-step operations; the endpoint needs a
  generous timeout and must surface per-step failure detail rather than a
  bare 500.

## 5. Key tradeoffs

- **Destructive by design.** Releasing the old IP is permanent; the provider
  pool will not give it back. Mitigated by the confirmation dialog, the
  copilot confirmation gate, and the activity-log audit trail.
- **Four-step sequence vs. provider one-shot swap.** The explicit
  detach/release/allocate/attach sequence works across providers whose APIs
  lack a single swap call. The cost is a mid-sequence failure window —
  mitigated by best-effort recovery and precise error reporting (§4.2).
- **Reuse `updateVm` for the final host write.** Keeps one write path
  (uniqueness checks, SSH session invalidation, persistence, activity log)
  instead of a parallel mutation path.
- **AWS auto-assigned public IPs are out of scope for v1** — the only swap is
  stop/start, and silently power-cycling a user's VM is unacceptable.
  Surface `not_supported` and document Elastic IPs as the supported AWS path.

## 6. Security notes

- The new IP changes where Grove opens SSH sessions. After rotation,
  `connection.testStatus` resets to `idle` and the previous host's SSH
  fingerprint must not be carried over as trusted — `updateVm` already
  rebuilds the connection from `vmFromConfig`; keep the fingerprint reset
  behavior and verify it in tests.
- No new secrets: cloud calls use the existing credential vault; the endpoint
  returns IPs only.
- The old IP is released to a shared pool and may be handed to another
  tenant — the activity entry records old → new for auditability, and nothing
  treats the old IP as "ours" after release.
- Rate-limit nothing new; reuse API token auth and the mutation lock.

## 7. Testing plan

- `server` unit tests (vitest, alongside `store`/`cloudApi` tests) with a
  fake adapter:
  - happy path: detach/release/allocate/attach called in order, host updated,
    inventory persisted, SSH cache close invoked, activity event written.
  - adapter without support → `not_supported`, no provider calls made.
  - ambiguous / no machine match → 409, no provider calls made.
  - stored host ≠ machine publicIp → `stale_host`.
  - failure at each step → correct `failedStep`, recovery attempted, config
    untouched (unless the new IP is confirmed attached).
  - fingerprint/testStatus reset after rotation.
- API test through `app.ts` for route wiring, auth, mutation lock, and
  error-shape mapping.
- MCP tool test mirroring the existing cloud tool tests (`cloudMcp.test.ts`),
  including the confirmation gate.
- Frontend: component tests for the confirmation dialog, progress, success,
  and mid-sequence failure rendering.

## 8. Rollout / rollback

Additive: new adapter methods, one endpoint, one MCP tool, one UI button.
Rollback = revert. Note that a completed rotation itself cannot be rolled
back (the old IP is gone) — this is inherent to the feature and is why the
confirmation UX exists.
