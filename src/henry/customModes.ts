const CUSTOM_MODES_KEY = 'henry:custom_modes';

export interface CustomMode {
  id: string;
  name: string;
  icon: string;
  description: string;
  systemPrompt: string;
  color: string;
  createdAt: string;
}

export function loadCustomModes(): CustomMode[] {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_MODES_KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveCustomMode(mode: CustomMode): void {
  const modes = loadCustomModes();
  const idx = modes.findIndex((m) => m.id === mode.id);
  if (idx >= 0) {
    modes[idx] = mode;
  } else {
    modes.push(mode);
  }
  localStorage.setItem(CUSTOM_MODES_KEY, JSON.stringify(modes));
}

export function deleteCustomMode(id: string): void {
  const modes = loadCustomModes().filter((m) => m.id !== id);
  localStorage.setItem(CUSTOM_MODES_KEY, JSON.stringify(modes));
}

export function newCustomMode(): CustomMode {
  return {
    id: `custom_${Date.now()}`,
    name: '',
    icon: '✨',
    description: '',
    systemPrompt: '',
    color: 'violet',
    createdAt: new Date().toISOString(),
  };
}

export const CUSTOM_MODE_COLORS = [
  { id: 'violet', label: 'Violet', cls: 'border-violet-500/40 text-violet-400' },
  { id: 'emerald', label: 'Green', cls: 'border-emerald-500/40 text-emerald-400' },
  { id: 'amber', label: 'Amber', cls: 'border-amber-500/40 text-amber-400' },
  { id: 'sky', label: 'Sky', cls: 'border-sky-500/40 text-sky-400' },
  { id: 'rose', label: 'Rose', cls: 'border-rose-500/40 text-rose-400' },
  { id: 'cyan', label: 'Cyan', cls: 'border-cyan-500/40 text-cyan-400' },
  { id: 'orange', label: 'Orange', cls: 'border-orange-500/40 text-orange-400' },
  { id: 'pink', label: 'Pink', cls: 'border-pink-500/40 text-pink-400' },
];
