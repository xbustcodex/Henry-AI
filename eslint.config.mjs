import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'dist-electron/**', 'release/**', 'node_modules/**', 'public/**', '.local/**'] },
  {
    extends: [...tseslint.configs.recommended, prettierConfig],
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // ── react-hooks v7 new rules ─────────────────────────────────────────
      // These rules are overly strict and produce many false-positives in
      // production-quality code that intentionally sets state inside effects
      // (e.g. after async operations, initialization, subscriptions).
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/immutability': 'off',
      // ─────────────────────────────────────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    // Electron main process runs in CommonJS; require() (incl. lazy requires
    // inside IPC handlers) is intentional and idiomatic there.
    files: ['electron/**/*.{ts,tsx}', 'scripts/**/*.{ts,js}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  }
);
