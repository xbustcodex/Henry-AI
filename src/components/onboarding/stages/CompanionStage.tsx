import { useCallback, useEffect, useState } from 'react';
import QrCodeImage from '../../common/QrCodeImage';
import {
  StageScreen,
  StageHeading,
  StageCard,
  StageActions,
  StagePrimaryAction,
  StageSecondaryAction,
  StageStep,
} from '../layout';

interface Props {
  onNext: () => void;
  onSkip: () => void;
}

interface SyncState {
  running?: boolean;
  localIp?: string;
  port?: number;
  tunnelUrl?: string | null;
  linkedDevices?: Array<{ id: string; name?: string; linkStatus?: string }>;
}

interface PairingInfo {
  henryId?: string;
  pin?: string;
  pinExpiresAt?: number;
}

const SYNC_HEADERS = { 'Content-Type': 'application/json', 'X-Henry-Internal': 'true' };

async function syncFetch<T>(path: string, body?: object): Promise<T | null> {
  try {
    const res = await fetch('http://127.0.0.1:4242' + path, {
      method: body ? 'POST' : 'GET',
      headers: SYNC_HEADERS,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Phone pairing.
 *
 * Optional: a user with no phone, or who will pair later, takes the explicit
 * skip. What this stage never does is fabricate a pairing token — the QR is
 * built only from the PIN the running sync server issued, and it expires on the
 * server's own clock.
 */
export default function CompanionStage({ onNext, onSkip }: Props) {
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [lanUrl, setLanUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [linkedDevices, setLinkedDevices] = useState<Array<{ id: string; name?: string }>>([]);

  const generatePair = useCallback(async () => {
    setGenerating(true);
    try {
      const state = await syncFetch<SyncState>('/sync/state-internal');
      if (!state?.running) await syncFetch('/sync/start-internal', {});
      const info = await syncFetch<PairingInfo>('/sync/pairing-info');
      if (!info?.henryId || !info?.pin) return;
      const fresh = await syncFetch<SyncState>('/sync/state-internal');
      const localIp = fresh?.localIp || '127.0.0.1';
      const port = fresh?.port || 4242;
      setLanUrl(`http://${localIp}:${port}`);
      setPairUrl(
        `http://${localIp}:${port}/companion/pair#id=${encodeURIComponent(info.henryId)}&pin=${encodeURIComponent(info.pin)}`,
      );
      setExpiresAt(info.pinExpiresAt || Date.now() + 30 * 60 * 1000);
    } finally {
      setGenerating(false);
    }
  }, []);

  useEffect(() => {
    void generatePair();
  }, [generatePair]);

  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
      // The PIN rotates on the server; a dead QR must not linger.
      if (remaining === 0) { setPairUrl(null); setExpiresAt(null); }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  useEffect(() => {
    const refresh = () => {
      void syncFetch<SyncState>('/sync/state-internal').then((state) => {
        const devices = Array.isArray(state?.linkedDevices) ? state.linkedDevices : [];
        setLinkedDevices(
          devices.filter((d) => !d.linkStatus || d.linkStatus === 'linked'),
        );
      });
    };
    refresh();
    window.addEventListener('henry_companion_devices_changed', refresh);
    const poll = setInterval(refresh, 3000);
    return () => {
      window.removeEventListener('henry_companion_devices_changed', refresh);
      clearInterval(poll);
    };
  }, []);

  async function copyUrl(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the URL is on screen to type instead */
    }
  }

  const linked = linkedDevices.length > 0;

  return (
    <StageScreen>
      <StageHeading icon="📱" title="Henry on your phone">
        <p>
          Henry installs as a real app on your iPhone or iPad — no App Store, no TestFlight. Open
          the URL in Safari and tap Add to Home Screen.
        </p>
      </StageHeading>

      <StageCard label="Install on your phone">
        <ol className="space-y-5">
          <StageStep n={1}>Put your phone on the same Wi-Fi as this computer.</StageStep>
          <StageStep n={2}>
            Open Safari on iOS, or Chrome on Android. On iOS it must be Safari.
          </StageStep>
          <StageStep n={3}>
            {lanUrl ? (
              <div className="space-y-3">
                <p>Open this URL, or scan the QR code below:</p>
                <div className="flex items-center gap-3 bg-henry-bg border border-henry-accent/30 rounded-xl px-4 py-3">
                  <code className="text-henry-accent text-sm flex-1 break-all">{lanUrl}</code>
                  <button
                    onClick={() => void copyUrl(lanUrl)}
                    className="text-[11px] text-henry-accent hover:underline flex-shrink-0 font-bold px-2 py-1"
                  >
                    {copied ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-henry-text-muted">Waiting for the sync server…</p>
            )}
          </StageStep>
          <StageStep n={4}>
            Tap the Share button, then <b className="text-henry-text">Add to Home Screen</b>, then
            Add.
          </StageStep>
        </ol>
      </StageCard>

      {pairUrl && (
        <div className="bg-white rounded-2xl p-6 flex flex-col items-center gap-3">
          <p className="text-black/60 text-xs font-medium">Scan with phone camera</p>
          <QrCodeImage value={pairUrl} size={200} />
          <p className="text-black/40 text-[10px]">
            Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
          </p>
        </div>
      )}
      {generating && !pairUrl && (
        <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl py-10 flex items-center justify-center text-henry-text-dim text-sm">
          Generating QR…
        </div>
      )}

      {linked && (
        <StageCard tone="success" className="flex items-center gap-4">
          <span className="text-2xl flex-shrink-0">✓</span>
          <div>
            <p className="text-green-400 font-semibold text-sm">
              {linkedDevices.length} device{linkedDevices.length > 1 ? 's' : ''} connected
            </p>
            <p className="text-henry-text-dim text-sm mt-1">
              {linkedDevices.map((d) => d.name || 'Phone').join(', ')}
            </p>
          </div>
        </StageCard>
      )}

      <StageActions>
        {/* Pairing something is a different decision from not pairing: two
            controls, never one button whose label flips between the two. */}
        {linked && (
          <StagePrimaryAction onClick={onNext}>Done — continue →</StagePrimaryAction>
        )}
        <StageSecondaryAction onClick={onSkip}>Skip — I'll pair my phone later</StageSecondaryAction>
      </StageActions>
    </StageScreen>
  );
}