/**
 * Guard: no active source string tells the user that an OpenCode / OpenCode Zen /
 * Prime Pi model is free, or that it needs no key.
 *
 * WHY THIS EXISTS
 * ---------------
 * The cost policy is owner-ruled and singular: **Ollama is Henry's only free AI
 * path.** Every other provider — opencode, OpenCode Zen, the models a Prime Pi
 * install can reach, every cloud API — runs on the user's own account, key,
 * subscription or credits.
 *
 * That rule is easy to state and easy to lose. Every surface that first shipped
 * Zen described it as "free", "credential-optional" or "no key needed", and each
 * of those strings was individually plausible: the model ids really do carry a
 * `-free` suffix, and the opencode CLI really does authenticate on its own. Both
 * facts are true and neither is a price. This guard is what stops them being
 * re-joined into a claim.
 *
 * WHAT IT COVERS
 * --------------
 * Every `.ts` / `.tsx` file under `src/` and `electron/` — the active source,
 * UI copy, comments and help text alike. Documentation is deliberately NOT
 * covered: `CHANGELOG.md` is a historical record and must keep describing what
 * the code used to say.
 *
 * NOT VACUOUS
 * -----------
 * The first block feeds the matcher known-bad strings and asserts each is
 * caught. A matcher that returned nothing for everything would "pass" the repo
 * scan, so that block is the whole reason the rest of this file can be trusted —
 * and the repo scan additionally asserts that files were actually read.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { isOllamaProvider, OPENCODE_ZEN_PROVIDER_ID, OPENCODE_PROVIDER_ID } from '../../electron/providers/classification';
import { PROVIDERS } from '../providers/models';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Directories whose TypeScript is active source. */
const SOURCE_DIRS = ['src', 'electron'];

/**
 * What makes a line a CLAIM rather than a fact about a model id.
 *
 * `hy3-free` is a name, and `isZen`/`requiresApiKey()` are statements about
 * credentials. Neither is a price, so a rule only fires when its claim pattern
 * AND its service context are both present on the same line.
 */
const CLAIM_CONTEXT = /opencode|\bomp\b|\bzen\b|prime pi/i;

interface Rule {
  id: string;
  why: string;
  re: RegExp;
  /** Rules that only mean something next to an external service name. */
  needsServiceContext?: boolean;
}

const RULES: Rule[] = [
  {
    id: 'calls-a-model-free',
    why: 'asserts an external service\'s models cost the user nothing',
    re: /\bfree\s+(?:zen|opencode|omp|prime pi|zen\s+models?|opencode\s+models?)\b/i,
  },
  {
    id: 'calls-a-service-free',
    why: 'asserts an external service itself is free',
    re: /(?:opencode|\bomp\b|zen|prime pi)[^\n]{0,60}?\b(?:is|are|still|stay|runs?|remains?|keep)\s+free\b/i,
  },
  {
    id: 'needs-no-key',
    why: 'asserts an external service answers with no credential',
    re: /\bneeds?\s+no\s+key\b|\bno\s+key\s+(?:needed|required|at\s+all|of\s+its\s+own)\b|\bwithout\s+(?:any\s+)?(?:an?\s+)?(?:api\s+)?key\b/i,
  },
  {
    id: 'credential-optional',
    why: 'labels an external service credential-optional',
    re: /\bcredential[- ]optional\b|\bworks?\s+without\s+a\s+credential\b/i,
  },
  {
    id: 'free-label',
    why: 'renders a "-free" model id as a price claim in the UI',
    re: /\?\s*['"`]\s*·\s*free\b/,
    needsServiceContext: false,
  },
  {
    id: 'free-model-tier',
    why: 'divides an external service\'s catalogue into free and paid models',
    re: /\b(?:paid|free)\s+zen\s+models?\b/i,
  },
];

/** Every finding in one file: `{ file, line, rule, text }`. */
export interface CostPolicyFinding {
  file: string;
  line: number;
  rule: string;
  why: string;
  text: string;
}

/**
 * Every cost-policy violation in `text`, in source order.
 *
 * Comment lines count: a comment that tells the next reader that Zen is free is
 * how the string comes back two releases later.
 */
export function findCostPolicyViolations(text: string, file: string): CostPolicyFinding[] {
  const findings: CostPolicyFinding[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    for (const rule of RULES) {
      if (!rule.re.test(raw)) continue;
      if (rule.needsServiceContext !== false && !CLAIM_CONTEXT.test(raw)) continue;
      findings.push({ file, line: index + 1, rule: rule.id, why: rule.why, text: raw.trim() });
    }
  });
  return findings;
}

function walk(dir: string): string[] {
  const abs = join(REPO_ROOT, dir);
  const out: string[] = [];
  const stack = [abs];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const child = join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(relative(REPO_ROOT, child));
    }
  }
  return out;
}

const SOURCE_FILES = SOURCE_DIRS.flatMap(walk);

/**
 * The one file exempt from the repo scan: this one, which necessarily quotes
 * the claims it exists to reject. A wider exemption is a wider hole, and the
 * reason above is the whole justification for it — asserted below.
 */
const SELF_EXEMPT_FILES = ['src/henry/costPolicy.test.ts'];

describe('cost policy — the matcher itself', () => {
  it('catches a known-bad claim for every rule', () => {
    const dummies: Record<string, string> = {
      'calls-a-model-free': "detail: 'Without a key you still get the free Zen models; a key unlocks the rest.'",
      'calls-a-service-free': '// OpenCode Zen is free once the CLI is installed.',
      'needs-no-key': "const HINT = 'Free Zen models need no key at all';",
      'credential-optional': '/** Cloud is BYOK; Zen is credential-optional. */',
      'free-label': "{m.name}{m.isFree ? ' · free' : ''}",
      'free-model-tier': 'Detected on this computer — add a key only if you want paid Zen models',
    };
    const missed = RULES.filter((rule) => findCostPolicyViolations(dummies[rule.id], 'x.ts').length === 0)
      .map((rule) => rule.id);
    expect(missed, `these rules never fire on their own dummy: ${missed.join(', ')}`).toEqual([]);
  });

  it('does not fire on Ollama, local capabilities, or a model id ending in -free', () => {
    const benign = [
      "const OLLAMA_CARD = 'Free · Private · Offline';",
      "description: 'Run models locally on your machine. Free — Henry\\'s only cost-free AI path.'",
      "const models = ['hy3-free', 'deepseek-v4-flash-free', 'meta-llama/llama-3.3-70b-instruct:free'];",
      '// Local whisper.cpp — free, offline, and runs on the user\'s own machine.',
      '// DuckDuckGo\'s free Instant Answer API. No key, no signup.',
      '// OctoPrint needs the printer\'s API key (entered once here); Klipper connects with no key.',
      '// Web Speech API needs no key — it is local.',
      '// A local model is free and local, so nothing downstream prices it per token.',
      'if (requiresApiKey(provider)) throw new Error(\'Worker provider is missing an API key.\');',
      '· Free local voice',
    ].join('\n');
    expect(findCostPolicyViolations(benign, 'benign.ts')).toEqual([]);
  });
});

describe('cost policy — repository source', () => {
  it('scanned a real file set, not an empty one', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(200);
    expect(SOURCE_FILES).toContain('src/henry/costPolicy.test.ts');
    expect(SOURCE_FILES).toContain('src/components/wizard/ProviderStep.tsx');
    expect(SOURCE_FILES).toContain('electron/providers/classification.ts');
  });

  it('claims no external AI service is free or keyless', () => {
    const findings = SOURCE_FILES.filter((file) => !SELF_EXEMPT_FILES.includes(file)).flatMap((file) =>
      findCostPolicyViolations(readFileSync(join(REPO_ROOT, file), 'utf8'), file),
    );
    expect(
      findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.why} — ${f.text}`),
      'Ollama is the only free AI path; an external service needs the user\'s own account',
    ).toEqual([]);
  });

  it('exempts only the guard file itself', () => {
    expect(SELF_EXEMPT_FILES).toEqual(['src/henry/costPolicy.test.ts']);
  });
});

describe('cost policy — Ollama keeps the free path', () => {
  it('is the only provider the classifier calls the free path', () => {
    // One authority, so no two surfaces can disagree about what is free.
    expect(isOllamaProvider('ollama', 'Ollama (Local)')).toBe(true);
    expect(isOllamaProvider(OPENCODE_ZEN_PROVIDER_ID, 'OpenCode Zen')).toBe(false);
    expect(isOllamaProvider(OPENCODE_PROVIDER_ID, 'OpenCode (CLI)')).toBe(false);
    expect(isOllamaProvider('openai', 'OpenAI')).toBe(false);
    expect(isOllamaProvider('anthropic', 'Anthropic')).toBe(false);
  });

  it('still says free, in the registry and on the onboarding card', () => {
    expect(PROVIDERS.ollama.description).toMatch(/free/i);
    const providerStep = readFileSync(join(REPO_ROOT, 'src/components/wizard/ProviderStep.tsx'), 'utf8');
    expect(providerStep).toContain('Free · Private · Offline');
  });

  it('does not describe the external services as free in the registry', () => {
    for (const id of [OPENCODE_ZEN_PROVIDER_ID, OPENCODE_PROVIDER_ID] as const) {
      expect(PROVIDERS[id].description).not.toMatch(/\bfree\b/i);
      expect(PROVIDERS[id].description).toMatch(/your own/i);
    }
  });
});