/**
 * Henry Savings Engine — tracks AI spend vs free/local alternatives
 * and surfaces cost-saving opportunities in real time.
 */

const SAVINGS_KEY = 'henry:savings_log';
const MONTHLY_BUDGET_KEY = 'henry:monthly_budget';

export interface SavingsEntry {
  id: string;
  date: string;
  provider: string;
  model: string;
  cost: number;
  // What it would have cost on the most expensive equivalent
  benchmarkCost: number;
  savedAmount: number;
  tokens: number;
}

export interface MonthlySavingsSummary {
  month: string;
  totalSpent: number;
  totalBenchmark: number;
  totalSaved: number;
  freeTokens: number;      // tokens via Ollama (cost = 0)
  groqFreeTokens: number;  // tokens via Groq free tier
}

// Benchmark = what GPT-4o would have cost for same tokens
const GPT4O_IN  = 2.5   / 1_000_000;  // $ per token
const GPT4O_OUT = 10.0  / 1_000_000;

const FREE_PROVIDERS = ['ollama'];
const GROQ_PROVIDER  = 'groq';

function load(): SavingsEntry[] {
  try { return JSON.parse(localStorage.getItem(SAVINGS_KEY) || '[]'); } catch { return []; }
}
function save(entries: SavingsEntry[]) {
  try { localStorage.setItem(SAVINGS_KEY, JSON.stringify(entries.slice(0, 1000))); } catch {}
}

/**
 * Record a completed AI call and compute savings vs GPT-4o benchmark.
 */
export function recordUsage(params: {
  provider: string;
  model: string;
  cost: number;
  tokensIn: number;
  tokensOut: number;
}): SavingsEntry {
  const benchmark = params.tokensIn * GPT4O_IN + params.tokensOut * GPT4O_OUT;
  const saved = Math.max(0, benchmark - params.cost);
  const entry: SavingsEntry = {
    id: `sav_${Date.now()}`,
    date: new Date().toISOString(),
    provider: params.provider,
    model: params.model,
    cost: params.cost,
    benchmarkCost: benchmark,
    savedAmount: saved,
    tokens: params.tokensIn + params.tokensOut,
  };
  const all = load();
  all.unshift(entry);
  save(all);
  return entry;
}

/**
 * Get monthly summary of spend vs savings.
 */
export function getMonthlySummary(month?: string): MonthlySavingsSummary {
  const m = month || new Date().toISOString().slice(0, 7);
  const entries = load().filter(e => e.date.startsWith(m));

  return {
    month: m,
    totalSpent:     entries.reduce((s, e) => s + e.cost, 0),
    totalBenchmark: entries.reduce((s, e) => s + e.benchmarkCost, 0),
    totalSaved:     entries.reduce((s, e) => s + e.savedAmount, 0),
    freeTokens:     entries.filter(e => FREE_PROVIDERS.includes(e.provider)).reduce((s, e) => s + e.tokens, 0),
    groqFreeTokens: entries.filter(e => e.provider === GROQ_PROVIDER).reduce((s, e) => s + e.tokens, 0),
  };
}

/**
 * Get running total savings all time.
 */
export function getAllTimeSavings(): { totalSaved: number; totalSpent: number; totalBenchmark: number } {
  const entries = load();
  return {
    totalSaved:     entries.reduce((s, e) => s + e.savedAmount, 0),
    totalSpent:     entries.reduce((s, e) => s + e.cost, 0),
    totalBenchmark: entries.reduce((s, e) => s + e.benchmarkCost, 0),
  };
}

/**
 * Get the monthly budget cap (user-configurable).
 */
export function getMonthlyBudget(): number {
  try { return parseFloat(localStorage.getItem(MONTHLY_BUDGET_KEY) || '20') || 20; } catch { return 20; }
}

export function setMonthlyBudget(budget: number): void {
  try { localStorage.setItem(MONTHLY_BUDGET_KEY, String(budget)); } catch {}
}

/**
 * Check if we're approaching the monthly budget.
 * Returns: null (under 75%), 'warning' (75-95%), 'critical' (>95%)
 */
export function getBudgetAlert(): null | 'warning' | 'critical' {
  const summary = getMonthlySummary();
  const budget = getMonthlyBudget();
  const pct = summary.totalSpent / budget;
  if (pct > 0.95) return 'critical';
  if (pct > 0.75) return 'warning';
  return null;
}

/**
 * Smart suggestion: given current spend pattern, recommend cheaper alternatives.
 */
export function getCostSuggestion(): string | null {
  const entries = load().slice(0, 50);
  if (!entries.length) return null;
  
  const openaiCost  = entries.filter(e => e.provider === 'openai').reduce((s, e) => s + e.cost, 0);
  const anthropicCost = entries.filter(e => e.provider === 'anthropic').reduce((s, e) => s + e.cost, 0);
  const groqCost    = entries.filter(e => e.provider === 'groq').reduce((s, e) => s + e.cost, 0);
  const ollamaCost  = entries.filter(e => e.provider === 'ollama').reduce((s, e) => s + e.cost, 0);
  
  if (openaiCost > 1 && groqCost === 0) {
    return "You're spending on OpenAI — Groq is free and handles most everyday tasks just as well.";
  }
  if (anthropicCost > 2) {
    return "Claude is great for long documents, but for quick chats Groq's Llama is free and very fast.";
  }
  if (ollamaCost === 0 && (openaiCost + anthropicCost + groqCost) > 0.5) {
    return "Ollama lets you run AI completely free and offline. Consider pulling llama3.1:8b for routine tasks.";
  }
  return null;
}
