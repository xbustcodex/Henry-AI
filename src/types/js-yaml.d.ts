// js-yaml ships no TypeScript declarations. Only the single `load` entry point
// this test suite uses is declared; it is a test-only dependency.
declare module 'js-yaml' {
  export function load(input: string): unknown;
}
