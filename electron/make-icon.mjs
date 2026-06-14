import sharp from 'sharp'
import { mkdirSync, readFileSync } from 'node:fs'

// One-off: rasterize the app logo (public/favicon.svg) into build/icon.png (1024x1024). The PNG is
// committed and is the single source electron-builder converts into platform icons (.ico / .icns).
// Re-run this only when the logo changes: `node electron/make-icon.mjs`.
mkdirSync('build', { recursive: true })

const svg = readFileSync('public/favicon.svg')

// density raises the SVG's rasterization resolution (its viewBox is only 64 units) so the 1024px
// output is sharp rather than an upscaled 64px render.
await sharp(svg, { density: 1200 })
  .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile('build/icon.png')

console.log('Wrote build/icon.png (1024x1024)')
