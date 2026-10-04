/**
 * Henry Memory Pipeline v2
 *
 * Uses a fast Groq call to extract real facts from conversations.
 * Stores them structured. Surfaces them in every future conversation.
 *
 * Facts look like:
 *   "Name: Topher Cook"
 *   "Business: MixedMakerShop — web design + 3D printing"
 *   "Family: large family, person of faith"
 *   "Project: Henry AI — personal AI assistant"
 *   "Preference: concise responses, direct answers"
 *   "Goal: publish Henry AI as a product"
 */

export interface MemoryFact {
  id: string;
  fact: string;
  category: 'person' | 'business' | 'project' | 'preference' | 'goal' | 'relationship' | 'faith' | 'general';
  importance: 1 | 2 | 3;
  source: 'extracted' | 'manual' | 'mobile';
  createdAt: string;
}

// ── Local fact store (localStorage, fast) ─────────────────────────────────
const FACTS_KEY = 'henry:memory:facts_v2';

function loadFacts(): MemoryFact[] {
  try { return JSON.parse(localStorage.getItem(FACTS_KEY) || '[]'); }
  catch { return []; }
}

function saveFacts(facts: MemoryFact[]): void {
  try { localStorage.setItem(FACTS_KEY, JSON.stringify(facts.slice(0, 200))); }
  catch { /* ignore */ }
}

// ── Deduplication ──────────────────────────────────────────────────────────
function similarity(a: string, b: string): number {
  const aw = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const bw = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const inter = [...aw].filter(w => bw.has(w)).length;
  const union = new Set([...aw, ...bw]).size;
  return union === 0 ? 0 : inter / union;
}

export function addFacts(newFacts: MemoryFact[]): number {
  const existing = loadFacts();
  let added = 0;

  for (const fact of newFacts) {
    const isDupe = existing.some(e => similarity(e.fact, fact.fact) > 0.75);
    if (!isDupe) {
      existing.push(fact);
      added++;
    }
  }

  if (added > 0) saveFacts(existing);
  return added;
}

// ── Build memory context string for system prompt ──────────────────────────
export function buildMemoryContext(): string {
  const facts = loadFacts();
  if (facts.length === 0) return '';

  // Sort by importance then recency
  const sorted = [...facts].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const top = sorted.slice(0, 12);
  return 'What Henry knows about Topher:\n' + top.map(f => '• ' + f.fact).join('\n');
}

// ── Extract facts from conversation using Groq (fast 8b model) ────────────
export async function extractFactsFromConversation(
  messages: { role: string; content: string }[],
  apiKey: string
): Promise<MemoryFact[]> {
  if (!apiKey || messages.length < 2) return [];

  // Only extract from substantial exchanges
  const userMessages = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
  if (userMessages.length < 100) return [];

  const prompt = `Extract factual information about the user from this conversation. 
Return ONLY a JSON array of facts. Each fact must be structured like "Category: fact".
Only include real facts stated by the user — name, location, business, projects, family, preferences, goals, beliefs.
Never include questions, requests, or AI responses.
Never include passwords, emails, or sensitive data.
Return [] if no clear facts are stated.

Conversation:
${messages.slice(-6).map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n')}

Return ONLY valid JSON like: [{"fact":"Name: Topher","category":"person","importance":3},...]`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400,
        temperature: 0.1,
        stream: false,
      }),
    });

    if (!res.ok) return [];
    const data = await res.json() as { choices: { message: { content: string } }[] };
    const text = data.choices?.[0]?.message?.content || '[]';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean) as Array<{ fact: string; category: string; importance: number }>;

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(f => f.fact && typeof f.fact === 'string' && f.fact.includes(':'))
      .filter(f => !f.fact.toLowerCase().includes('password') && !f.fact.includes('@'))
      .map(f => ({
        id: crypto.randomUUID(),
        fact: f.fact.trim(),
        category: (f.category || 'general') as MemoryFact['category'],
        importance: (Math.min(3, Math.max(1, f.importance || 2))) as 1 | 2 | 3,
        source: 'extracted' as const,
        createdAt: new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

// ── Persist to SQLite via IPC ──────────────────────────────────────────────
export async function persistFactsToDb(facts: MemoryFact[]): Promise<void> {
  const api = (window as any).henryAPI;
  if (!api?.saveFact) return;

  for (const fact of facts) {
    try {
      await api.saveFact({
        fact: fact.fact,
        category: fact.category,
        importance: fact.importance,
      });
    } catch { /* non-critical */ }
  }
}

// ── Manual fact saving ─────────────────────────────────────────────────────
export function saveManualFact(text: string, category: MemoryFact['category'] = 'general'): void {
  const fact: MemoryFact = {
    id: crypto.randomUUID(),
    fact: text,
    category,
    importance: 3,
    source: 'manual',
    createdAt: new Date().toISOString(),
  };
  addFacts([fact]);
}

// ── Get all facts for display ──────────────────────────────────────────────
export function getAllFacts(): MemoryFact[] {
  return loadFacts().sort((a, b) => b.importance - a.importance);
}

export function deleteFact(id: string): void {
  const facts = loadFacts().filter(f => f.id !== id);
  saveFacts(facts);
}
