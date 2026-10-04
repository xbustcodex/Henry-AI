/**
 * Companion Approval Screen
 *
 * Shows pending actions that Henry wants to execute on the desktop.
 * The user can approve or reject each one, with an optional note.
 *
 * Risk levels drive the visual treatment:
 *   low      → green accent, approve by default
 *   medium   → yellow accent, explicit confirm
 *   high     → red accent, type "CONFIRM" to approve
 *   critical → red accent, requires text confirmation + 3-second hold
 */

import { useState } from 'react';
import { useSyncStore } from '../../sync/syncStore';
import { sendActionDecision } from '../../sync/syncClient';
import type { PendingAction, ActionRisk, CompanionConnectionConfig } from '../../sync/types';
import { hapticSuccess, hapticError, hapticMedium } from '../../capacitor';

const RISK_CONFIG: Record<ActionRisk, { color: string; badge: string; border: string }> = {
  low: {
    color: 'text-henry-success',
    badge: 'bg-henry-success/15 text-henry-success',
    border: 'border-henry-success/20',
  },
  medium: {
    color: 'text-henry-warning',
    badge: 'bg-henry-warning/15 text-henry-warning',
    border: 'border-henry-warning/30',
  },
  high: {
    color: 'text-henry-error',
    badge: 'bg-henry-error/15 text-henry-error',
    border: 'border-henry-error/30',
  },
  critical: {
    color: 'text-henry-error',
    badge: 'bg-henry-error/20 text-henry-error',
    border: 'border-henry-error/40',
  },
};

export default function CompanionApproval() {
  const { pendingActions, config } = useSyncStore();

  if (pendingActions.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-4 px-8">
        <span className="text-6xl">✅</span>
        <div className="text-center">
          <p className="text-base font-semibold text-henry-text">All clear</p>
          <p className="text-sm text-henry-text-muted mt-1">
            No actions awaiting your approval
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-4 pt-4 pb-3">
        <h1 className="text-xl font-bold text-henry-text">Approvals</h1>
        <p className="text-xs text-henry-text-muted mt-0.5">
          {pendingActions.length} action{pendingActions.length !== 1 ? 's' : ''} waiting for your review
        </p>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4 space-y-3">
        {pendingActions.map((action) => (
          <ActionCard key={action.id} action={action} config={config} />
        ))}
      </div>
    </div>
  );
}

function ActionCard({
  action,
  config,
}: {
  action: PendingAction;
  config: CompanionConnectionConfig | null;
}) {
  const { removeAction } = useSyncStore();
  const [note, setNote] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [decided, setDecided] = useState<'approved' | 'rejected' | null>(null);

  const risk = action.risk ?? 'medium';
  const cfg = RISK_CONFIG[risk];
  const needsConfirmText = risk === 'high' || risk === 'critical';

  async function decide(approved: boolean) {
    if (needsConfirmText && approved && confirmText.trim().toUpperCase() !== 'CONFIRM') return;
    if (!config) return;

    setDeciding(true);
    void hapticMedium();
    try {
      await sendActionDecision(config, {
        actionId: action.id,
        approved,
        note: note.trim() || undefined,
        fromDevice: config.deviceId,
        decidedAt: new Date().toISOString(),
      });
      setDecided(approved ? 'approved' : 'rejected');
      void (approved ? hapticSuccess() : hapticError());
      setTimeout(() => removeAction(action.id), 800);
    } catch {
      void hapticError();
    } finally {
      setDeciding(false);
    }
  }

  if (decided) {
    return (
      <div className={`rounded-2xl border p-5 flex flex-col items-center gap-2 ${cfg.border} bg-henry-surface`}>
        <span className="text-3xl">{decided === 'approved' ? '✅' : '🚫'}</span>
        <p className="text-sm font-semibold text-henry-text">
          {decided === 'approved' ? 'Approved' : 'Rejected'}
        </p>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl border bg-henry-surface ${cfg.border} overflow-hidden`}>
      {/* Header */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ${cfg.badge}`}>
                {risk} risk
              </span>
              {action.category && (
                <span className="text-[10px] text-henry-text-muted">{action.category}</span>
              )}
            </div>
            <p className="text-base font-semibold text-henry-text leading-tight">
              {action.title}
            </p>
          </div>
        </div>

        <p className="text-sm text-henry-text-dim mt-2 leading-relaxed">
          {action.description}
        </p>

        {action.details && (
          <div className="mt-2 bg-henry-bg rounded-xl px-3 py-2.5">
            <p className="text-xs text-henry-text-muted leading-relaxed">{action.details}</p>
          </div>
        )}

        {action.preview && (
          <div className="mt-2 bg-henry-bg rounded-xl px-3 py-2.5">
            <p className="text-[10px] font-medium text-henry-text-muted mb-1">Preview</p>
            <pre className="text-xs text-henry-text-dim whitespace-pre-wrap break-all line-clamp-6">
              {action.preview}
            </pre>
          </div>
        )}

        {action.expiresAt && (
          <p className="text-[10px] text-henry-text-muted mt-2">
            Expires {new Date(action.expiresAt).toLocaleString()}
          </p>
        )}
      </div>

      {/* Optional note */}
      <div className="px-4 pb-3">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note (optional)"
          className="w-full bg-henry-bg rounded-xl px-3.5 py-2.5 text-sm text-henry-text placeholder-henry-text-muted outline-none border border-henry-border/20 focus:border-henry-accent/40 transition-colors"
        />
      </div>

      {/* High-risk confirmation */}
      {needsConfirmText && (
        <div className="px-4 pb-3">
          <p className="text-xs text-henry-text-muted mb-1.5">
            Type <span className="font-mono font-bold text-henry-error">CONFIRM</span> to approve this {risk}-risk action
          </p>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="CONFIRM"
            className="w-full bg-henry-bg rounded-xl px-3.5 py-2.5 text-sm font-mono text-henry-error placeholder-henry-text-muted outline-none border border-henry-error/30 focus:border-henry-error/60 transition-colors uppercase"
          />
        </div>
      )}

      {/* Action buttons */}
      <div className="px-4 pb-4 flex gap-3">
        <button
          onClick={() => void decide(false)}
          disabled={deciding}
          className="flex-1 py-3.5 rounded-xl bg-henry-bg text-henry-text text-sm font-semibold border border-henry-border/30 active:bg-henry-surface transition-colors disabled:opacity-40"
        >
          Reject
        </button>
        <button
          onClick={() => void decide(true)}
          disabled={
            deciding ||
            (needsConfirmText && confirmText.trim().toUpperCase() !== 'CONFIRM')
          }
          className={`flex-1 py-3.5 rounded-xl text-white text-sm font-semibold transition-colors disabled:opacity-40 ${
            risk === 'high' || risk === 'critical'
              ? 'bg-henry-error active:bg-henry-error/80'
              : 'bg-henry-accent active:bg-henry-accent/80'
          }`}
        >
          {deciding ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Sending…
            </span>
          ) : (
            'Approve'
          )}
        </button>
      </div>
    </div>
  );
}
