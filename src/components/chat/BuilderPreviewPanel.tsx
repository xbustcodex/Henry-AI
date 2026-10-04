import { useState, useEffect, useRef } from 'react';
import { downloadHtml, extractPartialHtmlFromStream } from '../../henry/builderPreview';

type Viewport = 'mobile' | 'tablet' | 'desktop';

const VIEWPORTS: { id: Viewport; label: string; icon: string; width: number }[] = [
  { id: 'mobile',  label: 'Mobile',  icon: '📱', width: 390  },
  { id: 'tablet',  label: 'Tablet',  icon: '▭',  width: 768  },
  { id: 'desktop', label: 'Desktop', icon: '🖥️', width: 0    },
];

interface Props {
  html: string | null;
  isStreaming: boolean;
  streamingHtml: string;
  onClose: () => void;
}

export default function BuilderPreviewPanel({ html, isStreaming, streamingHtml, onClose }: Props) {
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [iframeKey, setIframeKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (html) setIframeKey((k) => k + 1);
  }, [html]);

  const vp = VIEWPORTS.find((v) => v.id === viewport)!;
  const partialStreamHtml = isStreaming ? extractPartialHtmlFromStream(streamingHtml) : null;
  const displayHtml = html ?? partialStreamHtml;

  function openInTab() {
    if (!displayHtml) return;
    const blob = new Blob([displayHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  return (
    <div className="w-[46%] shrink-0 flex flex-col border-l border-henry-border/30 bg-[#0f1117] min-h-0">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 border-b border-henry-border/20 bg-henry-surface/30">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="text-[10px] font-semibold text-henry-accent uppercase tracking-wider">Live Preview</span>
          {isStreaming && (
            <span className="flex items-center gap-1 text-[10px] text-henry-accent/70">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-henry-accent animate-pulse" />
              building…
            </span>
          )}
        </div>

        {/* Viewport toggles */}
        <div className="flex items-center rounded-md border border-henry-border/30 overflow-hidden shrink-0">
          {VIEWPORTS.map((v) => (
            <button
              key={v.id}
              onClick={() => setViewport(v.id)}
              title={v.label}
              className={`px-2 py-1 text-[11px] transition-colors ${
                viewport === v.id
                  ? 'bg-henry-accent/20 text-henry-accent'
                  : 'text-henry-text-muted hover:text-henry-text hover:bg-henry-hover/40'
              }`}
            >
              {v.icon}
            </button>
          ))}
        </div>

        {/* Actions */}
        <button
          onClick={() => setIframeKey((k) => k + 1)}
          title="Refresh preview"
          className="p-1.5 rounded text-henry-text-muted hover:text-henry-text hover:bg-henry-hover/40 transition-colors"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 4v6h6M23 20v-6h-6" />
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
          </svg>
        </button>

        <button
          onClick={openInTab}
          disabled={!displayHtml}
          title="Open in new tab"
          className="p-1.5 rounded text-henry-text-muted hover:text-henry-text hover:bg-henry-hover/40 transition-colors disabled:opacity-30"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>

        <button
          onClick={() => displayHtml && downloadHtml(displayHtml)}
          disabled={!displayHtml}
          title="Download HTML"
          className="p-1.5 rounded text-henry-text-muted hover:text-henry-text hover:bg-henry-hover/40 transition-colors disabled:opacity-30"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>

        <button
          onClick={onClose}
          title="Close preview"
          className="p-1.5 rounded text-henry-text-muted hover:text-henry-text hover:bg-henry-hover/40 transition-colors"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Preview area */}
      <div className="flex-1 overflow-hidden flex items-start justify-center bg-gray-200 min-h-0">
        {!displayHtml && !isStreaming ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-10">
            <span className="text-5xl">🏗️</span>
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-1">Ready to build</p>
              <p className="text-xs text-gray-500 leading-relaxed">
                Describe the website or app you want. Henry will generate it and show the live preview here.
              </p>
            </div>
            <div className="text-[10px] text-gray-400 space-y-0.5 text-left">
              {[
                '"Build a task manager app"',
                '"Make a landing page for my bakery"',
                '"Create a dashboard with charts"',
                '"Build a countdown timer"',
              ].map((ex) => (
                <p key={ex}>{ex}</p>
              ))}
            </div>
          </div>
        ) : isStreaming && !displayHtml ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="w-8 h-8 border-2 border-henry-accent/30 border-t-henry-accent rounded-full animate-spin" />
            <p className="text-sm text-gray-500">Building your app…</p>
          </div>
        ) : (
          <div
            className="h-full transition-all duration-300 shadow-lg"
            style={{ width: vp.width > 0 ? `${vp.width}px` : '100%' }}
          >
            <iframe
              key={iframeKey}
              ref={iframeRef}
              srcDoc={displayHtml ?? ''}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-modals allow-forms allow-popups allow-same-origin"
              title="Henry App Preview"
            />
          </div>
        )}
      </div>

      {/* Footer hint */}
      {displayHtml && (
        <div className="shrink-0 px-3 py-1.5 border-t border-henry-border/20 bg-henry-surface/20">
          <p className="text-[10px] text-henry-text-muted">
            Tell Henry to change anything — he'll regenerate the full app instantly.
          </p>
        </div>
      )}
    </div>
  );
}
