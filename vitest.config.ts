import { defineConfig } from 'vitest/config';

// Standalone test config (separate from the electron/renderer build in
// vite.config.ts). Tests are pure Node — the security helpers, content-block
// builders, and other logic that must not be coupled to Electron's runtime.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts', 'src/**/*.test.ts'],
    watch: false,
  },
});
