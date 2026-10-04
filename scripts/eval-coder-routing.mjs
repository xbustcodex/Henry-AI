// Eval script — run with: node scripts/eval-coder-routing.mjs
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

function classifyIntent(message) {
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

const tests = [
  { input: 'write a debounce function in TS', expected: 'code', label: 'explicit code request' },
  { input: 'why is my function returning undefined?', expected: 'code', label: 'debug question' },
  { input: 'help me fix this bug in app.tsx', expected: 'code', label: 'file ext + verb' },
  { input: '```js\nconst x = 1;\n```', expected: 'code', label: 'code fence' },
  { input: 'refactor this async callback to use await', expected: 'code', label: 'code verbs x2' },
  { input: 'npm run build is throwing exit code 1', expected: 'code', label: 'shell + error' },
  { input: 'how do i implement a binary search tree', expected: 'code', label: 'how-to code' },
  { input: 'can you debug this stack trace', expected: 'code', label: 'debug ask' },
  { input: 'what does this code do? function foo()', expected: 'code', label: 'code question' },
  { input: 'fix the merge conflict in main.ts', expected: 'code', label: 'code verb + ext' },
  { input: 'whats the weather like today', expected: 'chat', label: 'casual chat' },
  { input: 'tell me about napoleon', expected: 'chat', label: 'history' },
  { input: 'recommend a good book', expected: 'chat', label: 'recommendation' },
  { input: 'how are you doing', expected: 'chat', label: 'greeting' },
  { input: 'what time is it in tokyo', expected: 'chat', label: 'time zone' },
  { input: 'help me plan a vacation', expected: 'chat', label: 'planning' },
  { input: 'whats a good recipe for pasta', expected: 'chat', label: 'recipe' },
  { input: 'explain quantum physics simply', expected: 'chat', label: 'explainer' },
  { input: 'i had a hard day at work', expected: 'chat', label: 'venting' },
  { input: 'what should i name my cat', expected: 'chat', label: 'naming' },
];

let passed = 0, failed = 0;
console.log('\n=== Coder Routing Eval ===\n');
for (const t of tests) {
  const actual = classifyIntent(t.input);
  const ok = actual === t.expected;
  if (ok) { passed++; console.log('  \u2713 ' + t.label.padEnd(28) + ' \u2192 ' + actual); }
  else { failed++; console.log('  \u2717 ' + t.label.padEnd(28) + ' \u2192 expected ' + t.expected + ', got ' + actual); }
}
console.log('\n' + passed + '/' + tests.length + ' passed' + (failed ? ' (' + failed + ' FAILED)' : ' - all green!'));
if (failed) process.exit(1);
