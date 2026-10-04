// ── Henry Companion Sync — Shared Types ─────────────────────────────────────

// ── Connection & Status ────────────────────────────────────────────────────

export type CompanionMode = 'full' | 'companion';
export type CompanionConnectionStatus =
  | 'disconnected'
  | 'pairing'
  | 'connecting'
  | 'connected'
  | 'syncing'
  | 'error';

/** What a linked handset is allowed to do in Phase 1 (desktop authorizes at pair time). */
export type CompanionDeviceCapability =
  | 'chat_summaries'
  | 'tasks'
  | 'approvals'
  | 'captures'
  | 'notifications';

/** Default capability set for new companion devices (full Phase 1 surface). */
export const COMPANION_DEFAULT_DEVICE_CAPABILITIES: readonly CompanionDeviceCapability[] = [
  'chat_summaries',
  'tasks',
  'approvals',
  'captures',
  'notifications',
] as const;

/** Desktop’s view of whether the handset session is still valid (in-memory only today). */
export type CompanionLinkStatus = 'linked' | 'revoked';

export interface DeviceInfo {
  id: string;
  name: string;
  platform: 'desktop' | 'ios' | 'android' | 'web';
  linkedAt: string;
  lastSeen?: string;
  /** ISO time of last successful authenticated sync (snapshot or delta pull). */
  lastSyncAt?: string;
  pushToken?: string;
  linkStatus?: CompanionLinkStatus;
  capabilities?: CompanionDeviceCapability[];
  /** When `platform === 'ios'`, distinguishes iPhone vs iPad when the client reports it. */
  appleProduct?: 'iphone' | 'ipad' | 'unknown';
}

// ── Pairing ────────────────────────────────────────────────────────────────

export interface PairRequest {
  pairToken: string;
  deviceName: string;
  platform: string;
  pushToken?: string;
  /** Optional: `iphone` | `ipad` from Capacitor client for clearer desktop UI. */
  appleProduct?: 'iphone' | 'ipad' | 'unknown';
}

export interface PairResponse {
  companionToken: string;
  deviceId: string;
  desktopName: string;
}

/** Stored locally on mobile device */
export interface CompanionConnectionConfig {
  host: string;
  port: number;
  token: string;
  deviceId: string;
  desktopName: string;
  pairedAt: string;
  useRelay: boolean;
  relayUrl?: string;
}

/** Desktop sync server runtime state */
export interface SyncServerState {
  running: boolean;
  tunnelUrl?: string | null;
  port: number;
  localIp: string;
  pairToken: string | null;
  pairTokenExpiry: number | null;
  linkedDevices: DeviceInfo[];
}

// ── Sync Events ────────────────────────────────────────────────────────────

export type SyncEventType =
  | 'snapshot'
  | 'message_added'
  | 'conversation_added'
  | 'task_updated'
  | 'task_added'
  | 'note_added'
  | 'note_updated'
  | 'files_updated'
  | 'settings_updated'
  | 'desktop_status'
  | 'pending_action'
  | 'action_resolved'
  | 'capture_received'
  | 'capture_processed'
  | 'notification'
  | 'companion_response'
  | 'companion_chunk'
  | 'companion_screenshot'
  | 'companion_chat_update'
  | 'tunnel_active';

export interface SyncEvent {
  id: string;
  type: SyncEventType;
  payload: unknown;
  timestamp: number;
  fromDevice: string;
}

// ── Snapshot (full state push) ─────────────────────────────────────────────

export interface SyncSnapshot {
  timestamp: number;
  conversations: SyncConversation[];
  recentMessages: SyncMessage[];
  tasks: SyncTask[];
  notes: SyncNote[];
  filesMetadata: SyncFileMetadata[];
  settings: SyncRoamingSettings;
  desktopStatus: DesktopStatus;
  pendingActions: PendingAction[];
}

// ── Data Payloads ──────────────────────────────────────────────────────────

export interface SyncConversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  preview?: string;
}

export interface SyncMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  created_at: string;
}

export interface SyncTask {
  id: string;
  description: string;
  status: string;
  priority: number;
  type: string;
  result?: string;
  error?: string;
  cost?: number;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

export interface SyncNote {
  id: string;
  title: string;
  preview: string;
  created_at: string;
  updated_at: string;
  tags?: string[];
}

export interface SyncFileMetadata {
  id: string;
  file_path: string;
  file_type: string;
  summary: string;
  size_bytes: number;
  last_indexed: string;
}

export interface SyncRoamingSettings {
  theme?: string;
  companionModel?: string;
  workerModel?: string;
  timezone?: string;
  userName?: string;
  notificationsEnabled?: boolean;
}

export interface DesktopStatus {
  online: boolean;
  companionStatus: string;
  workerStatus: string;
  currentActivity?: string;
  tasksRunning: number;
  tasksQueued: number;
  memoryUsedMB?: number;
}

// ── Mobile Capture ─────────────────────────────────────────────────────────

export type CaptureType = 'text' | 'voice' | 'image' | 'file';

export interface CapturePayload {
  id: string;
  type: CaptureType;
  content: string;
  mimeType?: string;
  fileName?: string;
  fileSizeBytes?: number;
  duration?: number;
  transcription?: string;
  context?: string;
  fromDevice: string;
  timestamp: number;
}

export interface CaptureResult {
  captureId: string;
  accepted: boolean;
  messageId?: string;
  conversationId?: string;
  error?: string;
}

// ── Action Approval ────────────────────────────────────────────────────────

export type ActionRisk = 'low' | 'medium' | 'high' | 'critical';

export interface PendingAction {
  id: string;
  title: string;
  description: string;
  risk: ActionRisk;
  details?: string;
  preview?: string;
  category?: string;
  createdAt: string;
  expiresAt?: string;
  autoApproveAfterMs?: number;
}

export interface ActionDecision {
  actionId: string;
  approved: boolean;
  note?: string;
  fromDevice: string;
  decidedAt: string;
}

// ── Push Notifications ─────────────────────────────────────────────────────

export type NotificationCategory =
  | 'task_complete'
  | 'task_failed'
  | 'action_required'
  | 'reminder'
  | 'summary'
  | 'message'
  | 'alert';

export interface SyncNotification {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  scheduleAt?: string;
  badge?: number;
}

// ── Relay (Cloud Fallback) ─────────────────────────────────────────────────

export interface RelayRegisterRequest {
  deviceId: string;
  token: string;
  platform: string;
}

export interface RelayMessage {
  from: string;
  to: string;
  event: SyncEvent;
}
