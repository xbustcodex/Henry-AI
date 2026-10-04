/**
 * Henry Audit Log — every action Henry takes on the computer, logged locally.
 */

export type AuditActionType =
  | 'shell'
  | 'applescript'
  | 'screenshot'
  | 'open_app'
  | 'open_url'
  | 'type_text'
  | 'click'
  | 'gcode'
  | 'search'
  | 'file_read'
  | 'file_write'
  | 'task_submit';

export interface AuditEntry {
  id: string;
  type: AuditActionType;
  description: string;
  input?: string;
  output?: string;
  success: boolean;
  timestamp: string;
  conversationId?: string;
}

const AUDIT_KEY = 'henry:audit_log';
const MAX_ENTRIES = 500;

function loadLog(): AuditEntry[] {
  try {
    const raw = localStorage.getItem(AUDIT_KEY);
    return raw ? (JSON.parse(raw) as AuditEntry[]) : [];
  } catch {
    return [];
  }
}

function saveLog(entries: AuditEntry[]): void {
  try {
    localStorage.setItem(AUDIT_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // storage full
  }
}

export function logAction(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
  const full: AuditEntry = {
    ...entry,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
  const log = loadLog();
  log.push(full);
  saveLog(log);
  return full;
}

export function getAuditLog(limit = 100): AuditEntry[] {
  return loadLog().slice(-limit).reverse();
}

export function clearAuditLog(): void {
  localStorage.removeItem(AUDIT_KEY);
}
