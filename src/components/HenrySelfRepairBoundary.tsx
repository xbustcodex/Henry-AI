/**
 * Henry AI — Self-Repair Error Boundary
 *
 * Catches React render errors anywhere in the component tree.
 * When a crash occurs it:
 *   1. Logs it to the self-repair error store (persisted in localStorage)
 *   2. In dev mode only (henry:dev_mode = 'true'), dispatches a
 *      henry_action_prompt event so Henry opens in chat with the error
 *      pre-filled. Normal users never see React internals — the crash is
 *      still logged silently to the self-repair store for later review.
 *   3. Shows a clean recovery UI with a reload button
 *
 * Wrap the entire app (or a subtree) with this component.
 */

import { Component, type ReactNode, type ErrorInfo } from 'react';
import { logError } from '../henry/selfRepairStore';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  errorId: string | null;
  errorMessage: string;
  componentStack: string;
}

export class HenrySelfRepairBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      errorId: null,
      errorMessage: '',
      componentStack: '',
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      errorMessage: error.message || String(error),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const componentStack = info.componentStack || '';

    // 1. Log to self-repair store
    const entry = logError('render_crash', error.message || String(error), {
      stack: error.stack,
      component: extractTopComponent(componentStack),
      context: componentStack.split('\n').slice(0, 5).join(' → '),
      severity: 'high',
    });

    this.setState({ errorId: entry.id, componentStack });

    // 2. In DEV MODE ONLY, tell Henry about the crash so it can self-diagnose.
    //    Normal users must never see React internals dumped into chat or get
    //    yanked to the chat view — the crash is already logged above for review.
    let devMode = false;
    try { devMode = localStorage.getItem('henry:dev_mode') === 'true'; } catch { /* default off */ }

    if (devMode) {
      setTimeout(() => {
        try {
          const prompt =
            `I just caught a render crash in the app.\n\n` +
            `Error: ${error.message}\n` +
            `Component: ${extractTopComponent(componentStack)}\n\n` +
            `Can you diagnose this and fix it? The error ID is ${entry.id}.`;

          window.dispatchEvent(
            new CustomEvent('henry_action_prompt', { detail: { prompt } })
          );

          // Also switch to chat view so Henry is visible
          window.dispatchEvent(
            new CustomEvent('henry_navigate', { detail: { view: 'chat' } })
          );
        } catch {
          // Never throw inside componentDidCatch
        }
      }, 800);
    }
  }

  handleReload = () => {
    this.setState({ hasError: false, errorId: null, errorMessage: '', componentStack: '' });
    window.location.reload();
  };

  handleDismiss = () => {
    this.setState({ hasError: false, errorId: null, errorMessage: '', componentStack: '' });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="min-h-screen bg-henry-bg flex items-center justify-center p-8">
        <div className="max-w-lg w-full bg-henry-surface border border-red-500/30 rounded-2xl p-8 space-y-6">
          {/* Icon + Title */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0">
              <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>
            <div>
              <h2 className="text-white font-semibold text-base">This view ran into a problem</h2>
              <p className="text-henry-text-muted text-sm">Your other work is safe. Reload, or try to recover this view.</p>
            </div>
          </div>

          {/* Error details */}
          <div className="bg-black/30 rounded-lg p-4">
            <p className="text-red-300 text-sm font-mono break-words">
              {this.state.errorMessage || 'An unexpected rendering error occurred.'}
            </p>
            {this.state.errorId && (
              <p className="text-henry-text-muted text-xs mt-2">Error ID: {this.state.errorId}</p>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={this.handleReload}
              className="flex-1 py-2.5 px-4 bg-henry-accent hover:bg-henry-accent/80 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Reload app
            </button>
            <button
              onClick={this.handleDismiss}
              className="flex-1 py-2.5 px-4 bg-henry-surface-2 hover:bg-henry-surface-3 text-henry-text-secondary text-sm font-medium rounded-lg transition-colors border border-henry-border"
            >
              Try to recover
            </button>
          </div>

          <p className="text-henry-text-muted text-xs text-center">
            The error was logged on this device. If it keeps happening, the Error ID above helps track it down.
          </p>
        </div>
      </div>
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractTopComponent(componentStack: string): string {
  const match = componentStack.match(/at (\w+)/);
  return match?.[1] ?? 'Unknown';
}

export default HenrySelfRepairBoundary;
