import { useState, useEffect, useRef } from 'react';
import { sendToHenry } from '../../actions/store/chatBridgeStore';
import { useStore } from '../../store';

interface PersonalTask {
  id: string;
  title: string;
  notes?: string;
  status: 'todo' | 'doing' | 'done';
  priority: number;
  due_at?: string;
  created_at: string;
  completed_at?: string;
}

const getApi = () => (window as any).henryAPI as any;

async function listTasks(filter?: { status?: string }): Promise<PersonalTask[]> {
  try { return await getApi()?.tasksList(filter) || []; } catch { return []; }
}
async function createTask(task: Omit<PersonalTask, 'created_at' | 'status'>): Promise<void> {
  await getApi()?.tasksCreate(task);
}
async function updateTask(id: string, patch: Partial<PersonalTask>): Promise<void> {
  await getApi()?.tasksUpdate(id, patch);
}
async function deleteTask(id: string): Promise<void> {
  await getApi()?.tasksDelete(id);
}

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  3: { label: 'High', color: 'text-red-400' },
  2: { label: 'Med', color: 'text-yellow-400' },
  1: { label: 'Low', color: 'text-henry-text-muted' },
};

export default function TasksPanel() {
  const { setCurrentView } = useStore();
  const [tasks, setTasks] = useState<PersonalTask[]>([]);
  const [input, setInput] = useState('');
  const [filter, setFilter] = useState<'all' | 'todo' | 'doing' | 'done'>('all');
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [triaging, setTriaging] = useState(false);
  const [triageResult, setTriageResult] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function reload() {
    const f = filter === 'all' ? undefined : { status: filter };
    const data = await listTasks(f);
    setTasks(data);
    setLoading(false);
  }

  async function triageTasks() {
    if (triaging || tasks.length === 0) return;
    setTriaging(true); setTriageResult('');
    const todo = tasks.filter(t => t.status !== 'done').slice(0, 20);
    const list = todo.map((t, i) => `${i+1}. [${t.priority===3?'HIGH':t.priority===2?'MED':'LOW'}] ${t.title}${t.due_at?' (due '+t.due_at.slice(0,10)+')':''}`).join('\n');
    const ownerName = localStorage.getItem('henry:owner_name') || 'you';
    const prompt = `${ownerName} has these open tasks:\n${list}\n\nGive a brief triage: which 1-3 should be done first today and why. Be direct, 3-5 sentences max.`;
    try {
      const deviceId = (() => { let id = localStorage.getItem('henry:device_id'); if (!id) { id = crypto.randomUUID(); localStorage.setItem('henry:device_id', id); } return id; })();
      const res = await fetch('https://henry-proxy.henryai.workers.dev/v1/chat', {
        signal: AbortSignal.timeout(25000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Henry-Device': deviceId },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 300, stream: false }),
      });
      const data = await res.json() as any;
      setTriageResult(data?.choices?.[0]?.message?.content || 'No response');
    } catch { setTriageResult('Could not reach Henry AI.'); }
    setTriaging(false);
  }

  useEffect(() => { void reload(); }, [filter]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const title = input.trim();
    if (!title) return;
    setInput('');
    const id = crypto.randomUUID();
    await createTask({ id, title, priority: 2 });
    await reload();
  }

  async function handleStatusCycle(task: PersonalTask) {
    const next = task.status === 'todo' ? 'doing' : task.status === 'doing' ? 'done' : 'todo';
    await updateTask(task.id, { status: next });
    await reload();
  }

  async function handleDelete(id: string) {
    await deleteTask(id);
    await reload();
  }

  async function handleAsk(task: PersonalTask) {
    sendToHenry(`Help me with this task: ${task.title}${task.notes ? '. Notes: ' + task.notes : ''}`);
    setCurrentView('chat');
  }

  async function handlePriority(task: PersonalTask) {
    const next = task.priority === 3 ? 1 : task.priority + 1;
    await updateTask(task.id, { priority: next });
    await reload();
  }

  const statusIcon = (s: string) =>
    s === 'done' ? '✓' : s === 'doing' ? '▶' : '○';
  const statusColor = (s: string) =>
    s === 'done' ? 'text-green-400' : s === 'doing' ? 'text-henry-accent' : 'text-henry-text-muted';

  const grouped = {
    doing: tasks.filter(t => t.status === 'doing'),
    todo: tasks.filter(t => t.status === 'todo'),
    done: tasks.filter(t => t.status === 'done'),
  };

  return (
    <div className="flex flex-col h-full bg-henry-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-henry-border/20 flex-shrink-0">
        <div>
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold text-henry-text">Tasks</h1>
            <button onClick={() => void triageTasks()} disabled={triaging || tasks.length === 0}
              className="text-[11px] px-3 py-1.5 rounded-xl bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-accent hover:border-henry-accent/30 disabled:opacity-40 transition-all">
              {triaging ? '⚡ Thinking…' : '⚡ Henry: What first?'}
            </button>
          </div>
          {triageResult && (
            <div className="mt-2 p-3 bg-henry-accent/8 border border-henry-accent/20 rounded-xl">
              <p className="text-[11px] text-henry-accent font-semibold mb-1">⚡ Henry's take</p>
              <p className="text-xs text-henry-text-muted leading-relaxed">{triageResult}</p>
              <button onClick={() => setTriageResult('')} className="text-[10px] text-henry-text-muted hover:text-henry-text mt-1.5 transition-all">Dismiss</button>
            </div>
          )}
          <p className="text-[11px] text-henry-text-muted mt-0.5">
            {grouped.todo.length + grouped.doing.length} active · {grouped.done.length} done
          </p>
        </div>
        <div className="flex gap-1">
          {(['all', 'todo', 'doing', 'done'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-[10px] px-2.5 py-1 rounded-full capitalize transition-all ${
                filter === f
                  ? 'bg-henry-accent text-white font-semibold'
                  : 'bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-text'
              }`}
            >{f}</button>
          ))}
        </div>
      </div>

      {/* Add task */}
      <form onSubmit={handleCreate} className="px-6 py-3 border-b border-henry-border/20 flex gap-2 flex-shrink-0">
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Add a task… (Enter to save)"
          className="flex-1 bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50 transition-colors"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className="px-4 py-2 rounded-xl bg-henry-accent text-white text-sm font-semibold disabled:opacity-30 hover:bg-henry-accent/80 transition-all"
        >Add</button>
      </form>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {loading && (
          <p className="text-henry-text-muted text-sm text-center py-8">Loading tasks…</p>
        )}

        {!loading && tasks.length === 0 && (
          <div className="text-center py-12">
            <p className="text-2xl mb-2">☐</p>
            <p className="text-henry-text-muted text-sm">No tasks yet.</p>
            <p className="text-henry-text-muted text-xs mt-1">Type one above to get started.</p>
          </div>
        )}

        {/* In progress */}
        {grouped.doing.length > 0 && (filter === 'all' || filter === 'doing') && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-henry-accent mb-2">In Progress</p>
            <TaskList tasks={grouped.doing} onStatusCycle={handleStatusCycle} onDelete={handleDelete} onAsk={handleAsk} onPriority={handlePriority} />
          </div>
        )}

        {/* Todo */}
        {grouped.todo.length > 0 && (filter === 'all' || filter === 'todo') && (
          <div>
            {filter === 'all' && <p className="text-[10px] font-semibold uppercase tracking-wider text-henry-text-muted mb-2">To Do</p>}
            <TaskList tasks={grouped.todo} onStatusCycle={handleStatusCycle} onDelete={handleDelete} onAsk={handleAsk} onPriority={handlePriority} />
          </div>
        )}

        {/* Done */}
        {grouped.done.length > 0 && (filter === 'all' || filter === 'done') && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-henry-text-muted mb-2">Done</p>
            <TaskList tasks={grouped.done} onStatusCycle={handleStatusCycle} onDelete={handleDelete} onAsk={handleAsk} onPriority={handlePriority} />
          </div>
        )}
      </div>
    </div>
  );
}

function TaskList({ tasks, onStatusCycle, onDelete, onAsk, onPriority }: {
  tasks: PersonalTask[];
  onStatusCycle: (t: PersonalTask) => void;
  onDelete: (id: string) => void;
  onAsk: (t: PersonalTask) => void;
  onPriority: (t: PersonalTask) => void;
}) {
  return (
    <div className="space-y-1.5">
      {tasks.map(task => {
        const pri = PRIORITY_LABELS[task.priority] || PRIORITY_LABELS[2];
        return (
          <div
            key={task.id}
            className={`group flex items-start gap-3 p-3 rounded-xl border transition-all hover:border-henry-border/40 ${
              task.status === 'done'
                ? 'bg-henry-surface/20 border-henry-border/10 opacity-60'
                : task.status === 'doing'
                ? 'bg-henry-accent/5 border-henry-accent/20'
                : 'bg-henry-surface/30 border-henry-border/20'
            }`}
          >
            {/* Status toggle */}
            <button
              onClick={() => onStatusCycle(task)}
              className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all text-[10px] font-bold
                ${task.status === 'done' ? 'border-green-400 bg-green-400/20 text-green-400'
                  : task.status === 'doing' ? 'border-henry-accent bg-henry-accent/20 text-henry-accent'
                  : 'border-henry-border/40 hover:border-henry-accent/60 text-transparent hover:text-henry-accent/60'}`}
            >
              {task.status === 'done' ? '✓' : task.status === 'doing' ? '▶' : '○'}
            </button>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium leading-snug ${task.status === 'done' ? 'line-through text-henry-text-muted' : 'text-henry-text'}`}>
                {task.title}
              </p>
              {task.notes && (
                <p className="text-[11px] text-henry-text-muted mt-0.5 truncate">{task.notes}</p>
              )}
              {task.due_at && (
                <p className="text-[10px] text-henry-text-muted mt-0.5">
                  Due {new Date(task.due_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </p>
              )}
            </div>

            {/* Actions — shown on hover */}
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
              <button
                onClick={() => onPriority(task)}
                className={`text-[10px] px-1.5 py-0.5 rounded ${pri.color} hover:bg-henry-surface transition-all`}
                title="Change priority"
              >{pri.label}</button>
              <button
                onClick={() => onAsk(task)}
                className="text-[10px] px-1.5 py-0.5 rounded text-henry-text-muted hover:text-henry-accent hover:bg-henry-surface transition-all"
                title="Ask Henry"
              >Ask</button>
              <button
                onClick={() => onDelete(task.id)}
                className="text-[10px] px-1.5 py-0.5 rounded text-henry-text-muted hover:text-red-400 hover:bg-henry-surface transition-all"
                title="Delete"
              >✕</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
