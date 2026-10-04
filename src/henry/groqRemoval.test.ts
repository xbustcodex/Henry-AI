/**
 * Guard: the retired provider is gone from the routing layer.
 *
 * `modelRouter.ts`, `localRouter.ts`, `errorMessages.ts`, `contextTier.ts` and
 * `gateway.ts` are the five files that decide where a chat message goes and
 * what the user is told when it cannot go anywhere. A single surviving
 * reference — a default provider id, a pricing row, a help string that tells
 * the user to go buy a key for a provider we no longer support — is a route
 * back into it, and it is invisible to behavioural tests because nothing calls
 * those paths any more. So the guard is on the files themselves.
 *
 * It lives outside the router's own suite so that the scanner can include
 * `modelRouter.test.ts` too: a fixture that quietly reintroduces the retired
 * id would otherwise be the one file the guard could not check.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const RETIRED = /groq/i;

const GUARDED_FILES = [
  'modelRouter.ts',
  'modelRouter.test.ts',
  'localRouter.ts',
  'errorMessages.ts',
  'contextTier.ts',
  'gateway.ts',
] as const;

describe('retired provider removal — routing layer', () => {
  it.each(GUARDED_FILES)('%s has no reference to the retired provider', (file) => {
    expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toMatch(RETIRED);
  });

  it('would actually catch one', () => {
    // A guard that cannot fail is not a guard. This pins the matcher against a
    // string that really does contain the retired id.
    expect("provider: 'groq'").toMatch(RETIRED);
  });
});