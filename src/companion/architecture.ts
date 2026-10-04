/**
 * Henry Companion — Phase 1 architecture (canonical in code)
 *
 * ## Roles
 * - **Desktop (Electron)** — Source of truth: SQLite, AI engines, workspace, sync HTTP
 *   server (`electron/ipc/syncBridge.ts`). Issues pairing codes and holds linked-device
 *   registry for the current process lifetime.
 * - **Mobile (Capacitor iOS/iPadOS)** — Companion: capture, lightweight chat, task view,
 *   approvals, notifications. Persists only `CompanionConnectionConfig` + cached snapshot
 *   in `localStorage` (`henry:companion:*` keys in `syncClient.ts`).
 *
 * ## State boundaries
 * - **Device link state** — Desktop: `SyncServerState` + in-memory `linkedDevices` map.
 *   Mobile: `useSyncStore` connection fields + `CompanionConnectionConfig`.
 * - **Companion session** — Mobile `useSyncStore`: snapshot slices, `pendingActions`,
 *   SSE stream status. Desktop renderer receives push IPC (`henry:companion:*`) from main.
 *
 * ## Sync transport
 * - **LAN** — `http://{host}:{port}/sync/*` + SSE `/sync/stream?token=…`. No TLS in
 *   Phase 1; devices must share a trusted network.
 * - **Relay** — Types only (`RelayMessage`, etc.); wire-up is a later phase.
 *
 * ## Approval flow
 * - Desktop calls `proposeCompanionAction()` → main `addPendingAction` → SSE
 *   `pending_action` → mobile `CompanionApproval` → `POST /sync/actions/:id/decide` →
 *   main notifies renderer `henry:companion:action-decision`.
 */

/** Bumped when companion contracts change in a breaking way. */
export const COMPANION_ARCHITECTURE_VERSION = 1 as const;

export type { CompanionDeviceCapability, CompanionLinkStatus } from '../sync/types';
export { COMPANION_DEFAULT_DEVICE_CAPABILITIES } from '../sync/types';
export type {
  CompanionSyncDomain,
  ChatHistorySummaryPayload,
  TaskSyncEnvelope,
  ApprovalProposal,
  CaptureFeedItem,
  NotificationEnvelope,
} from '../sync/syncScaffolding';
