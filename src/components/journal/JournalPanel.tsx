import { useState, useEffect, useRef } from 'react';
import { sendToHenry } from '../../actions/store/chatBridgeStore';
import { useStore } from '../../store';
import { callHenryAI, NoBackendAvailableError } from '../../henry/henryAI';

interface JournalEntry { id:string; date:string; title?:string; content:string; mood?:string; tags:string[]; created_at:string; updated_at:string }

const getApi = () => (window as any).henryAPI as any;
const MOODS = ['😊','😐','😔','🔥','🙏','💡','😤','😴'];

function todayKey(){ return new Date().toISOString().slice(0,10); }

export default function JournalPanel(){
  const { setCurrentView } = useStore();
  const [entries, setEntries]     = useState<JournalEntry[]>([]);
  const [selected, setSelected]   = useState<JournalEntry|null>(null);
  const [content, setContent]     = useState('');
  const [title, setTitle]         = useState('');
  const [mood, setMood]           = useState('');
  const [search, setSearch]       = useState('');
  const [dirty, setDirty]         = useState(false);
  const [saving, setSaving]       = useState(false);
  const [reflecting, setReflecting] = useState(false);
  const [reflection, setReflection] = useState('');
  const [search_q, setSearchQ]    = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>|null>(null);

  async function reflectOnEntry() {
    if (!content.trim() || reflecting) return;
    setReflecting(true);
    setReflection('');
    const ownerName = localStorage.getItem('henry:owner_name') || 'you';
    const prompt = `${ownerName} wrote this journal entry on ${selected?.date || new Date().toISOString().slice(0,10)}:

"${content.slice(0,800)}"

As a thoughtful, encouraging friend, offer a 2-3 sentence reflection. Notice something meaningful. Ask one gentle follow-up question.`;
    try {
      const reply = await callHenryAI({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 220,
        temperature: 0.8,
      });
      setReflection(reply || 'No response.');
    } catch (e) {
      if (e instanceof NoBackendAvailableError) setReflection(e.userFacingMessage);
      else setReflection('Could not reach Henry. Check your AI provider in Settings.');
    }
    setReflecting(false);
  }

  async function loadList(q?:string){
    const data = await getApi()?.journalList?.(q||undefined) as JournalEntry[] || [];
    setEntries(data.map(e=>({...e, tags: JSON.parse(e.tags as any||'[]')})));
  }

  async function openEntry(e:JournalEntry){
    const full = await getApi()?.journalGet(e.id) as JournalEntry|null;
    const entry = full || e;
    setSelected({...entry, tags: JSON.parse((entry.tags as any) || '[]')});
    setContent(entry.content||'');
    setTitle(entry.title||'');
    setMood(entry.mood||'');
    setDirty(false);
  }

  async function newEntry(){
    const today = todayKey();
    const existing = entries.find(e=>e.date===today);
    if(existing){ openEntry(existing); return; }
    const entry:JournalEntry = { id:crypto.randomUUID(), date:today, content:'', tags:[], created_at:new Date().toISOString(), updated_at:new Date().toISOString() };
    setSelected(entry); setContent(''); setTitle(''); setMood(''); setDirty(false);
    setTimeout(()=>textRef.current?.focus(), 50);
  }

  async function save(s?:JournalEntry, c?:string, ti?:string, mo?:string){
    const entry = s||selected; if(!entry) return;
    setSaving(true);
    await getApi()?.journalSave({ id:entry.id, date:entry.date, title:(ti??title)||null, content:(c??content), mood:(mo??mood)||null, tags:entry.tags });
    setSaving(false); setDirty(false);
    await loadList(search_q);
  }

  function handleChange(val:string){ setContent(val); setDirty(true); if(saveTimer.current)clearTimeout(saveTimer.current); saveTimer.current=setTimeout(()=>save(undefined,val),2000); }

  async function handleDelete(){
    if(!selected) return;
    await getApi()?.journalDelete(selected.id);
    setSelected(null); setContent(''); setTitle(''); setMood('');
    await loadList(search_q);
  }

  function askHenry(){
    if(!content.trim()) return;
    sendToHenry(`I wrote in my journal today (${selected?.date}): "${content.slice(0,600)}". What insights or reflections do you have?`);
    setCurrentView('chat');
  }

  useEffect(()=>{ void loadList(); void newEntry(); },[]);

  useEffect(()=>{
    const t = setTimeout(()=>void loadList(search_q), 300);
    return ()=>clearTimeout(t);
  },[search_q]);

  const dateLabel = (d:string) => new Date(d+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});

  return(
    <div className="flex h-full bg-henry-bg overflow-hidden">
      {/* Sidebar */}
      <div className="w-64 flex-shrink-0 border-r border-henry-border/20 flex flex-col">
        <div className="p-3 border-b border-henry-border/20 space-y-2">
          {/* Streak display */}
          {(() => {
            const today = todayKey();
            let streak = 0;
            for (let i = 0; i < 30; i++) {
              const d = new Date(); d.setDate(d.getDate() - i);
              const ds = d.toISOString().slice(0,10);
              if (entries.find(e => e.date === ds)) streak++;
              else if (i > 0) break;
            }
            return streak > 1 ? (
              <div className="flex items-center gap-2 px-1 py-1 mb-1">
                <span className="text-base">🔥</span>
                <span className="text-xs font-bold text-henry-accent">{streak} day streak</span>
              </div>
            ) : null;
          })()}
          <button onClick={newEntry} className="w-full py-2 rounded-xl bg-henry-accent text-white text-sm font-semibold hover:bg-henry-accent/80 transition-all">
            + New Entry
          </button>
          {entries.length > 0 && (
            <div className="flex items-center justify-between text-[10px] text-henry-text-muted px-1">
              <span>{entries.length} entries</span>
              <span>
                {(() => {
                  const moods = entries.filter(e=>e.mood).map(e=>e.mood);
                  const top = moods.reduce((a:Record<string,number>,m)=>({...a,[m!]:(a[m!]||0)+1}),{});
                  const best = Object.entries(top).sort((a,b)=>b[1]-a[1])[0];
                  return best ? `${best[0]} most common` : '';
                })()}
              </span>
            </div>
          )}
          <input value={search_q} onChange={e=>setSearchQ(e.target.value)} placeholder="Search journal…"
            className="w-full bg-henry-surface border border-henry-border/30 rounded-lg px-3 py-1.5 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {entries.length===0 && <p className="p-4 text-henry-text-muted text-xs text-center">No entries yet.</p>}
          {entries.map(e=>(
            <button key={e.id} onClick={()=>openEntry(e)}
              className={`w-full text-left px-4 py-3 border-b border-henry-border/10 hover:bg-henry-surface/40 transition-all ${selected?.id===e.id?'bg-henry-surface/60 border-l-2 border-l-henry-accent':''}`}>
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-henry-text">{dateLabel(e.date)}</p>
                {e.mood && <span className="text-sm">{e.mood}</span>}
              </div>
              {e.title && <p className="text-[11px] text-henry-text-muted truncate mt-0.5">{e.title}</p>}
            </button>
          ))}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selected ? (
          <>
            <div className="flex items-center gap-2 px-6 py-3 border-b border-henry-border/20 flex-shrink-0">
              <input value={title} onChange={e=>{setTitle(e.target.value);setDirty(true);}} placeholder="Title (optional)"
                className="flex-1 bg-transparent text-sm font-semibold text-henry-text placeholder:text-henry-text-muted outline-none" />
              <div className="flex gap-1">
                {MOODS.map(m=>(
                  <button key={m} onClick={()=>{setMood(m===mood?'':m);setDirty(true);}}
                    className={`text-base transition-all ${mood===m?'opacity-100 scale-110':'opacity-40 hover:opacity-80'}`}>{m}</button>
                ))}
              </div>
              <div className="flex gap-2 ml-2">
                <span className="text-[10px] text-henry-text-muted">
                {(() => {
                  const wc = content.split(/\s+/).filter(Boolean).length;
                  const goal = 200;
                  const pct = Math.min(100, Math.round((wc/goal)*100));
                  return (
                    <span className={wc >= goal ? 'text-green-400' : ''}>
                      {wc} words {wc < goal ? `(${pct}% of ${goal})` : '✓ goal reached'}
                    </span>
                  );
                })()}
              </span>
              {content.trim().length > 50 && (
                <button onClick={() => void reflectOnEntry()} disabled={reflecting}
                  className="text-[11px] px-2.5 py-1 rounded-lg bg-henry-accent/15 border border-henry-accent/30 text-henry-accent hover:bg-henry-accent/25 disabled:opacity-40 transition-all">
                  {reflecting ? '⟳' : '⚡ Reflect'}
                </button>
              )}
              {dirty && <button onClick={()=>save()} disabled={saving} className="text-[11px] px-3 py-1 rounded-lg bg-henry-accent text-white hover:bg-henry-accent/80 disabled:opacity-40 transition-all">{saving?'Saving…':'Save'}</button>}
                <button onClick={askHenry} className="text-[11px] px-3 py-1 rounded-lg bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-accent transition-all">Reflect</button>
                <button onClick={handleDelete} className="text-[11px] px-2 py-1 rounded-lg text-henry-text-muted hover:text-red-400 transition-all">✕</button>
              </div>
            </div>
            <div className="px-4 py-2 border-b border-henry-border/10 flex-shrink-0">
              <p className="text-[10px] text-henry-text-muted">{dateLabel(selected.date)}</p>
            </div>
            <textarea ref={textRef} value={content} onChange={e=>handleChange(e.target.value)}
              placeholder={[
              'Write anything. Henry saves automatically…',
              "What's on your mind today?",
              'What are you grateful for right now?',
              "What's one thing you want to remember about today?",
              "What's your biggest challenge today? Write through it.",
              'What did you learn today?',
              "What are you looking forward to this week?",
            ][new Date().getDay() % 7]}
              className="flex-1 bg-transparent text-henry-text text-sm leading-relaxed p-6 outline-none resize-none placeholder:text-henry-text-muted/40" />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-4xl mb-3">✦</p>
              <p className="text-henry-text-muted text-sm">Select an entry or start writing.</p>
              <button onClick={newEntry} className="mt-3 text-[12px] px-4 py-2 rounded-xl bg-henry-accent text-white font-semibold">Start Today</button>
            </div>
          </div>
        )}
          {reflection && (
            <div className="mx-4 mb-3 p-3 bg-henry-accent/8 border border-henry-accent/20 rounded-xl">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[10px] font-semibold text-henry-accent uppercase tracking-wider">⚡ Henry's reflection</p>
                <button onClick={() => setReflection('')} className="text-henry-text-muted hover:text-henry-text text-xs">✕</button>
              </div>
              <p className="text-xs text-henry-text leading-relaxed">{reflection}</p>
            </div>
          )}
      </div>
    </div>
  );
}
