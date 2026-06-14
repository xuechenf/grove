import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { startGroveServer, type GroveServerHandle } from '../server/start'

// In dev, `npm run electron:dev` sets VITE_DEV_SERVER_URL and runs the Vite dev server + the tsx
// backend separately; the window just loads the Vite URL. In a packaged build neither is set, so
// we start the backend in-process and load it.
const devServerUrl = process.env.VITE_DEV_SERVER_URL

let serverHandle: GroveServerHandle | undefined
let mainWindow: BrowserWindow | undefined

/** Packaged layout: app.asar/dist-electron/main.js -> the built UI sits at app.asar/dist. */
function resolveStaticDir() {
  return join(__dirname, '..', 'dist')
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b1120',
    title: 'Grove',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // External links (target=_blank, window.open) open in the OS browser, never a new chromeless
  // Electron window — keeps the app surface to the trusted local UI.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = undefined
  })

  await mainWindow.loadURL(devServerUrl ?? serverHandle!.url)
}

async function boot() {
  // State must live in a per-user writable location, not next to a possibly read-only install dir.
  // projectStateDir() in the backend already honors GROVE_STATE_DIR.
  if (!process.env.GROVE_STATE_DIR) {
    process.env.GROVE_STATE_DIR = join(app.getPath('userData'), 'grove')
  }
  // Give the local file browser a sane default workspace (localDefaults() reads process.cwd()).
  try {
    process.chdir(app.getPath('home'))
  } catch {
    // Non-fatal: keep the launch directory if the platform rejects chdir.
  }

  if (!devServerUrl) {
    serverHandle = await startGroveServer({ port: 0, staticDir: resolveStaticDir() })
  }

  await createWindow()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.focus()
    }
  })

  app
    .whenReady()
    .then(boot)
    .catch((error: unknown) => {
      console.error('Grove failed to start:', error)
      app.quit()
    })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('will-quit', () => {
    void serverHandle?.close()
  })
}
