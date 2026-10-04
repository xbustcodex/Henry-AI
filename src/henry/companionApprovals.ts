/**
 * Desktop → companion approval proposals.
 * Pushes a `PendingAction` through the sync bridge so linked handsets receive SSE
 * `pending_action` and can POST `/sync/actions/:id/decide`.
 */

import type { PendingAction, ActionRisk } from '../sync/types';

export interface ProposeCompanionActionInput {
  title: string;
  description: string;
  risk?: ActionRisk;
  details?: string;
  preview?: string;
  category?: string;
  expiresAt?: string;
  autoApproveAfterMs?: number;
  /** Optional stable id (e.g. deterministic for retries); otherwise generated. */
  id?: string;
}

export async function proposeCompanionAction(
  input: ProposeCompanionActionInput
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const api = window.henryAPI;
  if (!api?.syncAddPendingAction) {
    return { ok: false, error: 'Companion sync API not available (desktop Electron only).' };
  }

  const id = input.id ?? `pa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const action: PendingAction = {
    id,
    title: input.title,
    description: input.description,
    risk: input.risk ?? 'medium',
    details: input.details,
    preview: input.preview,
    category: input.category,
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
    autoApproveAfterMs: input.autoApproveAfterMs,
  };

  try {
    await api.syncAddPendingAction(action);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}
