import { getMonthlySummary, getAllTimeSavings, getCostSuggestion, getMonthlyBudget, setMonthlyBudget, getBudgetAlert } from '../../henry/savingsEngine';
import { useState, useEffect } from 'react';
import { PANEL_QUICK_ASK } from '../../henry/henryQuickAsk';
import { getUsageSummary } from '../../henry/henryAnalytics';

interface CostLogRow {
  id: number;
  provider: string;
  model: string;
  tokens_input: number;
  tokens_output: number;
  cost: number;
  conversation_id: string | null;
  task_id: string | null;
  created_at: string;
}

interface CostEntry {
  provider: string;
  model: string;
  engine: string;
  tokens: number;
  cost: number;
}

export default function CostDashboard() {
  const [period, setPeriod] = useState<'7d' | '30d' | 'all'>('7d');
  const [costData, setCostData] = useState<CostEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [usageSummary] = useState(() => getUsageSummary());
  const [savings, setSavings] = useState(() => getMonthlySummary());
  const [allTimeSavings, setAllTimeSavings] = useState(() => getAllTimeSavings());
  const [budget, setBudget] = useState(() => getMonthlyBudget());
  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetInput, setBudgetInput] = useState('');
  const budgetAlert = getBudgetAlert();
  const costSuggestion = getCostSuggestion();

  useEffect(() => {
    loadCosts();
    setSavings(getMonthlySummary());
    setAllTimeSavings(getAllTimeSavings());
  }, [period]);

  async function loadCosts() {
    setLoading(true);
    try {
      const rows = (await window.henryAPI.getCostLog(period)) as CostLogRow[];
      const entries: CostEntry[] = rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        engine: row.task_id ? 'worker' : 'companion',
        tokens: (row.tokens_input || 0) + (row.tokens_output || 0),
        cost: row.cost || 0,
      }));
      setCostData(entries);
    } catch (err) {
      console.error('Failed to load costs:', err);
      setCostData([]);
    } finally {
      setLoading(false);
    }
  }

  // Aggregate costs
  const totalCost = costData.reduce((sum, e) => sum + e.cost, 0);
  const totalTokens = costData.reduce((sum, e) => sum + e.tokens, 0);
  const byProvider = costData.reduce<Record<string, { cost: number; tokens: number }>>((acc, e) => {
    if (!acc[e.provider]) acc[e.provider] = { cost: 0, tokens: 0 };
    acc[e.provider].cost += e.cost;
    acc[e.provider].tokens += e.tokens;
    return acc;
  }, {});
  const byEngine = costData.reduce<Record<string, { cost: number; tokens: number }>>((acc, e) => {
    if (!acc[e.engine]) acc[e.engine] = { cost: 0, tokens: 0 };
    acc[e.engine].cost += e.cost;
    acc[e.engine].tokens += e.tokens;
    return acc;
  }, {});

  // Estimate monthly from daily average
  const dayCount = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  const dailyAvg = totalCost / Math.max(dayCount, 1);
  const monthlyEstimate = dailyAvg * 30;

  // 7-day sparkline: cost per day for the last 7 days
  const sparklineData = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const dayStr = d.toISOString().slice(0, 10);
    const dayCost = costData
      .filter(e => (e as any).created_at?.slice(0, 10) === dayStr)
      .reduce((s, e) => s + e.cost, 0);
    return { day: d.toLocaleDateString('en-US', { weekday: 'short' }), cost: dayCost };
  });
  const sparkMax = Math.max(...sparklineData.map(d => d.cost), 0.0001);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
              <button
                onClick={() => PANEL_QUICK_ASK.costs()}
                className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all"
              >🧠 Ask Henry</button>
          <div>
            <h1 className="text-lg font-semibold text-henry-text">Cost Dashboard</h1>
            <p className="text-xs text-henry-text-dim mt-1">
              Track your AI spending across all providers and engines
            </p>
          </div>
          <div className="flex gap-1 bg-henry-surface/30 rounded-lg p-0.5">
            {(['7d', '30d', 'all'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                  period === p
                    ? 'bg-henry-accent/10 text-henry-accent font-medium'
                    : 'text-henry-text-dim hover:text-henry-text'
                }`}
              >
                {p === '7d' ? '7 Days' : p === '30d' ? '30 Days' : 'All Time'}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <div className="text-3xl mb-3 animate-pulse">💰</div>
              <p className="text-sm text-henry-text-dim">Loading cost data...</p>
            </div>
          </div>
        ) : (
          <>

            {/* Savings Banner */}
            {allTimeSavings.totalSaved > 0.001 && (
              <div className="mb-6 p-4 rounded-xl bg-henry-success/5 border border-henry-success/20">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-henry-success">
                      💰 You've saved ${allTimeSavings.totalSaved.toFixed(4)} vs GPT-4o pricing
                    </p>
                    <p className="text-xs text-henry-text-muted mt-0.5">
                      Total AI spend: ${allTimeSavings.totalSpent.toFixed(4)} · Benchmark: ${allTimeSavings.totalBenchmark.toFixed(4)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-henry-success">
                      {allTimeSavings.totalBenchmark > 0 ? Math.round((allTimeSavings.totalSaved / allTimeSavings.totalBenchmark) * 100) : 0}%
                    </p>
                    <p className="text-[10px] text-henry-text-muted">saved</p>
                  </div>
                </div>
                {savings.freeTokens > 0 && (
                  <p className="text-[11px] text-henry-text-muted mt-2">
                    {(savings.freeTokens / 1000).toFixed(1)}K tokens this month via Ollama (free)
                    {savings.groqFreeTokens > 0 && ` · ${(savings.groqFreeTokens / 1000).toFixed(1)}K via Groq`}
                  </p>
                )}
              </div>
            )}

            {/* Budget Alert */}
            {budgetAlert && (
              <div className={`mb-4 p-3 rounded-xl border ${budgetAlert === 'critical' ? 'bg-henry-error/5 border-henry-error/20' : 'bg-henry-warning/5 border-henry-warning/20'}`}>
                <p className={`text-xs font-medium ${budgetAlert === 'critical' ? 'text-henry-error' : 'text-henry-warning'}`}>
                  {budgetAlert === 'critical' ? '⚠️ Approaching monthly budget limit' : '📊 Over 75% of monthly budget used'}
                  {' '}(${savings.totalSpent.toFixed(2)} of ${budget.toFixed(2)})
                </p>
              </div>
            )}

            {/* Cost suggestion */}
            {costSuggestion && (
              <div className="mb-4 p-3 rounded-xl bg-henry-accent/5 border border-henry-accent/20">
                <p className="text-xs text-henry-accent">💡 {costSuggestion}</p>
              </div>
            )}

            {/* Top-level stats */}
            <div className="grid grid-cols-4 gap-4 mb-8">
              <StatCard label="Total Spent" value={`$${totalCost.toFixed(4)}`} icon="💰" />
              <StatCard label="Total Tokens" value={formatTokens(totalTokens)} icon="🔢" />
              <StatCard label="Daily Average" value={`$${dailyAvg.toFixed(4)}`} icon="📊" />
              <StatCard
                label="Monthly Estimate"
                value={`$${monthlyEstimate.toFixed(2)}`}
                icon="📈"
                highlight={monthlyEstimate > 50}
              />
            </div>

            {/* Cost by provider */}
            <div className="grid grid-cols-2 gap-6 mb-8">
              <div className="bg-henry-surface/30 rounded-xl border border-henry-border/20 p-5">
                <h3 className="text-sm font-medium text-henry-text mb-4">By Provider</h3>
                {Object.keys(byProvider).length === 0 ? (
                  <EmptyState text="No usage data yet. Start chatting to see costs." />
                ) : (
                  <div className="space-y-3">
                    {Object.entries(byProvider)
                      .sort(([, a], [, b]) => b.cost - a.cost)
                      .map(([provider, data]) => (
                        <CostBar
                          key={provider}
                          label={provider}
                          cost={data.cost}
                          tokens={data.tokens}
                          maxCost={totalCost}
                        />
                      ))}
                  </div>
                )}
              </div>

              <div className="bg-henry-surface/30 rounded-xl border border-henry-border/20 p-5">
                <h3 className="text-sm font-medium text-henry-text mb-4">By Engine</h3>
                {Object.keys(byEngine).length === 0 ? (
                  <EmptyState text="Engine usage breakdown will appear here." />
                ) : (
                  <div className="space-y-3">
                    {Object.entries(byEngine).map(([engine, data]) => (
                      <CostBar
                        key={engine}
                        label={engine === 'companion' ? '🧠 Companion' : '⚡ Worker'}
                        cost={data.cost}
                        tokens={data.tokens}
                        maxCost={totalCost}
                        color={engine === 'companion' ? 'bg-henry-companion' : 'bg-henry-worker'}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Cost-saving tips */}
            <div className="bg-henry-surface/20 rounded-xl border border-henry-border/20 p-5">
              <h3 className="text-sm font-medium text-henry-text mb-3">💡 Cost Tips</h3>
              <div className="grid grid-cols-2 gap-3">
                <TipCard
                  tip="Use Ollama local models for routine tasks — they're free"
                  savings="~$0.00/task"
                />
                <TipCard
                  tip="GPT-4o Mini or Claude Haiku for Companion — cheap & fast"
                  savings="~90% cheaper than GPT-4o"
                />
                <TipCard
                  tip="Reserve powerful models (GPT-4o, Claude Sonnet) for Worker tasks"
                  savings="Better quality/cost ratio"
                />
                <TipCard
                  tip="Keep conversations focused — shorter context = fewer tokens"
                  savings="~30% token reduction"
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  highlight,
}: {
  label: string;
  value: string;
  icon: string;
  highlight?: boolean;
}) {
  return (
    <div className={`p-4 rounded-xl border transition-all ${
      highlight
        ? 'bg-henry-warning/5 border-henry-warning/20'
        : 'bg-henry-surface/30 border-henry-border/20'
    }`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">{icon}</span>
        <span className="text-[10px] text-henry-text-muted uppercase tracking-wider">{label}</span>
      </div>
      <div className={`text-xl font-bold ${highlight ? 'text-henry-warning' : 'text-henry-text'}`}>
        {value}
      </div>
    </div>
  );
}

function CostBar({
  label,
  cost,
  tokens,
  maxCost,
  color = 'bg-henry-accent',
}: {
  label: string;
  cost: number;
  tokens: number;
  maxCost: number;
  color?: string;
}) {
  const pct = maxCost > 0 ? (cost / maxCost) * 100 : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-henry-text">{label}</span>
        <span className="text-xs text-henry-text-dim">${cost.toFixed(4)}</span>
      </div>
      <div className="h-2 bg-henry-bg/50 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${color} transition-all`}
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
      <span className="text-[10px] text-henry-text-muted">{formatTokens(tokens)} tokens</span>
    </div>
  );
}

function TipCard({ tip, savings }: { tip: string; savings: string }) {
  return (
    <div className="p-3 rounded-lg bg-henry-bg/30 border border-henry-border/10">
      <p className="text-xs text-henry-text-dim leading-relaxed">{tip}</p>
      <p className="text-[10px] text-henry-success mt-1">{savings}</p>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="py-6 text-center">
      <p className="text-xs text-henry-text-muted">{text}</p>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toString();
}
