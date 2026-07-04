# Grove

Grove is a local-first desktop app for managing Linux machines reachable over SSH. The React/Vite frontend talks to a local Node/TypeScript backend that owns SSH/SFTP, terminal sessions, file transfers, AppRunner deployment metadata, activity logs, and the copilot. The copilot is the center of the app: its brain is **kimi-code CLI** running locally, and it drives VM operations through Grove's scoped MCP tools.

## Download

Installers are published on GitHub Releases:

- [Grove v0.1.0](https://github.com/xuechenf/grove/releases/tag/v0.1.0)
- Windows: setup installer and portable `.exe`
- macOS: `.dmg` and zipped app bundle

The desktop app runs the backend locally and serves the UI from the packaged app. macOS builds are currently unsigned.

## Requirements

For the desktop app:

- SSH access to any VMs you want Grove to manage
- A supported copilot provider API key: Moonshot/Kimi or GLM-CN
- [kimi-code CLI](https://github.com/MoonshotAI/kimi-code), installable from the in-app copilot panel when missing

For local development:

- Node.js 22 or newer
- npm
- [kimi-code CLI](https://github.com/MoonshotAI/kimi-code) on `PATH` for the copilot (`uv tool install kimi-cli`)

## Run

```bash
npm install
npm run dev
```

The backend listens on `http://127.0.0.1:8787`. Vite proxies `/api` and WebSocket traffic from the frontend.

## Desktop Build

```bash
npm run dist:win  # Windows installer and portable app
npm run dist:mac  # macOS dmg and zip, must run on macOS
```

Release publishing is handled by `.github/workflows/release.yml` when a `v*` tag is pushed. The workflow builds Windows and macOS installers on their native GitHub-hosted runners and publishes them to the GitHub Release.

## Project-Local State

Runtime state lives in an ignored `.grove/` folder inside the project:

```text
.grove/
  .env.local
  inventory.yaml
  apprunner.yaml
  keys/
  downloads/
  local-files/
```

Set `GROVE_STATE_DIR` to use a different state folder. Relative SSH key paths in `inventory.yaml` resolve from the state folder, so `keys/example.pem` means `.grove/keys/example.pem`.

Example inventory:

```yaml
vms:
  - id: vm-example
    name: example
    host: 203.0.113.10
    user: deployer
    port: 22
    keyPath: keys/example.pem
    os: Ubuntu 24.04 LTS
    labels: [ssh]
```

Inventory files may reference key paths or SSH agent usage, but must not contain private key material or passwords.

## Copilot

The copilot runs **kimi-code CLI locally** and reaches VMs only through Grove's scoped MCP
tools — kimi never holds SSH keys or opens its own connection. The left inventory bar has an
**All VMs** entry (fleet context) plus one entry per VM (focused context); each scope has its
own conversation, history, and tools.

Configure the provider from the bottom-left Grove settings button or by creating
`.grove/.env.local`:

```bash
GROVE_COPILOT_PROVIDER=moonshot # moonshot or glm-cn
GROVE_COPILOT_API_KEY=...
GROVE_COPILOT_BASE_URL=https://api.moonshot.cn/v1
GROVE_COPILOT_MODEL=kimi-k2.6
```

Selecting GLM-CN from settings fills in its OpenAI-compatible endpoint and `glm-5.2` model defaults.
Grove writes a kimi config from these values to `.grove/runtime/kimi-config.toml` (gitignored)
so kimi runs non-interactively with your key — no separate `kimi login` needed. Set
`GROVE_COPILOT_DRIVER=acp` to use the warm `kimi acp` server instead of per-turn print mode
(ACP needs `kimi login` or the generated config). Existing `GROVE_MOONSHOT_*` env values are
still accepted as a Moonshot fallback.

Read-only inspections run immediately. Mutating commands pause for an explicit Allow once /
Always allow / Deny confirmation before they execute, and the agent sees the result in the
same turn. Mutating work serializes per VM, and the copilot never types into your live
terminal.

## Settings

Use the bottom-left Grove settings button to configure the copilot provider and switch the app theme between system, light, and dark modes. Provider settings are saved into `.grove/.env.local`; API keys are not committed.

## Scripts

```bash
npm run dev      # backend + frontend
npm test         # Vitest
npm run lint     # ESLint
npm run build    # TypeScript + production frontend build
npm run dist:win # Windows desktop artifacts
npm run dist:mac # macOS desktop artifacts
```

## Security Notes

- `.grove/`, `*.pem`, logs, build output, and dependency folders are ignored by Git.
- Keep real private keys under `.grove/keys/` or outside the repo.
- Do not commit `.grove/.env.local`, real inventories, logs, downloads, or VM-specific artifacts.
