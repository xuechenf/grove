# Grove

Grove is a local-first VM management web app for Linux machines reachable over SSH. The React/Vite frontend talks to a local Node/TypeScript backend that owns SSH/SFTP, terminal sessions, file transfers, AppRunner deployment metadata, activity logs, and the Moonshot/Kimi copilot integration.

## Requirements

- Node.js 22 or newer
- npm
- SSH access to any VMs you want Grove to manage

## Run

```bash
npm install
npm run dev
```

The backend listens on `http://127.0.0.1:8787`. Vite proxies `/api` and WebSocket traffic from the frontend.

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

## Copilot Provider

Configure Moonshot/Kimi from the Settings tab or by creating `.grove/.env.local`:

```bash
GROVE_MOONSHOT_API_KEY=...
GROVE_MOONSHOT_BASE_URL=https://api.moonshot.cn/v1
GROVE_MOONSHOT_MODEL=kimi-k2.6
```

Read-only copilot inspections can use backend SSH/SFTP tools. Mutating operations are converted into confirmation proposals before execution.

## Scripts

```bash
npm run dev      # backend + frontend
npm test         # Vitest
npm run lint     # ESLint
npm run build    # TypeScript + production frontend build
```

## Security Notes

- `.grove/`, `*.pem`, logs, build output, and dependency folders are ignored by Git.
- Keep real private keys under `.grove/keys/` or outside the repo.
- Do not commit `.grove/.env.local`, real inventories, logs, downloads, or VM-specific artifacts.
