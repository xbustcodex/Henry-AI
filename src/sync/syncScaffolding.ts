/**
 * Companion sync — Phase 1 scaffolding (payload shapes & domains).
 * Desktop remains authoritative; these types document cross-boundary contracts.
 */

import type { SyncTask, PendingAction, CapturePayload, SyncNotification } from './types';

/** Logical sync surface areas (maps to `/sync/*` routes and SSE event kinds). */
export type CompanionSyncDomain =
  | 'pairing'
  | 'snapshot'
  | 'events'
  | 'messages'
  | 'capture'
  | 'prompt'
  | 'approval'
  | 'devices'
  | 'push'
  | 'notifications';

/** Future: incremental chat summaries for companion home (not yet a dedicated route). */
export interface ChatHistorySummaryPayload {
  conversationId: string;
  title: string;
  summary: string;
  updatedAt: string;
  messageCount: number;
}

/** Task row as seen on the wire (mirrors `SyncTask`; explicit for versioning). */
export type TaskSyncEnvelope = SyncTask;

/** Desktop → mobile approval proposal (mirrors `PendingAction`). */
export type ApprovalProposal = PendingAction;

/** Mobile → desktop capture (mirrors `CapturePayload`). */
export type CaptureFeedItem = CapturePayload;

/** Push / local notification envelope for companion shell. */
export type NotificationEnvelope = SyncNotification;
