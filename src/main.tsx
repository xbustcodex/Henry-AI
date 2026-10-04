import React from 'react';

// ── Global renderer error safety ─────────────────────────────────────────────
// Catch unhandled JS errors and promise rejections in the renderer
// Sends them to main process for logging without crashing the whole app
// Restore saved accent color on startup
try {
  const savedAccent = localStorage.getItem('henry:accent');
  if (savedAccent) {
    document.documentElement.style.setProperty('--color-accent', savedAccent);
    document.documentElement.style.setProperty('--henry-accent', savedAccent);
  }
} catch { /* ignore */ }

// ── One-time repair: 'henry:working_memory:v1' must be an ARRAY ───────────────
// A legacy webMock path wrote this key as an object ({...updates, updated_at}),
// which collided with the array-based working-memory buffer and made every
// array reader (workingMemory / lifeAreas / threadEngine) throw in the chat-send
// path — Henry would spin forever on "thinking". If the stored value isn't an
// array, drop it so readers fall back to [] and the buffer self-heals.
try {
  const raw = localStorage.getItem('henry:working_memory:v1');
  if (raw && !Array.isArray(JSON.parse(raw))) localStorage.removeItem('henry:working_memory:v1');
} catch { try { localStorage.removeItem('henry:working_memory:v1'); } catch { /* ignore */ } }

import ReactDOM from 'react-dom/client';
import App from './App';
import { HenrySelfRepairBoundary } from './components/HenrySelfRepairBoundary';
import './styles/globals.css';
import './webMock';
import { initCapacitor } from './capacitor';
import { logError } from './henry/selfRepairStore';
import { installProxyShim } from './henry/proxyShim';

// ── Cost-protection shim ─────────────────────────────────────────────────────
// Routes any panel-level proxy calls through callHenryAI so free users never
// run up the developer's bill. Idempotent — safe to call multiple times.
installProxyShim();

// ── Renderer-level error capture ─────────────────────────────────────────────
// These run before React's error boundary catches render crashes.
// They cover async errors (unhandled rejections) and non-render runtime crashes.
window.addEventListener('error', (e) => {
  console.error('[Henry:renderer] Uncaught error:', e.message, e.filename, e.lineno, e.error);
  try {
    logError('runtime', e.message || 'Uncaught error', {
      stack: e.error?.stack,
      context: `${e.filename}:${e.lineno}`,
      severity: 'high',
    });
  } catch { /* never throw inside global handler */ }
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[Henry:renderer] Unhandled rejection:', e.reason);
  e.preventDefault(); // Suppress the default "uncaught (in promise)" crash noise.
  try {
    const msg = e.reason instanceof Error
      ? e.reason.message
      : String(e.reason ?? 'Unhandled promise rejection');
    logError('runtime', msg, {
      stack: e.reason instanceof Error ? e.reason.stack : undefined,
      severity: 'medium',
    });
  } catch { /* never throw inside global handler */ }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HenrySelfRepairBoundary>
      <App />
    </HenrySelfRepairBoundary>
  </React.StrictMode>
);

// Initialize Capacitor native integrations after React mounts
// Safe to call on web — guards internally with isNative check
void initCapacitor();
