/**
 * Henry Rich Memory — structured persistent memory for projects, goals, and people.
 * Stored in localStorage. Surfaces in system prompts for deeper presence.
 */

export interface HenryProject {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'paused' | 'done';
  nextStep: string;
  tags: string[];
  updatedAt: string;
  createdAt: string;
}

export interface HenryGoal {
  id: string;
  title: string;
  description: string;
  timeframe: string;
  progress: number;
  milestones: string[];
  updatedAt: string;
  createdAt: string;
}

export interface HenryPerson {
  id: string;
  name: string;
  relationship: string;
  context: string;
  lastNote: string;
  updatedAt: string;
}

const PROJECTS_KEY = 'henry:rich_memory:projects';
const GOALS_KEY = 'henry:rich_memory:goals';
const PEOPLE_KEY = 'henry:rich_memory:people';

function load<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function save<T>(key: string, items: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch { /* storage full */ }
}

// ── Projects ──────────────────────────────────────────────────────────────────

export function loadProjects(): HenryProject[] {
  return load<HenryProject>(PROJECTS_KEY);
}

export function saveProject(project: HenryProject): void {
  const all = loadProjects();
  const idx = all.findIndex((p) => p.id === project.id);
  if (idx >= 0) all[idx] = project;
  else all.unshift(project);
  save(PROJECTS_KEY, all);
}

export function deleteProject(id: string): void {
  save(PROJECTS_KEY, loadProjects().filter((p) => p.id !== id));
}

export function newProject(): HenryProject {
  return {
    id: crypto.randomUUID(),
    name: '',
    description: '',
    status: 'active',
    nextStep: '',
    tags: [],
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

// ── Goals ─────────────────────────────────────────────────────────────────────

export function loadGoals(): HenryGoal[] {
  return load<HenryGoal>(GOALS_KEY);
}

export function saveGoal(goal: HenryGoal): void {
  const all = loadGoals();
  const idx = all.findIndex((g) => g.id === goal.id);
  if (idx >= 0) all[idx] = goal;
  else all.unshift(goal);
  save(GOALS_KEY, all);
}

export function deleteGoal(id: string): void {
  save(GOALS_KEY, loadGoals().filter((g) => g.id !== id));
}

export function newGoal(): HenryGoal {
  return {
    id: crypto.randomUUID(),
    title: '',
    description: '',
    timeframe: '',
    progress: 0,
    milestones: [],
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

// ── People (internal to rich memory, distinct from contacts) ──────────────────

export function loadPeople(): HenryPerson[] {
  return load<HenryPerson>(PEOPLE_KEY);
}

export function savePerson(person: HenryPerson): void {
  const all = loadPeople();
  const idx = all.findIndex((p) => p.id === person.id);
  if (idx >= 0) all[idx] = person;
  else all.unshift(person);
  save(PEOPLE_KEY, all);
}

export function deletePerson(id: string): void {
  save(PEOPLE_KEY, loadPeople().filter((p) => p.id !== id));
}

export function newPerson(): HenryPerson {
  return {
    id: crypto.randomUUID(),
    name: '',
    relationship: '',
    context: '',
    lastNote: '',
    updatedAt: new Date().toISOString(),
  };
}

// ── System prompt block ───────────────────────────────────────────────────────

export function buildRichMemoryBlock(): string {
  const projects = loadProjects().filter((p) => p.status === 'active').slice(0, 6);
  const goals = loadGoals().slice(0, 4);
  const people = loadPeople().slice(0, 8);

  const lines: string[] = [];

  const richOwner = localStorage.getItem('henry:owner_name')?.trim() || 'the user';
  if (projects.length > 0) {
    lines.push(`**Active projects ${richOwner} is working on:**`);
    for (const p of projects) {
      lines.push(`- **${p.name}**: ${p.description}${p.nextStep ? ` → Next: ${p.nextStep}` : ''}`);
    }
    lines.push('');
  }

  if (goals.length > 0) {
    lines.push(`**${richOwner === 'the user' ? 'Current' : `${richOwner}'s`} goals:**`);
    for (const g of goals) {
      const pct = g.progress > 0 ? ` (${g.progress}% complete)` : '';
      lines.push(`- **${g.title}**${pct}${g.timeframe ? ` — ${g.timeframe}` : ''}: ${g.description}`);
    }
    lines.push('');
  }

  if (people.length > 0) {
    lines.push(`**People important to ${richOwner} (mention when relevant):**`);
    for (const p of people) {
      const rel = p.relationship ? ` — ${p.relationship}` : '';
      const ctx = p.context ? `: ${p.context}` : '';
      const note = p.lastNote ? ` | Note: ${p.lastNote.slice(0, 120)}` : '';
      lines.push(`- **${p.name}**${rel}${ctx}${note}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

