/**
 * Companion Pairing Screen (mobile side)
 *
 * When no desktop connection is stored, guides the user through pairing:
 *   1. Open Henry on your Mac → Settings → Companion tab
 *   2. Generate a pairing code (QR or manual)
 *   3. On iPhone: scan QR with the camera button, or type the code manually
 *   4. Tap "Link" to complete pairing
 */

import { useState } from 'react';
import { parsePairCode, completePairing } from '../../sync/deviceLink';
import type { CompanionConnectionConfig } from '../../sync/types';
import { hapticSuccess, hapticError } from '../../capacitor';
import { isNative } from '../../capacitor';

interface Props {
  onPaired: (config: CompanionConnectionConfig) => void;
}

type Step = 'intro' | 'code-entry' | 'pairing' | 'error';

export default function CompanionPairing({ onPaired }: Props) {
  const [step, setStep] = useState<Step>('intro');
  const [codeInput, setCodeInput] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [error, setError] = useState('');

  async function tryPair() {
    const parsed = parsePairCode(codeInput.trim());
    if (!parsed) {
      setError('Invalid pairing code. Check the code on your desktop and try again.');
      return;
    }

    setStep('pairing');
    setError('');
    try {
      const pushToken = localStorage.getItem('henry:push_token') ?? undefined;
      const config = await completePairing(parsed, {
        deviceName: deviceName.trim() || undefined,
        pushToken,
      });
      void hapticSuccess();
      onPaired(config);
    } catch (err) {
      void hapticError();
      setError(String(err instanceof Error ? err.message : 'Pairing failed. Make sure your iPhone and desktop are on the same WiFi network.'));
      setStep('code-entry');
    }
  }

  async function scanQR() {
    if (!isNative) {
      setError('Camera scanning requires the native app. Please type the code manually.');
      setStep('code-entry');
      return;
    }
    try {
      // Try to use the BarcodeScanner plugin if available (Vite/tsconfig alias this to a web stub outside native builds)
      const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
      if (!BarcodeScanner) {
        setError('QR scanner not available. Please type the code manually.');
        setStep('code-entry');
        return;
      }
      const { barcodes } = await BarcodeScanner.scan();
      const qrValue = barcodes?.[0]?.rawValue;
      if (qrValue) {
        setCodeInput(qrValue);
        setStep('code-entry');
      }
    } catch {
      setError('Could not open camera. Please type the code manually.');
      setStep('code-entry');
    }
  }

  if (step === 'pairing') {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-6 px-8">
        <div className="w-16 h-16 border-4 border-henry-accent border-t-transparent rounded-full animate-spin" />
        <div className="text-center">
          <p className="text-base font-semibold text-henry-text">Pairing with desktop…</p>
          <p className="text-sm text-henry-text-muted mt-1">Connecting to Henry on your Mac</p>
        </div>
      </div>
    );
  }

  if (step === 'code-entry') {
    return (
      <div className="flex flex-col h-full" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        {/* Header */}
        <div className="shrink-0 flex items-center gap-3 px-4 py-4">
          <button
            onClick={() => { setStep('intro'); setError(''); }}
            className="p-2 -ml-2 text-henry-text-muted active:text-henry-text transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <h1 className="text-lg font-bold text-henry-text">Enter Pairing Code</h1>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-8 space-y-5">
          <div className="bg-henry-surface rounded-2xl p-4 border border-henry-border/20 space-y-3">
            <p className="text-sm text-henry-text-muted leading-relaxed">
              On your Mac, open Henry → Settings → Companion Devices → Add Device. You'll see a pairing code.
            </p>
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-henry-text-muted">Pairing code or QR data</p>
              <input
                value={codeInput}
                onChange={(e) => { setCodeInput(e.target.value); setError(''); }}
                placeholder="e.g. 192.168.1.5:4242:ABCD1234"
                autoComplete="off"
                autoCapitalize="none"
                className="w-full bg-henry-bg rounded-xl px-4 py-3 text-sm font-mono text-henry-text placeholder-henry-text-muted outline-none border border-henry-border/30 focus:border-henry-accent/60 transition-colors"
              />
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-henry-text-muted">Device name (optional)</p>
              <input
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="My iPhone"
                className="w-full bg-henry-bg rounded-xl px-4 py-3 text-sm text-henry-text placeholder-henry-text-muted outline-none border border-henry-border/30 focus:border-henry-accent/60 transition-colors"
              />
            </div>
          </div>

          {error && (
            <div className="bg-henry-error/10 border border-henry-error/30 rounded-2xl px-4 py-3">
              <p className="text-sm text-henry-error">{error}</p>
            </div>
          )}

          <button
            onClick={() => void tryPair()}
            disabled={!codeInput.trim()}
            className="w-full py-4 rounded-2xl bg-henry-accent text-white text-sm font-semibold active:bg-henry-accent/80 transition-colors disabled:opacity-40"
          >
            Link to Desktop
          </button>

          <button
            onClick={() => void scanQR()}
            className="w-full py-3.5 rounded-2xl bg-henry-surface text-henry-text text-sm font-medium border border-henry-border/30 active:bg-henry-surface/70 transition-colors flex items-center justify-center gap-2"
          >
            <span>📷</span> Scan QR Code
          </button>
        </div>
      </div>
    );
  }

  // Intro screen
  return (
    <div
      className="flex flex-col h-full items-center"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex-1 flex flex-col items-center justify-center px-8 gap-8">
        {/* Logo */}
        <div className="w-24 h-24 rounded-3xl bg-henry-accent/10 border border-henry-accent/20 flex items-center justify-center">
          <span className="text-5xl">✦</span>
        </div>

        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-henry-text">Henry Companion</h1>
          <p className="text-sm text-henry-text-dim leading-relaxed">
            Connect your iPhone or iPad to your desktop Henry. Your Mac stays the primary brain — this is your window into it.
          </p>
        </div>

        {/* Feature list */}
        <div className="w-full space-y-3">
          {[
            { icon: '💬', title: 'Read & send chats', desc: 'Full conversation history from your desktop' },
            { icon: '📋', title: 'Monitor tasks', desc: 'See what Henry is working on in real time' },
            { icon: '🎙', title: 'Capture inputs', desc: 'Voice, photos, text — sent to your desktop' },
            { icon: '⚡', title: 'Approve actions', desc: 'Henry asks, you decide from your phone' },
            { icon: '🔔', title: 'Push notifications', desc: 'Task completions, reminders, alerts' },
          ].map((f) => (
            <div key={f.title} className="flex items-center gap-3 bg-henry-surface rounded-2xl px-4 py-3 border border-henry-border/20">
              <span className="text-2xl shrink-0">{f.icon}</span>
              <div>
                <p className="text-sm font-semibold text-henry-text">{f.title}</p>
                <p className="text-xs text-henry-text-muted">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* CTA */}
      <div
        className="shrink-0 w-full px-6 py-4 space-y-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
      >
        <button
          onClick={() => setStep('code-entry')}
          className="w-full py-4 rounded-2xl bg-henry-accent text-white text-base font-semibold active:bg-henry-accent/80 transition-colors"
        >
          Connect to Desktop
        </button>
        <p className="text-xs text-center text-henry-text-muted">
          Requires Henry on your Mac (desktop app)
        </p>
      </div>
    </div>
  );
}
