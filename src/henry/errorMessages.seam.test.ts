/**
 * The three failure classes a provider can be in must stay three different
 * messages — for the same provider, on the same surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * Collapsing them is the failure mode that sends people to fix the wrong thing.
 * A gateway that is down looks identical to a rejected key if the message says
 * "check your API key", and the user's next hour is spent re-entering a
 * credential that was never the problem. The worked example is OpenCode Zen:
 * asked anonymously, the Zen gateway answers
 *
 *     Upstream request failed: Model is unavailable (type=server_error)
 *
 * which is the SERVICE failing — not an auth rejection, not a missing key, and
 * not model-specific. It must land in the availability bucket and never in the
 * credential one.
 *
 * The three buckets, in the order `buildStreamError` tests them:
 *
 *   credential   — a key is missing, wrong or expired; the fix is a key
 *   billing      — quota, credits or a subscription ran out; the fix is payment
 *   availability — the provider is up but cannot serve; the fix is to retry, or
 *                  to use a different provider. NEVER "you need a key".
 */

import { describe, it, expect } from 'vitest';
import {
  buildBothFailedError,
  buildStartError,
  buildStreamError,
  isAuthError,
  isBillingError,
  isRateLimitError,
  isServiceUnavailableError,
} from './errorMessages';

const PROVIDER = 'opencode-zen';
const MODEL = 'hy3-free';

/** The verbatim anonymous Zen answer, from the direct CLI test. */
const ZEN_UNAVAILABLE =
  'opencode exited with code 1: Upstream request failed: Model is unavailable (type=server_error)';

const CREDENTIAL_FAILURE = 'Error: 401 Unauthorized — invalid api key provided';
const BILLING_FAILURE = 'Error: insufficient credits — add credits to continue';
const AVAILABILITY_FAILURE = ZEN_UNAVAILABLE;

/** A message that tells the user to go and fix a credential. */
const ASKS_FOR_A_KEY = /\b(api key|credential|sign in|log in|add your own key)\b/i;
/** A message that tells the user to go and pay. */
const ASKS_FOR_MONEY = /\b(credit|billing|payment|subscription|top up|plan|quota)\b/i;
/** A message that tells the user the service, not the setup, is the problem. */
const SAYS_UNAVAILABLE = /\bunavailable\b|\bdegraded\b|\bservice\b/i;

describe('the classifiers are disjoint where it matters', () => {
  it('puts each failure in exactly its own bucket', () => {
    expect(isAuthError(CREDENTIAL_FAILURE)).toBe(true);
    expect(isBillingError(CREDENTIAL_FAILURE)).toBe(false);
    expect(isServiceUnavailableError(CREDENTIAL_FAILURE)).toBe(false);

    expect(isBillingError(BILLING_FAILURE)).toBe(true);
    expect(isAuthError(BILLING_FAILURE)).toBe(false);
    expect(isServiceUnavailableError(BILLING_FAILURE)).toBe(false);

    expect(isServiceUnavailableError(AVAILABILITY_FAILURE)).toBe(true);
    expect(isAuthError(AVAILABILITY_FAILURE)).toBe(false);
    expect(isBillingError(AVAILABILITY_FAILURE)).toBe(false);
  });

  it('keeps a plain 429 in the rate-limit bucket, not billing and not availability', () => {
    // Waiting is the correct advice here, and "add credits" is not.
    const rateLimited = 'Error: 429 Too Many Requests — rate limit exceeded';
    expect(isRateLimitError(rateLimited)).toBe(true);
    expect(isBillingError(rateLimited)).toBe(false);
    expect(isServiceUnavailableError(rateLimited)).toBe(false);
  });
});

describe('one provider surface, three failures, three messages', () => {
  const credential = buildStreamError(PROVIDER, MODEL, CREDENTIAL_FAILURE);
  const billing = buildStreamError(PROVIDER, MODEL, BILLING_FAILURE);
  const unavailable = buildStreamError(PROVIDER, MODEL, AVAILABILITY_FAILURE);

  it('produces three different messages', () => {
    const distinct = new Set([credential, billing, unavailable]);
    expect(distinct.size, 'the three failure classes collapsed into one message').toBe(3);
  });

  it('asks for a credential only in the credential bucket', () => {
    expect(credential).toMatch(ASKS_FOR_A_KEY);
    expect(billing).not.toMatch(ASKS_FOR_A_KEY);
    expect(unavailable).not.toMatch(ASKS_FOR_A_KEY);
  });

  it('asks for payment only in the billing bucket', () => {
    expect(billing).toMatch(ASKS_FOR_MONEY);
    expect(credential).not.toMatch(ASKS_FOR_MONEY);
    expect(unavailable).not.toMatch(ASKS_FOR_MONEY);
  });

  it('reports the Zen server_error as the service being unavailable, not a key problem', () => {
    expect(unavailable).toMatch(SAYS_UNAVAILABLE);
    // The verbatim upstream reason is kept: it is the only evidence that the
    // request reached the gateway at all.
    expect(unavailable).toContain('type=server_error');
    // And the advice must be retry-or-switch, never go-and-authenticate.
    expect(unavailable).toMatch(/try again/i);
  });
});

describe('the same three buckets survive on the other two surfaces', () => {
  it('buildBothFailedError keeps the three classes apart', () => {
    const credential = buildBothFailedError(PROVIDER, MODEL, CREDENTIAL_FAILURE, MODEL, CREDENTIAL_FAILURE);
    const billing = buildBothFailedError(PROVIDER, MODEL, BILLING_FAILURE, MODEL, BILLING_FAILURE);
    const unavailable = buildBothFailedError(
      PROVIDER, MODEL, AVAILABILITY_FAILURE, MODEL, AVAILABILITY_FAILURE,
    );

    expect(new Set([credential, billing, unavailable]).size).toBe(3);
    expect(credential).toMatch(ASKS_FOR_A_KEY);
    expect(billing).toMatch(ASKS_FOR_MONEY);
    expect(billing).not.toMatch(ASKS_FOR_A_KEY);
    expect(unavailable).not.toMatch(ASKS_FOR_A_KEY);
    expect(unavailable).not.toMatch(ASKS_FOR_MONEY);
    expect(unavailable).toMatch(SAYS_UNAVAILABLE);
  });

  it('buildStartError reports an unavailable service as unavailable', () => {
    const message = buildStartError(new Error(`Error invoking remote method 'ai:send': ${ZEN_UNAVAILABLE}`));
    expect(message).toMatch(SAYS_UNAVAILABLE);
    expect(message).not.toMatch(ASKS_FOR_A_KEY);
  });

  it('buildStartError still explains a missing engine as a configuration step', () => {
    const message = buildStartError(new Error('No model selected'));
    expect(message).toMatch(/Settings/i);
    expect(message).toMatch(/key/i);
  });
});