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
  },
});
