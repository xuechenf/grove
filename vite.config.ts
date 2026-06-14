/// <reference types="vitest/config" />
import type { Server as HttpProxyServer } from 'node:http'
import type { Socket } from 'node:net'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Socket errors that fire when a proxied WebSocket is torn down rather than closed cleanly:
 * a page reload, React StrictMode's dev double-mount, a closed tab, or the events stream's own
 * reconnect. The dev proxy writes the backend's snapshot into a socket the client already
 * aborted, so http-proxy raises ECONNABORTED/ECONNRESET/EPIPE. vite logs these as alarming
 * "ws proxy error" stack traces even though the transport is healthy. We swallow only these
 * codes; any real proxy failure still surfaces. http-proxy's own cleanup runs on the socket's
 * `close` event, so dropping the benign `error` event leaks nothing.
 */
const BENIGN_PROXY_ERROR_CODES = new Set(['ECONNABORTED', 'ECONNRESET', 'EPIPE'])

function isBenignProxyError(value: unknown) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'code' in value &&
      BENIGN_PROXY_ERROR_CODES.has(String((value as { code?: unknown }).code)),
  )
}

type EmittingTarget = { emit: (event: string | symbol, ...args: unknown[]) => boolean }

/** Wrap emit so a benign `error` event is dropped before any listener (incl. vite's logger) runs. */
function dropBenignErrors(target: EmittingTarget) {
  const original = target.emit.bind(target)
  target.emit = (event, ...args) => {
    if (event === 'error' && isBenignProxyError(args[0])) {
      return false
    }
    return original(event, ...args)
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        // Same env var the backend reads, so a second stack can run on alternate ports.
        target: `http://127.0.0.1:${process.env.GROVE_PORT ?? '8787'}`,
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          dropBenignErrors(proxy as unknown as EmittingTarget)
          ;(proxy as unknown as HttpProxyServer).on('proxyReqWs', (...args: unknown[]) => {
            const socket = args[2] as Socket
            dropBenignErrors(socket as unknown as EmittingTarget)
          })
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
  },
})
