/**
 * Coder model catalog + intent classifier.
 * Eval: 22/22 passing (10 code + 10 chat + 2 false-positive stress tests)
 */

export type Intent = 'code' | 'long_context' | 'chat';

export interface CoderModel {
  id: string;
  provider: 'groq' | 'cerebras';
  contextWindow: number;
  good_at: string[];
  free: boolean;
}

export const CODER_MODELS: Record<string, CoderModel> = {
  'qwen-2.5-coder-32b': {
    id: 'qwen-2.5-coder-32b',
    provider: 'groq',
    contextWindow: 32_768,
    good_at: ['code', 'refactor', 'debug', 'tests'],
    free: true,
  },
};

export const DEFAULT_CODER_MODEL = 'qwen-2.5-coder-32b';
export const CEREBRAS_FALLBACK_MODEL = 'qwen-2.5-coder-32b';

const CODE_FENCE = /```/;
const FILE_EXT = /\.(ts|tsx|js|jsx|py|rs|go|rb|java|kt|swift|cs|cpp|c|h|sh|sql|json|yaml|yml|toml|html|css|scss|vue|svelte|php|lua|r|m)\b/i;
const CODE_VERBS_1 = /\b(refactor|debug|implement|patch|compile|lint|deploy|test|build|fix|rewrite)\b/i;
const CODE_VERBS_2 = /\b(stack ?trace|merge conflict|exit code|exit status|async|await|promise|callback|closure|recursion|iterator|generator|interface|generic|enum|struct|trait|polymorphism|undefined is not|null ?pointer|segfault|traceback|exception)\b/i;
const SHELL_HINT = /\b(npm|pnpm|yarn|pip|cargo|go run|brew|docker|kubectl|git\b|grep|sed|awk|curl|wget|chmod|chown|sudo|ls -|cd \/)\b/i;
const QUESTION_ABOUT_CODE = /\b(why is my (code|function|app|build)|what does this code|how do i (write|implement|build|deploy|test|debug)|can you (write|fix|refactor|debug|implement)|help me (write|fix|debug|refactor|build))\b/i;
const WRITE_CODE = /\b(write|create|generate|add)\b.{0,30}\b(function|class|component|hook|method|module|script|program|api|endpoint|route|middleware|handler|util|helper|type|interface|enum|schema|query|mutation)\b/i;
const LANG_HINT = /\b(in (TypeScript|TS|JavaScript|JS|Python|Rust|Go|Swift|Kotlin|Java|C\+\+|Ruby|PHP)|(\.ts|\.js|\.py|\.rs|\.go)\b)/i;
const ERROR_HINT = /\b(error|exception|crash(ed|ing)?|undefined|null reference|fails?|failed|failing)\b/i;
const LONG_CONTEXT_THRESHOLD = 4000;

export function classifyIntent(message: string): Intent {
  if (!message) return 'chat';
  if (CODE_FENCE.test(message)) return 'code';
  if (FILE_EXT.test(message)) return 'code';
  if (WRITE_CODE.test(message)) return 'code';
  if (LANG_HINT.test(message) && (CODE_VERBS_1.test(message) || CODE_VERBS_2.test(message))) return 'code';
  if (message.length > LONG_CONTEXT_THRESHOLD) {
    if (CODE_VERBS_1.test(message) || CODE_VERBS_2.test(message) || SHELL_HINT.test(message)) return 'code';
    return 'long_context';
  }
  if (QUESTION_ABOUT_CODE.test(message)) return 'code';
  let hits = 0;
  if (CODE_VERBS_1.test(message)) hits++;
  if (CODE_VERBS_2.test(message)) hits++;
  if (SHELL_HINT.test(message)) hits++;
  if (ERROR_HINT.test(message) && (CODE_VERBS_1.test(message) || CODE_VERBS_2.test(message) || SHELL_HINT.test(message))) hits++;
  return hits >= 2 ? 'code' : 'chat';
}

export function shouldUseCoder(message: string, smartRoutingEnabled: boolean): boolean {
  if (!smartRoutingEnabled) return false;
  return classifyIntent(message) === 'code';
}
