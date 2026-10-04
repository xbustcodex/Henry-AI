/**
 * Panel Context Provider — injects current panel data into Henry's system prompt
 * so Henry can answer questions about what the user is looking at right now.
 */

function safeGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback; const _p = JSON.parse(raw); return (Array.isArray(fallback) && !Array.isArray(_p)) ? fallback : (_p as T);
  } catch {
    return fallback;
  }
}

export function buildPanelContextBlock(currentView: string): string {
  const blocks: string[] = [];

  switch (currentView) {
    case 'finance': {
      const entries = safeGet<any[]>('henry:finance', []);
      if (entries.length) {
        const income = entries.filter(e => e.type === 'income').reduce((s, e) => s + (e.amount || 0), 0);
        const expenses = entries.filter(e => e.type === 'expense').reduce((s, e) => s + (e.amount || 0), 0);
        const recent = entries.slice(-10).reverse();
        blocks.push('## Finance Context (what the user is viewing)');
        blocks.push(`Total income: $${income.toLocaleString()} | Total expenses: $${expenses.toLocaleString()} | Net: $${(income - expenses).toLocaleString()}`);
        blocks.push('Recent entries:');
        recent.forEach(e => {
          blocks.push(`- ${e.date || 'N/A'} ${e.type === 'income' ? '+' : '-'}$${e.amount || 0} ${e.category || ''} ${e.description || ''}`);
        });
      }
      break;
    }

    case 'reminders': {
      const reminders = safeGet<any[]>('henry:reminders', []);
      const pending = reminders.filter(r => !r.done && !r.completed);
      if (pending.length) {
        blocks.push('## Reminders Context (what the user is viewing)');
        pending.slice(0, 8).forEach(r => {
          blocks.push(`- ${r.text || r.title || ''}${r.dueDate ? ` (due ${r.dueDate})` : ''}`);
        });
      }
      break;
    }

    case 'tasks': {
      const tasks = safeGet<any[]>('henry:tasks', []);
      const pending = tasks.filter(t => t.status === 'pending' || t.status === 'queued' || t.status === 'running');
      const done = tasks.filter(t => t.status === 'done' || t.status === 'completed');
      if (tasks.length) {
        blocks.push('## Task Queue Context (what the user is viewing)');
        blocks.push(`${pending.length} pending, ${done.length} completed`);
        pending.slice(0, 5).forEach(t => {
          blocks.push(`- [${t.status}] ${t.title || t.prompt?.slice(0, 60) || 'Untitled'}${t.engine ? ` (${t.engine})` : ''}`);
        });
      }
      break;
    }

    case 'journal': {
      const today = new Date();
      const key = `henry:journal:${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      const entry = safeGet<{content?: string}>(key, {});
      if (entry.content) {
        blocks.push('## Journal Context (today\'s entry so far)');
        blocks.push(entry.content.slice(0, 500) + (entry.content.length > 500 ? '...' : ''));
      }
      break;
    }

    case 'weekly': {
      const review = safeGet<any>('henry:weekly_review_current', null);
      if (review) {
        blocks.push('## Weekly Review Context');
        if (review.wins) blocks.push(`Wins this week: ${review.wins}`);
        if (review.challenges) blocks.push(`Challenges: ${review.challenges}`);
        if (review.nextWeekGoals) blocks.push(`Next week goals: ${review.nextWeekGoals}`);
      }
      break;
    }

    case 'costs': {
      const msgs = safeGet<any[]>('henry:messages', []);
      const totalCost = msgs.reduce((s, m) => s + (m.cost || 0), 0);
      const totalTokens = msgs.reduce((s, m) => s + (m.tokens_used || 0), 0);
      blocks.push('## Cost Context (what the user is viewing)');
      blocks.push(`All-time: $${totalCost.toFixed(4)}, ${totalTokens.toLocaleString()} tokens, ${msgs.filter(m => m.role === 'assistant').length} responses`);
      break;
    }

    case 'workspace': {
      const files = safeGet<any[]>('henry:workspace_index', []);
      if (files.length) {
        blocks.push('## Workspace Context');
        blocks.push(`${files.length} indexed files`);
        files.slice(0, 5).forEach(f => {
          blocks.push(`- ${f.path || f.name}`);
        });
      }
      break;
    }

    default:
      break;
  }

  return blocks.length > 0 ? blocks.join('\n') + '\n' : '';
}
