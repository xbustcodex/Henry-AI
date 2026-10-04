import { useState, useEffect } from 'react';
import { sendToHenry } from '../../actions/store/chatBridgeStore';
import { useStore } from '../../store';

interface Transaction { id:string; type:'income'|'expense'; amount:number; category:string; description?:string; date:string; created_at:string }
interface Summary { income:number; expenses:number; net:number; breakdown:{type:string;total:number;category:string}[] }

const getApi = () => (window as any).henryAPI as any;

const EXPENSE_CATS = ['Housing','Food','Transport','Health','Business','Marketing','Software','Entertainment','Utilities','Shopping','Other'];
const INCOME_CATS  = ['Client Work','Product Sales','Freelance','Investments','Grants','Affiliate','Other'];

function fmt(n:number){ return '$'+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function monthKey(d=new Date()){ return d.toISOString().slice(0,7); }
function monthLabel(k:string){ const [y,m]=k.split('-'); return new Date(+y,+m-1,1).toLocaleDateString('en-US',{month:'long',year:'numeric'}); }

export default function FinancePanel(){
  const { setCurrentView } = useStore();
  const [month, setMonth] = useState(monthKey());
  const [txns, setTxns]   = useState<Transaction[]>([]);
  const [plBusy, setPlBusy] = useState(false);
  const [plResult, setPlResult] = useState('');
  const [showPL, setShowPL] = useState(false);
  const [summary, setSummary] = useState<Summary>({income:0,expenses:0,net:0,breakdown:[]});
  const [form, setForm]   = useState({type:'expense' as 'income'|'expense', amount:'', category:EXPENSE_CATS[1], description:'', date:new Date().toISOString().slice(0,10)});
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [recurrings, setRecurrings] = useState<{id:string;type:string;amount:number;category:string;description?:string;day_of_month:number}[]>([]);
  const [showRecurring, setShowRecurring] = useState(false);
  const [newRecurring, setNewRecurring] = useState({type:'expense' as 'income'|'expense', amount:'', category:EXPENSE_CATS[1], description:'', day:1});
  const [trends, setTrends] = useState<{month:string;income:number;expenses:number;net:number}[]>([]);

  async function load(){
    setLoading(true);
    const months6 = Array.from({length:6},(_,i)=>{ const d=new Date(); d.setMonth(d.getMonth()-i); return monthKey(d); }).reverse();
    const api = getApi(); if (!api) { setLoading(false); return; }
    const [list, sum, ...trendData] = await Promise.all([
      api.financeList?.(month) ?? [],
      api.financeSummary?.(month) ?? {income:0,expenses:0,net:0,breakdown:[]},
      ...months6.map(m => api.financeSummary?.(m) ?? {income:0,expenses:0,net:0,breakdown:[]}),
    ]);
    setTrends(months6.map((m,i) => ({month:m,...(trendData[i] as any)})));
    setTxns(list as Transaction[]);
    setSummary(sum as Summary);
    setLoading(false);
  }

  useEffect(()=>{ void load(); },[month]);
  useEffect(()=>{
    const a = getApi(); if (!a) return;
    a.financeRecurringList?.().then((r:any)=>setRecurrings(r||[])).catch(()=>{});
    a.financeRecurringAutopost?.().then((r:any)=>{ if(r?.posted>0) void load(); }).catch(()=>{});
  },[]);

  async function handleAdd(e:React.FormEvent){
    e.preventDefault();
    const amt = parseFloat(form.amount);
    if(!amt || amt<=0) return;
    await getApi()?.financeAdd({ id:crypto.randomUUID(), type:form.type, amount:amt, category:form.category, description:form.description||null, date:form.date });
    setForm(f=>({...f, amount:'', description:''}));
    setAdding(false);
    await load();
  }

  async function handleDelete(id:string){
    await getApi()?.financeDelete(id);
    await load();
  }

  async function generatePLReport() {
    if (plBusy) return;
    setPlBusy(true); setShowPL(true); setPlResult('');
    const income = txns.filter(t => t.type === 'income').reduce((a, t) => a + t.amount, 0);
    const expenses = txns.filter(t => t.type === 'expense').reduce((a, t) => a + t.amount, 0);
    const net = income - expenses;
    const cats = txns.reduce((acc: Record<string,number>, t) => {
      acc[t.category] = (acc[t.category] || 0) + t.amount; return acc;
    }, {});
    const topCats = Object.entries(cats).sort((a,b) => b[1]-a[1]).slice(0,5)
      .map(([k,v]) => `${k}: $${v.toFixed(0)}`).join(', ');
    const ownerName = localStorage.getItem('henry:owner_name') || 'you';
    const prompt = `${ownerName}'s finances for ${month}:
Income: $${income.toFixed(2)}
Expenses: $${expenses.toFixed(2)}
Net: $${net.toFixed(2)}
Top categories: ${topCats}

Write a brief P&L summary in 3 sentences: how the month went, biggest expense area, and one actionable tip for next month.`;
    const deviceId = (() => { let id = localStorage.getItem('henry:device_id'); if (!id) { id = crypto.randomUUID(); localStorage.setItem('henry:device_id', id); } return id; })();
    try {
      const r = await fetch('https://henry-proxy.henryai.workers.dev/v1/chat', {
        signal: AbortSignal.timeout(25000),
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Henry-Device': deviceId },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 250, stream: false }),
      });
      const d = await r.json() as any;
      setPlResult(d?.choices?.[0]?.message?.content || 'No response');
    } catch { setPlResult('Could not reach Henry AI.'); }
    setPlBusy(false);
  }

  function exportCSV() {
    if (!txns.length) return;
    const header = 'Date,Type,Category,Description,Amount';
    const rows = txns.map(t => `${t.date},${t.type},${t.category},"${(t.description||'').replace(/"/g,'""')}",${t.type==='income'?'+':'−'}${t.amount.toFixed(2)}`);
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `henry-finance-${month}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const [insight, setInsight] = useState('');
  const [budgets, setBudgets] = useState<Record<string,number>>(() => {
    try { return JSON.parse(localStorage.getItem('henry:budgets') || '{}'); } catch { return {}; }
  });
  const [showBudgets, setShowBudgets] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const [insightBusy, setInsightBusy] = useState(false);

  function saveBudget(category: string, limit: number) {
    const updated = { ...budgets, [category]: limit };
    setBudgets(updated);
    localStorage.setItem('henry:budgets', JSON.stringify(updated));
  }

  async function importCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportMsg('');
    const text = await file.text();
    const lines = text.split('\n').filter(Boolean);
    const header = lines[0].toLowerCase();
    // Auto-detect columns: date, description, amount, type
    const cols = header.split(',').map(h => h.replace(/"/g,'').trim());
    const dateIdx = cols.findIndex(c => c.includes('date') || c.includes('posted'));
    const descIdx = cols.findIndex(c => c.includes('desc') || c.includes('memo') || c.includes('payee') || c.includes('detail'));
    const amtIdx = cols.findIndex(c => c.includes('amount') || c.includes('debit') || c.includes('credit'));
    if (dateIdx < 0 || amtIdx < 0) {
      setImportMsg('Could not detect columns. Need Date, Description, Amount columns.');
      setImporting(false);
      return;
    }
    let imported = 0;
    const api2 = (window as any).henryAPI;
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',').map(p => p.replace(/^"|"$/g,'').trim());
      if (parts.length <= amtIdx) continue;
      const rawAmt = parseFloat(parts[amtIdx]?.replace(/[$,]/g,'') || '0');
      if (isNaN(rawAmt) || rawAmt === 0) continue;
      const amount = Math.abs(rawAmt);
      const type = rawAmt < 0 ? 'expense' : 'income';
      const description = descIdx >= 0 ? parts[descIdx] : '';
      const rawDate = (parts[dateIdx] || '').trim().replace(/"/g, '');
      let date = '';
      try {
        if (rawDate.includes('/')) {
          const pts = rawDate.split('/');
          if (pts.length === 3) {
            const yr = pts[2].length === 2 ? '20' + pts[2] : pts[2];
            date = yr + '-' + pts[0].padStart(2,'0') + '-' + pts[1].padStart(2,'0');
          }
        } else if (rawDate.includes('-')) {
          date = rawDate.slice(0, 10);
        }
        // Validate the resulting date
        if (!date || isNaN(new Date(date).getTime())) {
          date = new Date().toISOString().slice(0, 10); // fallback to today
        }
      } catch { date = new Date().toISOString().slice(0, 10); }
      try {
        // Duplicate check: skip if same date+amount+description already exists
        const existing = txns.find(t =>
          t.date === date && Math.abs(t.amount - amount) < 0.01 &&
          t.description?.slice(0,40) === description.slice(0,40)
        );
        if (existing) continue;
        await api2.financeCreate?.({
          id: crypto.randomUUID(),
          date, description: description.slice(0, 200), amount, type,
          category: type === 'income' ? 'income' : 'other',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        imported++;
      } catch { /* skip bad rows */ }
    }
    setImportMsg(`✓ Imported ${imported} transactions`);
    setImporting(false);
    if (imported > 0) void load();
    e.target.value = '';
  }

  async function getInsight() {
    if (insightBusy || !summary) return;
    setInsightBusy(true); setInsight('');
    const ownerName = localStorage.getItem('henry:owner_name') || 'you';
    const topExp = expenseCats.slice(0,3).map(c=>c.category+' $'+c.total.toFixed(0)).join(', ');
    const prompt = ownerName + ' spent $' + summary.expenses.toFixed(0) + ' this month with income of $' + summary.income.toFixed(0) + '. Top expenses: ' + (topExp||'none yet') + '. Net: $' + (summary.income-summary.expenses).toFixed(0) + '. In 2-3 sentences give a helpful financial observation and one actionable tip. Be direct and practical.';
    const deviceId = (() => { let id = localStorage.getItem('henry:device_id'); if (!id) { id = crypto.randomUUID(); localStorage.setItem('henry:device_id', id); } return id; })();
    try {
      const r = await fetch('https://henry-proxy.henryai.workers.dev/v1/chat', {
        signal: AbortSignal.timeout(25000), method:'POST', headers:{'Content-Type':'application/json','X-Henry-Device':deviceId}, body:JSON.stringify({model:'llama-3.3-70b-versatile',messages:[{role:'user',content:prompt}],max_tokens:150,stream:false}) });
      const d = await r.json() as any;
      setInsight(d?.choices?.[0]?.message?.content || '');
    } catch { setInsight('Could not reach Henry AI.'); }
    setInsightBusy(false);
  }

  function askHenry(){
    const cats = summary.breakdown.filter(b=>b.type==='expense').sort((a,b)=>b.total-a.total).slice(0,4).map(b=>`${b.category}: ${fmt(b.total)}`).join(', ');
    sendToHenry(`My finances for ${monthLabel(month)}: Income ${fmt(summary.income)}, Expenses ${fmt(summary.expenses)}, Net ${fmt(summary.net)}. Top expenses: ${cats}. Give me a brief analysis and one practical suggestion.`);
    setCurrentView('chat');
  }

  const months = Array.from({length:6},(_,i)=>{ const d=new Date(); d.setMonth(d.getMonth()-i); return monthKey(d); });
  const expenseCats = summary.breakdown.filter(b=>b.type==='expense').sort((a,b)=>b.total-a.total);
  const cats = form.type==='expense'?EXPENSE_CATS:INCOME_CATS;

  return(
    <div className="flex flex-col h-full bg-henry-bg overflow-y-auto">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-henry-border/20 flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-lg font-bold text-henry-text">Finance</h1>
          <select value={month} onChange={e=>setMonth(e.target.value)} className="text-[11px] text-henry-text-muted bg-transparent border-none outline-none mt-0.5 cursor-pointer">
            {months.map(m=><option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowBudgets(b => !b)} className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-text transition-all">🎯 Budgets</button>
          <label className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-text transition-all cursor-pointer">
            {importing ? '⟳' : '↑ Import CSV'}
            <input type="file" accept=".csv,.txt" onChange={e => void importCSV(e)} className="hidden" />
          </label>
          <button onClick={exportCSV} disabled={!txns.length} className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-text disabled:opacity-30 transition-all">↓ CSV</button>
          <button onClick={() => void generatePLReport()} disabled={plBusy || !txns.length} className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-accent disabled:opacity-30 transition-all">⚡ P&L</button>
          <button onClick={() => void getInsight()} disabled={insightBusy || !summary} className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-accent disabled:opacity-30 transition-all">{insightBusy ? '⟳' : '💡 Insight'}</button>
          <button onClick={askHenry} className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-accent transition-all">Ask Henry</button>
          <button onClick={()=>setAdding(a=>!a)} className="text-[11px] px-4 py-1.5 rounded-lg bg-henry-accent text-white font-semibold hover:bg-henry-accent/80 transition-all">+ Add</button>
        </div>
      </div>

      <div className="px-6 py-4 space-y-5">
        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-3">
          {[
            {label:'Income', value:summary.income, color:'text-green-400', bg:'bg-green-400/5 border-green-400/20'},
            {label:'Expenses', value:summary.expenses, color:'text-red-400', bg:'bg-red-400/5 border-red-400/20'},
            {label:'Net', value:summary.net, color:summary.net>=0?'text-green-400':'text-red-400', bg:'bg-henry-surface/40 border-henry-border/20'},
          ].map(s=>(
            <div key={s.label} className={`rounded-xl border p-4 ${s.bg}`}>
              <p className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-1">{s.label}</p>
              <p className={`text-xl font-bold font-mono ${s.color}`}>{summary.net<0&&s.label==='Net'?'-':''}{fmt(s.value)}</p>
            </div>
          ))}
        </div>

        {/* Budget goals panel */}
        {showBudgets && expenseCats.length > 0 && (
          <div className="bg-henry-surface/40 border border-henry-border/15 rounded-2xl p-4 space-y-3">
            <p className="text-xs font-semibold text-henry-text">🎯 Monthly Budget Goals</p>
            <div className="space-y-2">
              {expenseCats.slice(0,6).map(cat => {
                const budget = budgets[cat.category] || 0;
                const pct = budget > 0 ? Math.min(100, Math.round((cat.total / budget) * 100)) : 0;
                return (
                  <div key={cat.category} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-henry-text capitalize">{cat.category}</span>
                      <div className="flex items-center gap-2">
                        <span className={pct >= 100 ? 'text-red-400 font-bold' : pct >= 80 ? 'text-yellow-400' : 'text-henry-text-muted'}>
                          ${cat.total.toFixed(0)} {budget > 0 ? `/ $${budget}` : ''}
                        </span>
                        <input type="number" value={budget || ''} placeholder="limit"
                          onChange={e => saveBudget(cat.category, Number(e.target.value))}
                          className="w-16 bg-henry-bg border border-henry-border/30 rounded px-1.5 py-0.5 text-xs text-henry-text outline-none focus:border-henry-accent/40" />
                      </div>
                    </div>
                    {budget > 0 && (
                      <div className="w-full bg-henry-surface rounded-full h-1.5">
                        <div className="h-1.5 rounded-full transition-all"
                          style={{ width: pct + '%', backgroundColor: pct >= 100 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#7c3aed' }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-henry-text-muted">Set monthly spending limits per category. Turns red when over budget.</p>
          </div>
        )}

        {importMsg && (
          <div className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs ${importMsg.startsWith('✓') ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'}`}>
            {importMsg}
            <button onClick={() => setImportMsg('')} className="ml-auto opacity-60 hover:opacity-100">✕</button>
          </div>
        )}

        {insight && (
          <div className="bg-henry-accent/8 border border-henry-accent/20 rounded-xl p-3 flex items-start gap-2">
            <span className="text-henry-accent text-sm flex-shrink-0">💡</span>
            <div className="flex-1">
              <p className="text-xs text-henry-text leading-relaxed">{insight}</p>
              <button onClick={() => setInsight('')} className="text-[10px] text-henry-text-muted hover:text-henry-text mt-1 transition-all">Dismiss</button>
            </div>
          </div>
        )}

        {/* 6-month trend bars */}
        {trends.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-3">6-Month Trend</p>
            <div className="flex items-end gap-2 h-24">
              {trends.map(t => {
                const maxVal = Math.max(...trends.map(x => Math.max(x.income, x.expenses)), 1);
                const incH = Math.round((t.income / maxVal) * 80);
                const expH = Math.round((t.expenses / maxVal) * 80);
                const mo = new Date(t.month + '-15').toLocaleDateString('en-US', {month:'short'});
                return (
                  <div key={t.month} className="flex-1 flex flex-col items-center gap-1">
                    <div className="flex items-end gap-0.5 h-20">
                      <div className="w-2 rounded-t bg-green-400/50 transition-all" style={{height: incH + 'px'}} title={'Income: $' + t.income.toFixed(0)} />
                      <div className="w-2 rounded-t bg-red-400/50 transition-all" style={{height: expH + 'px'}} title={'Expenses: $' + t.expenses.toFixed(0)} />
                    </div>
                    <span className="text-[9px] text-henry-text-muted">{mo}</span>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-4 mt-1">
              <span className="flex items-center gap-1 text-[10px] text-henry-text-muted"><span className="w-2 h-2 rounded bg-green-400/50 inline-block"/>Income</span>
              <span className="flex items-center gap-1 text-[10px] text-henry-text-muted"><span className="w-2 h-2 rounded bg-red-400/50 inline-block"/>Expenses</span>
              {(() => { const ytd = trends.reduce((a,t) => ({inc:a.inc+t.income, exp:a.exp+t.expenses}), {inc:0,exp:0}); return (
                <span className="ml-auto text-[10px] text-henry-text-muted">YTD net: <span className={ytd.inc-ytd.exp >= 0 ? 'text-green-400' : 'text-red-400'}>{fmt(ytd.inc-ytd.exp)}</span></span>
              ); })()}
            </div>
          </div>
        )}

        {/* Top expense categories */}
        {expenseCats.length>0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-2">Top Expenses</p>
            <div className="space-y-1.5">
              {expenseCats.slice(0,5).map(c=>{
                const pct = summary.expenses>0?Math.round((c.total/summary.expenses)*100):0;
                return(
                  <div key={c.category} className="flex items-center gap-3">
                    <span className="text-[11px] text-henry-text-muted w-28 truncate">{c.category}</span>
                    <div className="flex-1 bg-henry-surface rounded-full h-1.5">
                      <div className="bg-red-400/60 h-1.5 rounded-full transition-all" style={{width:pct+'%'}}/>
                    </div>
                    <span className="text-[11px] font-mono text-henry-text w-20 text-right">{fmt(c.total)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Add form */}
        {adding && (
          <form onSubmit={handleAdd} className="bg-henry-surface rounded-xl border border-henry-border/20 p-4 space-y-3">
            <div className="flex gap-2">
              {(['expense','income'] as const).map(t=>(
                <button type="button" key={t} onClick={()=>setForm(f=>({...f,type:t,category:t==='expense'?EXPENSE_CATS[1]:INCOME_CATS[0]}))}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${form.type===t?(t==='expense'?'bg-red-400/20 text-red-400 border border-red-400/30':'bg-green-400/20 text-green-400 border border-green-400/30'):'bg-henry-surface2 text-henry-text-muted border border-henry-border/20'}`}>
                  {t==='expense'?'− Expense':'+ Income'}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input type="number" step="0.01" placeholder="Amount" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))} required
                className="bg-henry-surface2 border border-henry-border/30 rounded-lg px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50" />
              <input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))}
                className="bg-henry-surface2 border border-henry-border/30 rounded-lg px-3 py-2 text-sm text-henry-text outline-none focus:border-henry-accent/50" />
              <select value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))}
                className="bg-henry-surface2 border border-henry-border/30 rounded-lg px-3 py-2 text-sm text-henry-text outline-none">
                {cats.map(c=><option key={c}>{c}</option>)}
              </select>
              <input placeholder="Description (optional)" value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))}
                className="bg-henry-surface2 border border-henry-border/30 rounded-lg px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none" />
            </div>
            <div className="flex gap-2">
              <button type="submit" className="px-4 py-2 rounded-lg bg-henry-accent text-white text-sm font-semibold hover:bg-henry-accent/80 transition-all">Save</button>
              <button type="button" onClick={()=>setAdding(false)} className="px-4 py-2 rounded-lg bg-henry-surface2 border border-henry-border/30 text-henry-text-muted text-sm">Cancel</button>
            </div>
          </form>
        )}

        {/* Recurring transactions */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] uppercase tracking-wider text-henry-text-muted">Recurring ({recurrings.length})</p>
            <button onClick={()=>setShowRecurring(r=>!r)} className="text-[10px] text-henry-accent hover:underline">
              {showRecurring ? 'Hide' : 'Manage'}
            </button>
          </div>
          {showRecurring && (
            <div className="bg-henry-surface/40 border border-henry-border/15 rounded-xl p-3 space-y-2 mb-3">
              {recurrings.map(r=>(
                <div key={r.id} className="flex items-center gap-2 text-xs">
                  <span className={r.type==='income'?'text-green-400':'text-red-400'}>{r.type==='income'?'↑':'↓'}</span>
                  <span className="text-henry-text flex-1">{r.description||r.category}</span>
                  <span className="text-henry-text-muted font-mono">{fmt(r.amount)}</span>
                  <span className="text-henry-text-muted">day {r.day_of_month}</span>
                  <button onClick={async()=>{await getApi()?.financeRecurringDelete?.(r.id);setRecurrings(rs=>rs.filter(x=>x.id!==r.id));}} className="text-henry-text-muted hover:text-red-400 transition-all">✕</button>
                </div>
              ))}
              <div className="flex gap-2 pt-2 border-t border-henry-border/15">
                <select value={newRecurring.type} onChange={e=>setNewRecurring(r=>({...r,type:e.target.value as any,category:e.target.value==='expense'?EXPENSE_CATS[1]:INCOME_CATS[0]}))}
                  className="bg-henry-surface2 border border-henry-border/20 rounded-lg px-2 py-1.5 text-xs text-henry-text outline-none">
                  <option value="expense">Expense</option><option value="income">Income</option>
                </select>
                <input type="number" placeholder="Amount" value={newRecurring.amount} onChange={e=>setNewRecurring(r=>({...r,amount:e.target.value}))}
                  className="bg-henry-surface2 border border-henry-border/20 rounded-lg px-2 py-1.5 text-xs text-henry-text outline-none w-20"/>
                <select value={newRecurring.category} onChange={e=>setNewRecurring(r=>({...r,category:e.target.value}))}
                  className="bg-henry-surface2 border border-henry-border/20 rounded-lg px-2 py-1.5 text-xs text-henry-text outline-none flex-1">
                  {(newRecurring.type==='expense'?EXPENSE_CATS:INCOME_CATS).map(cat=><option key={cat}>{cat}</option>)}
                </select>
                <input type="number" min={1} max={28} placeholder="Day" value={newRecurring.day} onChange={e=>setNewRecurring(r=>({...r,day:parseInt(e.target.value)||1}))}
                  className="bg-henry-surface2 border border-henry-border/20 rounded-lg px-2 py-1.5 text-xs text-henry-text outline-none w-14"/>
                <button onClick={async()=>{
                  const amt=parseFloat(newRecurring.amount);
                  if(!amt) return;
                  await getApi()?.financeRecurringSave?.({type:newRecurring.type,amount:amt,category:newRecurring.category,description:newRecurring.description,day_of_month:newRecurring.day});
                  const list = await getApi()?.financeRecurringList?.();
                  setRecurrings(list as any||[]);
                  setNewRecurring(r=>({...r,amount:'',description:''}));
                }} className="px-3 py-1.5 bg-henry-accent text-white text-xs rounded-lg font-semibold">Add</button>
              </div>
            </div>
          )}
        </div>

        {/* Transactions list */}
        <div>
          <p className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-2">Transactions {loading?'…':''}</p>
          {txns.length===0 && !loading && <p className="text-henry-text-muted text-sm py-4 text-center">No transactions this month.</p>}
          <div className="space-y-1">
            {txns.map(t=>(
              <div key={t.id} className="group flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-henry-surface/40 transition-all">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm flex-shrink-0 ${t.type==='income'?'bg-green-400/10 text-green-400':'bg-red-400/10 text-red-400'}`}>
                  {t.type==='income'?'↑':'↓'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-henry-text truncate">{t.description||t.category}</p>
                  <p className="text-[10px] text-henry-text-muted">{t.category} · {t.date}</p>
                </div>
                <span className={`text-sm font-mono font-semibold flex-shrink-0 ${t.type==='income'?'text-green-400':'text-red-400'}`}>
                  {t.type==='income'?'+':'-'}{fmt(t.amount)}
                </span>
                <button onClick={()=>handleDelete(t.id)} className="opacity-0 group-hover:opacity-100 text-henry-text-muted hover:text-red-400 text-xs transition-all">✕</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
