import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import electronRenderer from 'vite-plugin-electron-renderer';
import path from 'path';
import { buildSync } from 'esbuild';
import { ownerTargetPlugin } from './targets/viteOwnerTarget';
import { resolveTarget } from './targets/ownerPolicy';

// Henry builds two targets from this one config. The plugin reads HENRY_TARGET
// and, for a standard build, resolves `@henry/owner` to an empty stub so no
// owner-only module is read. It must come first so it sees imports before any
// other resolver. See targets/viteOwnerTarget.ts.
const ownerTarget = ownerTargetPlugin({ root: __dirname });

/**
 * Which target this build is producing, resolved once from HENRY_TARGET.
 * The vite plugin reads it itself; this exists for the esbuild preload
 * re-emit, which runs outside vite and therefore outside the plugin.
 */
function ownerTargetPathForBuild(): 'owner' | 'standard' {
  return resolveTarget(process.env.HENRY_TARGET);
}

export default defineConfig({
  plugins: [
    react(),
    ownerTarget,
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          // vite-plugin-electron runs each entry as its OWN vite build and does
          // not inherit the top-level plugin array, so the owner-target
          // exclusion has to be repeated per entry. Without this the main and
          // preload bundles would resolve `@henry/owner` themselves — or fail
          // to resolve it at all in a standard build.
          plugins: [ownerTargetPlugin({ root: __dirname })],
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['better-sqlite3'],
              output: {
                // ESM banner: shim __filename, __dirname, AND require() so bundled
                // CommonJS-style code (require('fs'), etc) keeps working in the
                // ESM Node context Electron uses when package.json has type:module.
                banner: `import { fileURLToPath } from 'url'; import { dirname } from 'path'; import { createRequire } from 'module'; const __filename = fileURLToPath(import.meta.url); const __dirname = dirname(__filename); const require = createRequire(import.meta.url);`,
                codeSplitting: false,
              },
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['better-sqlite3'],
              output: {
                // A sandboxed preload (sandbox: true) MUST be CommonJS — Electron
                // cannot load an ESM preload in a sandboxed renderer. package.json
                // has type:module, so an ESM `.js` preload fails to load and the
                // renderer falls back to the webMock. Emit `.cjs` to force CJS.
                format: 'cjs',
                entryFileNames: 'preload.cjs',
                codeSplitting: false,
              },
            },
          },
          // vite-plugin-electron runs each entry as its OWN vite build and does
          // not inherit the top-level plugin array, so the owner-target
          // exclusion has to be repeated per entry. Without this the main and
          // preload bundles would resolve `@henry/owner` themselves — or fail
          // to resolve it at all in a standard build.
          plugins: [
            ownerTargetPlugin({ root: __dirname }),
            {
              // vite-plugin-electron under vite 8 (rolldown) IGNORES the
              // output.format above and emits ESM (`import ... from "electron"`)
              // into preload.cjs — the sandboxed preload then dies on line 1
              // with a SyntaxError and the renderer silently falls back to
              // webMock (no voice/coder/machines IPC). Re-emit through esbuild,
              // which actually honors CJS. Runs after every preload rebuild.
              name: 'force-cjs-preload',
              closeBundle() {
                buildSync({
                  entryPoints: ['electron/preload.ts'],
                  bundle: true,
                  format: 'cjs',
                  platform: 'node',
                  // The esbuild re-emit bypasses vite entirely, so it needs its
                  // own alias for the owner seam. Without this, a preload that
                  // imports `@henry/owner` fails to resolve — or, worse, an
                  // esbuild-resolved owner path would ship unexcluded into
                  // preload.cjs. Resolved the way vite resolves it: the stub for
                  // a standard build, the real module for an owner one.
                  alias: {
                    '@henry/owner': path.resolve(
                      __dirname,
                      ownerTargetPathForBuild() === 'owner' ? 'electron/owner/index.ts' : 'targets/ownerStub.ts'
                    ),
                    '@henry/owner-ui': path.resolve(
                      __dirname,
                      ownerTargetPathForBuild() === 'owner' ? 'src/owner/index.ts' : 'targets/ownerStub.ts'
                    ),
                  },
                  external: ['electron'],
                  outfile: 'dist-electron/preload.cjs',
                });
                console.log('[force-cjs-preload] preload.cjs re-emitted as CommonJS');
              },
            },
          ],
        },
      },
    ]),
    electronRenderer(),
  ],
  base: './',
  build: {
    outDir: 'renderer',
  },
  optimizeDeps: {
    exclude: ['@capacitor-mlkit/barcode-scanning'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@capacitor-mlkit/barcode-scanning': path.resolve(
        __dirname,
        './src/stubs/barcodeScanning.ts'
      ),
    },
  },
});
