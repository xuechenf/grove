import { startGroveServer } from './start'

// CLI entry: `npm run server:start` / `server:dev`. Binds GROVE_PORT (default 8787) so the Vite
// dev proxy can target it. The packaged desktop app starts the server from electron/main instead.
startGroveServer().catch((error: unknown) => {
  console.error('Grove backend failed to start:', error)
  process.exit(1)
})
