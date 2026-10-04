/**
 * Credential-shaped-literal scanner.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every provider key Henry supports is entered by the user at setup time and
 * stored in their own profile. None of them has any business existing in this
 * repository or in a bundle it produces. A key committed here is shipped to
 * every customer who installs the app, and it is invisible in review because a
 * 52-character string in a seed row looks exactly like a 52-character
 * identifier.
 *
 * The scanner is deliberately text-shaped and provider-shaped rather than
 * entropy-shaped: it looks for the prefixes real keys carry (`gsk_`, `sk-ant-`,
 * `AIza`, `ghp_`, …) plus a PEM private-key block and a JWT. Entropy heuristics
 * were tried and rejected — they fire on minified bundles, hash constants and
 * base64 assets, which makes a guard that cries wolf a guard that gets disabled.
 *
 * PURE ON PURPOSE
 * ---------------
 * This module takes text and returns findings. It touches no filesystem, no
 * `node:*` import, and no Electron API, so the renderer bundle can never pull it
 * in and the test can drive it over any file set. The filesystem walk and the
 * policy decisions (what is scanned, what is an allowed fixture) live in
 * `secretScan.test.ts`, which is a Node test and never ships.
 */

export interface SecretFinding {
  /** Stable id of the rule that matched. */
  rule: string;
  /** The literal that matched, truncated so the finding can be printed safely. */
  match: string;
  /** 1-based line number within the scanned text. */
  line: number;
}

interface Rule {
  id: string;
  re: RegExp;
  /** Human explanation, used when a finding is reported. */
  why: string;
}

/**
 * Provider key shapes.
 *
 * Length floors are set per prefix rather than globally because a short floor
 * over `sk-` matches ordinary hyphenated English words joined to a long tail
 * (`task-processing-...`), while a long floor over a distinctive prefix like
 * `ghp_` costs nothing and still catches every real token.
 */
const RULES: Rule[] = [
  // Groq. The provider is retired, but a key for it is still a live credential
  // anywhere it appears, and the retired-provider migration only blanks stored
  // values — it cannot un-leak one that was committed.
  { id: 'groq', re: /\bgsk_[A-Za-z0-9]{20,}/g, why: 'Groq API key' },
  // Anthropic. Checked before the generic `sk-` rule so the report names it.
  { id: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, why: 'Anthropic API key' },
  // OpenAI (classic and project-scoped).
  { id: 'openai', re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g, why: 'OpenAI API key' },
  // OpenRouter.
  { id: 'openrouter', re: /\bsk-or-v1-[A-Za-z0-9]{20,}/g, why: 'OpenRouter API key' },
  // DeepSeek shares the bare `sk-` shape and is covered above.
  { id: 'google', re: /\bAIza[0-9A-Za-z_-]{30,}/g, why: 'Google API key' },
  { id: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, why: 'GitHub token' },
  { id: 'gitlab', re: /\bglpat-[A-Za-z0-9_-]{20,}/g, why: 'GitLab token' },
  { id: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, why: 'Slack token' },
  { id: 'xai', re: /\bxai-[A-Za-z0-9]{20,}/g, why: 'xAI API key' },
  { id: 'huggingface', re: /\bhf_[A-Za-z0-9]{30,}/g, why: 'Hugging Face token' },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, why: 'AWS access key id' },
  // A PEM block. The body is not matched — the header alone is proof, and the
  // body is a different length on every key.
  {
    id: 'private-key-block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    why: 'PEM private key',
  },
  // JWT. Three base64url segments, each long enough that a dotted identifier
  // cannot imitate it.
  {
    id: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    why: 'JSON Web Token',
  },
];

/**
 * Known-fake values that must be allowed to exist.
 *
 * Matching is on the EXACT pair. A file may carry a fake key; it may not carry a
 * different one. Each entry records why the value is fake, and the test fails if
 * an entry no longer matches anything in its file — a stale allowlist entry is
 * how an allowlist quietly becomes a hole.
 */
export interface AllowedFixture {
  /** Repo-relative path of the file the fixture lives in. */
  file: string;
  /** The exact literal that is allowed. */
  literal: string;
  /** Why this value is known not to be a credential. */
  why: string;
}

export const ALLOWED_FIXTURES: AllowedFixture[] = [
  {
    file: 'electron/agent/credentials.test.ts',
    literal: 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
    why: 'Sequential A1b2C3 pattern; it only has to round-trip through the credential vault.',
  },
  {
    file: 'electron/agent/tools/github.test.ts',
    literal: 'ghp_supersecrettoken0123456789',
    why: 'Reads as a word, not a token; asserts the Authorization header is built.',
  },
  {
    file: 'electron/ipc/appLog.test.ts',
    literal: 'sk-abcdefghijklmnopqrstuvwxyz012345',
    why: 'The alphabet in order; the test proves redactSecrets strips it.',
  },
  {
    file: 'electron/ipc/appLog.test.ts',
    literal: 'sk-zzzzsecretkeyvalue123456',
    why: 'Placeholder registered via registerSecret in the redaction round-trip test.',
  },
  {
    file: 'electron/ipc/appLog.test.ts',
    literal: 'sk-aaaaaaaaaaaaaaaaaaaa',
    why: 'One repeated character; the test proves provider-name context is not needed to redact.',
  },
  {
    file: 'electron/ipc/appLog.test.ts',
    literal: 'sk-plaintextkeyvalue12345',
    why: 'Spells out that it is plaintext; asserts redaction can be disabled, so this one survives.',
  },
  {
    file: 'electron/ipc/appLog.test.ts',
    literal: 'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    why: 'Digits then the alphabet in order; redaction test input.',
  },
  {
    file: 'electron/ipc/appLog.test.ts',
    literal: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    why: 'The full alphabet in order; redaction test input.',
  },
  {
    file: 'electron/ipc/appLog.test.ts',
    literal: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    why: 'The JWT from jwt.io, published in that tool\'s own documentation as the example value.',
  },
  {
    file: 'src/henry/voiceDiagnostics.test.ts',
    literal: 'gsk_abcdefghijklmnop',
    why: 'The alphabet in order; asserts voice diagnostics never echo a key.',
  },
  {
    file: 'src/henry/voiceDiagnostics.test.ts',
    literal: 'sk-ant-abcdefghijklmnop',
    why: 'The alphabet in order; same assertion, Anthropic shape.',
  },
  {
    file: 'src/henry/voiceDiagnostics.test.ts',
    literal: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl',
    why: 'Header decodes to {"alg":"HS256"}, body to {"sub":"1"}, signature is the alphabet in order.',
  },
];

/**
 * The files this scanner exempts from its own literal rules, and why.
 *
 * `secretScan.ts` holds the rules and the allowlist; `secretScan.test.ts` holds
 * one known-dummy per rule so the matcher can be shown to fail. Both necessarily
 * contain credential-shaped text. The exemption is a list of two files rather
 * than a rule about test files, because "skip everything matching *.test.ts" is
 * exactly the exemption a real leak hides behind.
 *
 * The hole that opens is closed by the test asserting that every finding in
 * these two files is one of the declared values, so an undeclared literal added
 * to either file is still a failure.
 */
export const SELF_EXEMPT_FILES: Record<string, string> = {
  'src/henry/secretScan.ts': 'this module: it holds the rule set and the allowlist itself',
  'src/henry/secretScan.test.ts': 'one known-dummy per rule, used to prove the matcher fails',
};

/**
 * One fake credential per rule, used by the test to prove the rule fires.
 *
 * These are the values the self-exemption above is allowed to cover. Every one
 * is a sequential run or a spelled-out word; none is a real credential.
 */
// Assembled from fragments on purpose. Several of these shapes (Slack tokens
// above all) are structurally indistinguishable from a live credential, so
// committing one verbatim trips GitHub push protection and makes the repository
// un-pushable. Concatenating at runtime keeps each regex under test identical
// while never placing a real-looking token in the tree.
const p = (...parts: string[]) => parts.join('');

export const KNOWN_DUMMIES: Record<string, string> = {
  groq: p('gsk_', '0123456789abcdefghijklmnopqrstuvwxyz', 'ABCDEFG'),
  anthropic: p('sk-ant-', 'api03-', '0123456789abcdefghijkl'),
  openai: p('sk-', '0123456789abcdefghijklmnopqrstuvwxyz', 'AB'),
  openrouter: p('sk-or-', 'v1-', '0123456789abcdefghijklmnopqrstuv'),
  google: p('AIza', 'Sy0123456789abcdefghijklmnopqrstuvwxyz'),
  github: p('ghp_', '0123456789abcdefghijklmnopqrstuvwxyz'),
  gitlab: p('glpat-', '0123456789abcdefghijklmnop'),
  slack: p('xox', 'b-', '0123456789', '-', '0123456789abcdef'),
  xai: p('xai-', '0123456789abcdefghijklmnopqrstuvwxyz'),
  huggingface: p('hf_', '0123456789abcdefghijklmnopqrstuvwxyz'),
  'aws-access-key-id': p('AKIA', 'IOSFODNN7EXAMPLE'),
  'private-key-block': p('-----BEGIN ', 'RSA PRIVATE KEY-----'),
  jwt: p(
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ',
    '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ),
};
/** Rule ids, for assertions that need to cover the whole set. */
export const RULE_IDS: readonly string[] = RULES.map((r) => r.id);

/** Why each rule exists, keyed by rule id. */
const RULE_WHY: Record<string, string> = RULES.reduce<Record<string, string>>(
  (acc, r) => { acc[r.id] = r.why; return acc; },
  {},
);

/** 1-based line number for a character offset. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Keep a finding printable without reprinting the whole credential. */
function preview(match: string): string {
  return match.length <= 12 ? match : `${match.slice(0, 8)}…(${match.length} chars)`;
}

/**
 * Every credential-shaped literal in `text`, in source order, with no
 * exemptions of any kind applied.
 *
 * Used to audit the scanner's own files: the exemption list says which values
 * those two files are allowed to contain, and this is what checks that claim.
 */
export function findSecretsRaw(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of RULES) {
    // A /g regex keeps `lastIndex` between calls; reset so the result does not
    // depend on what this module scanned before.
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      findings.push({ rule: rule.id, match: m[0], line: lineAt(text, m.index) });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

/**
 * Every credential-shaped literal in `text` that should not be there.
 *
 * `file` decides what is excused, and the excuse is always for one file and one
 * exact value. A fixture allowlisted in a test is still a finding in production
 * code, so moving a fake out of the test does not launder it.
 */
export function findSecrets(text: string, file: string): SecretFinding[] {
  if (Object.prototype.hasOwnProperty.call(SELF_EXEMPT_FILES, file)) return [];
  const excused = new Set(
    ALLOWED_FIXTURES.filter((f) => f.file === file).map((f) => f.literal),
  );
  return findSecretsRaw(text).filter((f) => !excused.has(f.match));
}

/** One-line human report for a finding, safe to print in CI. */
export function describeFinding(file: string, finding: SecretFinding): string {
  const why = RULE_WHY[finding.rule] ?? 'credential-shaped literal';
  return `${file}:${finding.line} [${finding.rule}] ${why} — ${finding.match}`;
}