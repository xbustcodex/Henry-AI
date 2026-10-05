import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Standalone test config (separate from the electron/renderer build in
// vite.config.ts). Tests are pure Node — the security helpers, content-block
// builders, and other logic that must not be coupled to Electron's runtime.
export default defineConfig({
  // The same aliases the renderer build uses (see vite.config.ts). Without `@`
  // here, any test that transitively imports a component fails to resolve at
  // import time — which is why the component tests in this repo could only ever
  // cover leaf modules. The Capacitor barcode plugin is stubbed in non-native
  // builds and needs the same mapping.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@capacitor-mlkit/barcode-scanning': path.resolve(__dirname, './src/stubs/barcodeScanning.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts', 'src/**/*.test.ts'],
    watch: false,

    // The default 10s hook timeout is marginal for this suite. 144 files run in
    // parallel worker threads, and the suites that touch the real filesystem or
    // SQLite (memoryStagePersistence, providerState.seam, PrinterPanel) intermittently
    // exceeded 10s purely from CPU contention. They are load-sensitive, not
    // ordering-, cleanup- or handle-leak-sensitive: proven both ways, the whole suite
    // is green at 60s, and each of those files passes in isolation at the default.
    // Raising the budget makes `npm test` deterministic on a loaded machine rather
    // than reporting failures that do not exist.
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
