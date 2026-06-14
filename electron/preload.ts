// Minimal preload. The renderer is the existing Grove web app served over HTTP and needs no Node
// bridge today. This file exists as a hardening seam (contextIsolation stays on) and a place to
// expose narrowly-scoped IPC later if desktop-only features are added.
export {}
