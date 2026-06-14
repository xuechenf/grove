import { build } from 'esbuild'
import { rmSync } from 'node:fs'

// Bundle the Electron main + preload (and, through main, the whole backend) into dist-electron/.
// Output is CJS with a .cjs extension because the package is `"type": "module"` — without the
// explicit extension Electron/Node would load these as ESM and the CJS globals (`require`,
// `__dirname`, `module.exports`) would break.
const outdir = 'dist-electron'
rmSync(outdir, { recursive: true, force: true })

await build({
  entryPoints: {
    main: 'electron/main.ts',
    preload: 'electron/preload.ts',
  },
  outdir,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // Matches the Node runtime embedded in current Electron; bump alongside the electron devDep.
  target: 'node20',
  sourcemap: true,
  // Keep Electron and native/optional addons out of the bundle. They resolve at runtime from
  // node_modules (shipped by electron-builder); ssh2's optional native deps are guarded internally.
  external: ['electron', 'ssh2', 'cpu-features', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
})
