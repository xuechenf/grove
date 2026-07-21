export {}

declare global {
  interface Window {
    groveDesktop?: {
      chooseLocalDirectory(currentPath: string): Promise<string | null>
      getUiToken(): Promise<string | null>
    }
  }
}
