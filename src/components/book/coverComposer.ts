/**
 * coverComposer — client-side <canvas> composition for the Cover Studio's
 * "Do it for me" mode. Draws the generated art as a cover-fit background, adds
 * a readability scrim, then overlays title/subtitle/author with genre-aware
 * typography in one of three layout presets. Pure renderer code (needs DOM);
 * the print math lives in src/henry/coverSpecs.ts.
 */

import { getGenre } from '../../henry/coverSpecs';

export type LayoutPresetId = 'classic' | 'top-title' | 'bottom-band';

export const LAYOUT_PRESETS: { id: LayoutPresetId; label: string; hint: string }[] = [
  { id: 'classic', label: 'Classic centered', hint: 'Title up top, author at the base — the timeless look.' },
  { id: 'top-title', label: 'Top title', hint: 'Big title block in the upper third, art breathes below.' },
  { id: 'bottom-band', label: 'Bottom band', hint: 'Solid band at the base carrying all the type.' },
];

export interface ComposeInput {
  /** Decoded art image, or null to draw a genre-toned gradient fallback. */
  image: HTMLImageElement | null;
  width: number;
  height: number;
  title: string;
  subtitle?: string;
  author: string;
  genreId: string;
  layout: LayoutPresetId;
}

const SERIF_STACK = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
const SANS_STACK = '"Avenir Next", "Helvetica Neue", Helvetica, Arial, sans-serif';

/** Fallback background tones per genre when no art has been generated yet. */
const FALLBACK_TONES: Record<string, [string, string]> = {
  memoir: ['#3d3227', '#8a6f52'],
  faith: ['#1a2a4a', '#c9a227'],
  selfhelp: ['#0e7490', '#38bdf8'],
  business: ['#111827', '#374151'],
  thriller: ['#0b0f14', '#26323d'],
  mystery: ['#131a24', '#2d3a4a'],
  romance: ['#7c2d4f', '#e8a0a8'],
  fantasy: ['#241a3d', '#5b3a8c'],
  scifi: ['#04121f', '#0e5a72'],
  literary: ['#2f2b28', '#6b625a'],
  children: ['#f59e0b', '#fbbf24'],
};

function fallbackTones(genreId: string): [string, string] {
  const t = FALLBACK_TONES[genreId];
  return Array.isArray(t) && t[0].length === 7 && t[1].length === 7 ? t : ['#2f2b28', '#6b625a'];
}

/** Draw an image covering the canvas (like CSS object-fit: cover). */
function drawCoverFit(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** Average relative luminance (0..1) of a canvas region — drives auto-contrast. */
function regionLuminance(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): number {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const rx = Math.max(0, Math.min(cw - 1, Math.floor(x)));
  const ry = Math.max(0, Math.min(ch - 1, Math.floor(y)));
  const rw = Math.max(1, Math.min(cw - rx, Math.floor(w)));
  const rh = Math.max(1, Math.min(ch - ry, Math.floor(h)));
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(rx, ry, rw, rh).data;
  } catch {
    return 0.35; // tainted canvas — assume darkish, use light text
  }
  let sum = 0;
  let count = 0;
  const step = Math.max(4, Math.floor(data.length / 4 / 4000) * 4); // sample ≤ ~4000 px
  for (let i = 0; i < data.length; i += step) {
    sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    count++;
  }
  return count ? sum / count : 0.35;
}

/** Word-wrap `text` into lines that fit `maxWidth` with the current ctx font. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const probe = line ? `${line} ${word}` : word;
    if (ctx.measureText(probe).width <= maxWidth || !line) {
      line = probe;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Pick the largest font size (≤ startPx) at which `text` wraps into at most
 * `maxLines` lines within `maxWidth`. Returns the size and the wrapped lines.
 */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontTemplate: (px: number) => string,
  startPx: number,
  minPx: number,
  maxWidth: number,
  maxLines: number,
): { px: number; lines: string[] } {
  for (let px = startPx; px >= minPx; px -= Math.max(1, Math.round(startPx * 0.05))) {
    ctx.font = fontTemplate(px);
    const lines = wrapLines(ctx, text, maxWidth);
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxWidth)) {
      return { px, lines };
    }
  }
  ctx.font = fontTemplate(minPx);
  return { px: minPx, lines: wrapLines(ctx, text, maxWidth) };
}

interface TextBlockSpec {
  yCenterFrac: number; // where the whole block centers vertically (fraction of height)
  scrim: 'top' | 'bottom' | 'both' | 'band';
}

const LAYOUT_GEOMETRY: Record<LayoutPresetId, TextBlockSpec> = {
  classic: { yCenterFrac: 0.18, scrim: 'both' },
  'top-title': { yCenterFrac: 0.2, scrim: 'top' },
  'bottom-band': { yCenterFrac: 0.82, scrim: 'band' },
};

/**
 * Compose the full cover onto `canvas` at width×height. Deterministic given the
 * same input — safe to re-run on every layout/brief change.
 */
export function composeCover(canvas: HTMLCanvasElement, input: ComposeInput): void {
  const { width: w, height: h } = input;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const genre = getGenre(input.genreId);
  const stack = genre.typography === 'serif' ? SERIF_STACK : SANS_STACK;
  const geometry = LAYOUT_GEOMETRY[input.layout] ?? LAYOUT_GEOMETRY.classic;

  // ── 1. Background ──────────────────────────────────────────────────────────
  if (input.image) {
    drawCoverFit(ctx, input.image, w, h);
  } else {
    const [c1, c2] = fallbackTones(input.genreId);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // ── 2. Auto-contrast: sample the zones the text will sit on ───────────────
  const titleZoneY = input.layout === 'bottom-band' ? h * 0.68 : h * 0.06;
  const titleLum = regionLuminance(ctx, w * 0.1, titleZoneY, w * 0.8, h * 0.24);
  const lightText = titleLum < 0.55;
  const textColor = lightText ? '#f7f5f0' : '#171310';
  const mutedColor = lightText ? 'rgba(247,245,240,0.82)' : 'rgba(23,19,16,0.82)';
  const scrimColor = lightText ? 'rgba(8,8,10,' : 'rgba(250,249,246,';

  // ── 3. Scrim for readability ───────────────────────────────────────────────
  if (geometry.scrim === 'band') {
    const bandTop = h * 0.64;
    const fade = ctx.createLinearGradient(0, bandTop - h * 0.08, 0, bandTop);
    fade.addColorStop(0, `${scrimColor}0)`);
    fade.addColorStop(1, `${scrimColor}0.72)`);
    ctx.fillStyle = fade;
    ctx.fillRect(0, bandTop - h * 0.08, w, h * 0.08);
    ctx.fillStyle = `${scrimColor}0.72)`;
    ctx.fillRect(0, bandTop, w, h - bandTop);
  } else {
    if (geometry.scrim === 'top' || geometry.scrim === 'both') {
      const g = ctx.createLinearGradient(0, 0, 0, h * 0.42);
      g.addColorStop(0, `${scrimColor}0.55)`);
      g.addColorStop(1, `${scrimColor}0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h * 0.42);
    }
    if (geometry.scrim === 'both') {
      const g = ctx.createLinearGradient(0, h * 0.72, 0, h);
      g.addColorStop(0, `${scrimColor}0)`);
      g.addColorStop(1, `${scrimColor}0.6)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, h * 0.72, w, h * 0.28);
    }
  }

  // ── 4. Type ────────────────────────────────────────────────────────────────
  const margin = w * 0.09;
  const maxWidth = w - margin * 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = lightText ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.5)';
  ctx.shadowBlur = Math.round(w * 0.012);
  ctx.shadowOffsetY = Math.round(w * 0.004);

  const title = (input.title || 'Untitled').trim();
  const displayTitle = genre.typography === 'sans' ? title.toUpperCase() : title;
  const titleFont = (px: number) =>
    genre.typography === 'sans' ? `700 ${px}px ${stack}` : `600 ${px}px ${stack}`;
  const titleFit = fitText(ctx, displayTitle, titleFont, Math.round(w * 0.14), Math.round(w * 0.05), maxWidth, 3);
  const titleLineH = titleFit.px * 1.12;

  const subtitle = input.subtitle?.trim() || '';
  const subFit = subtitle
    ? fitText(ctx, subtitle, (px) => `400 italic ${px}px ${stack}`, Math.round(titleFit.px * 0.42), Math.round(w * 0.028), maxWidth, 2)
    : null;
  const subLineH = subFit ? subFit.px * 1.3 : 0;

  const author = (input.author || '').trim();
  const authorPx = Math.max(Math.round(w * 0.035), Math.round(titleFit.px * 0.3));
  const authorLineH = authorPx * 1.2;

  const gap = titleFit.px * 0.45;
  const blockH =
    titleFit.lines.length * titleLineH +
    (subFit ? gap + subFit.lines.length * subLineH : 0);

  // Title + subtitle block
  let blockTop: number;
  if (input.layout === 'bottom-band') {
    const bandCenter = h * geometry.yCenterFrac;
    blockTop = bandCenter - (blockH + (author ? gap + authorLineH : 0)) / 2;
  } else {
    blockTop = h * geometry.yCenterFrac - blockH / 2;
    blockTop = Math.max(h * 0.05, blockTop);
  }

  let y = blockTop + titleFit.px;
  ctx.fillStyle = textColor;
  ctx.font = titleFont(titleFit.px);
  for (const line of titleFit.lines) {
    ctx.fillText(line, w / 2, y);
    y += titleLineH;
  }
  y -= titleLineH;

  if (subFit) {
    y += gap + subFit.px;
    ctx.fillStyle = mutedColor;
    ctx.font = `italic 400 ${subFit.px}px ${stack}`;
    for (const line of subFit.lines) {
      ctx.fillText(line, w / 2, y);
      y += subLineH;
    }
    y -= subLineH;
  }

  // Author placement
  if (author) {
    ctx.fillStyle = textColor;
    const displayAuthor = genre.typography === 'sans' ? author.toUpperCase() : author;
    ctx.font = `500 ${authorPx}px ${stack}`;
    if (input.layout === 'bottom-band') {
      ctx.fillText(displayAuthor, w / 2, y + gap + authorPx);
    } else {
      // Bottom of the cover, inside the lower scrim / safe area
      const authorY = h * 0.94;
      // hairline rule above the author name for the classic look
      if (input.layout === 'classic') {
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.strokeStyle = mutedColor;
        ctx.lineWidth = Math.max(1, Math.round(w * 0.0015));
        const ruleW = Math.min(maxWidth * 0.4, ctx.measureText(displayAuthor).width * 1.2);
        ctx.beginPath();
        ctx.moveTo(w / 2 - ruleW / 2, authorY - authorPx * 1.5);
        ctx.lineTo(w / 2 + ruleW / 2, authorY - authorPx * 1.5);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fillText(displayAuthor, w / 2, authorY);
    }
  }

  // reset shadows for any later drawing
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

/** Decode a data-URL / object-URL image for canvas use. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the generated artwork.'));
    img.src = src;
  });
}

/** Render a full composition and return it as a PNG data URL at the given size. */
export function renderCoverPng(input: ComposeInput): string {
  const canvas = document.createElement('canvas');
  composeCover(canvas, input);
  return canvas.toDataURL('image/png');
}

/** Trigger a browser download of a data URL. */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
