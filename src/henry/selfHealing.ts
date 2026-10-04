/**
 * Surfaces automated “self-repair” moments to the App shell (toast in App.tsx).
 * Other modules may dispatch `henry_self_healing` with `{ action: string }`.
 */

export interface HenryRepairEvent {
  action: string;
}

type Handler = (event: HenryRepairEvent) => void;

const EVENT = 'henry_self_healing';

export function startSelfHealing(onEvent: Handler): () => void {
  const listener = (e: Event) => {
    const action = (e as CustomEvent<Partial<HenryRepairEvent>>).detail?.action;
    if (typeof action === 'string' && action.trim()) onEvent({ action: action.trim() });
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
