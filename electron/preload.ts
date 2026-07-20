import { contextBridge, ipcRenderer } from 'electron'

// Keep the desktop bridge deliberately narrow: the renderer can request a directory from the
// operating-system picker, but it never receives general Electron, Node, or filesystem access.
contextBridge.exposeInMainWorld('groveDesktop', {
  chooseLocalDirectory: (currentPath: string) =>
    ipcRenderer.invoke('grove:choose-local-directory', currentPath) as Promise<string | null>,
})
