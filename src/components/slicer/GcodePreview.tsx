/**
 * GcodePreview — a 2D top-down layer preview of sliced G-code (slicer plan, P5).
 *
 * Loads the G-code (lazily, on demand), parses G0/G1 moves into per-layer
 * extrusion polylines, and draws the selected layer on a canvas with a layer
 * slider. Not a full 3D render — a fast, useful "what will it print" view.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseGcode, type Seg } from './gcodeParse';

function api() {
  return typeof window !== 'undefined' ? window.henryAPI : undefined;
}

export default function GcodePreview({ gcodePath }: { gcodePath: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<Seg[][]>([]);
  const [idx, setIdx] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const load = useCallback(async () => {
    setOpen(true);
    if (layers.length) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api()?.slicerReadGcode?.(gcodePath);
      if (!res?.ok || !res.result) { setError(res?.error || 'Could not read the G-code.'); return; }
      const parsed = parseGcode(res.result.text);
      if (!parsed.length) { setError('No printable moves found to preview.'); return; }
      setLayers(parsed);
      setIdx(Math.floor(parsed.length / 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the G-code.');
    } finally {
      setLoading(false);
    }
  }, [gcodePath, layers.length]);

  // Global bounds across all layers → a stable frame while scrubbing.
  const bounds = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const layer of layers) for (const s of layer) {
      minX = Math.min(minX, s.x1, s.x2); minY = Math.min(minY, s.y1, s.y2);
      maxX = Math.max(maxX, s.x1, s.x2); maxY = Math.max(maxY, s.y1, s.y2);
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }, [layers]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const layer = layers[idx];
    if (!layer || !bounds) return;
    const pad = 14;
    const spanX = bounds.maxX - bounds.minX || 1;
    const spanY = bounds.maxY - bounds.minY || 1;
    const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
    const ox = (W - spanX * scale) / 2, oy = (H - spanY * scale) / 2;
    const tx = (x: number) => ox + (x - bounds.minX) * scale;
    const ty = (y: number) => H - (oy + (y - bounds.minY) * scale); // flip Y (printer up vs canvas down)
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--henry-accent').trim() || '#8ab4f8';
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    ctx.strokeStyle = accent;
    ctx.beginPath();
    for (const s of layer) { ctx.moveTo(tx(s.x1), ty(s.y1)); ctx.lineTo(tx(s.x2), ty(s.y2)); }
    ctx.stroke();
  }, [layers, idx, bounds]);

  if (!open) {
    return (
      <button onClick={() => void load()} className="mt-3 text-[11px] text-henry-accent hover:underline">
        Preview layers
      </button>
    );
  }

  return (
    <div className="mt-3 border-t border-henry-border/20 pt-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] text-henry-text-dim">Layer preview</span>
        <button onClick={() => setOpen(false)} className="text-[11px] text-henry-text-muted hover:text-henry-text">Hide</button>
      </div>

      {loading && <div className="text-[11px] text-henry-text-muted py-6 text-center">Reading G-code…</div>}
      {error && <p className="text-[11px] text-red-300">{error}</p>}

      {!loading && !error && layers.length > 0 && (
        <div>
          <div className="bg-henry-bg/60 border border-henry-border/30 rounded-xl flex items-center justify-center p-2">
            <canvas ref={canvasRef} width={300} height={300} className="max-w-full" />
          </div>
          <div className="flex items-center gap-3 mt-2">
            <input
              type="range"
              min={0}
              max={layers.length - 1}
              value={idx}
              onChange={(e) => setIdx(Number(e.target.value))}
              className="flex-1 accent-henry-accent"
            />
            <span className="text-[10px] text-henry-text-muted w-20 text-right">Layer {idx + 1} / {layers.length}</span>
          </div>
        </div>
      )}
    </div>
  );
}
