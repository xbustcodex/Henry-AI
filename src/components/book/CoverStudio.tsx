/**
 * CoverStudio — Book panel section where Henry designs the book's cover two ways:
 *
 *   A. "Teach me"  — a tailored step-by-step guide (chat model via modelRouter +
 *      sendMessage) with THIS book's exact KDP dimensions baked in; saveable to
 *      the workspace as markdown via the fs IPC.
 *   B. "Do it for me" — front-cover art from the existing image plumbing
 *      (DALL-E 3 with the OpenAI key, same call the ImageGen panel makes; free
 *      Pollinations.ai fallback without a key), composed client-side on a
 *      <canvas> with genre-aware typography and exported as ebook + print PNGs.
 *
 * Print math and prompt builders are pure functions in src/henry/coverSpecs.ts.
 * PNG exports use browser download (the fs:writeFile IPC is UTF-8 text only);
 * the guide and print-specs text are saved into the Henry workspace.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useStore } from '../../store';
import { resolveChat } from '../../henry/modelRouter';
import {
  EBOOK_COVER,
  GENRES,
  PAPER_TYPES,
  TRIM_SIZES,
  buildArtPrompt,
  buildPrintSpecsText,
  buildTeachMePrompt,
  clampPageCount,
  coverSlug,
  formatIn,
  frontCoverPrintPixels,
  fullWrapSpec,
  getGenre,
} from '../../henry/coverSpecs';
import type { CoverBrief, PaperType } from '../../henry/coverSpecs';
import {
  LAYOUT_PRESETS,
  downloadDataUrl,
  loadImage,
  renderCoverPng,
} from './coverComposer';
import type { LayoutPresetId } from './coverComposer';

type Mode = 'teach' | 'make';

function api() {
  return typeof window !== 'undefined' ? window.henryAPI : undefined;
}

const GUIDE_SYSTEM_PROMPT =
  'You are Henry, a warm and practical book-design coach. You write clear, encouraging, step-by-step guides for first-time self-publishers. Use the exact dimensions the user provides — never recalculate or invent numbers. Output well-structured markdown.';

export default function CoverStudio() {
  const { providers, settings, setCurrentView } = useStore();

  // ── The cover brief ─────────────────────────────────────────────────────
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [author, setAuthor] = useState('');
  const [genreId, setGenreId] = useState('memoir');
  const [notes, setNotes] = useState('');
  const [trimId, setTrimId] = useState('6x9');
  const [pageCountRaw, setPageCountRaw] = useState('300');
  const [paper, setPaper] = useState<PaperType>('white');

  const pageCount = clampPageCount(parseInt(pageCountRaw, 10) || 0, paper);
  const brief: CoverBrief = useMemo(
    () => ({
      title: title.trim() || 'Untitled',
      subtitle: subtitle.trim() || undefined,
      author: author.trim() || 'Author Name',
      genreId,
      notes: notes.trim() || undefined,
      trimId,
      pageCount,
      paper,
    }),
    [title, subtitle, author, genreId, notes, trimId, pageCount, paper],
  );

  const wrap = useMemo(() => fullWrapSpec(trimId, pageCount, paper), [trimId, pageCount, paper]);
  const frontPx = useMemo(() => frontCoverPrintPixels(trimId), [trimId]);

  const [mode, setMode] = useState<Mode>('teach');

  // ── Mode A — Teach me ───────────────────────────────────────────────────
  const [guide, setGuide] = useState<string | null>(null);
  const [guideBusy, setGuideBusy] = useState(false);
  const [guideError, setGuideError] = useState<string | null>(null);
  const [guideSavedTo, setGuideSavedTo] = useState<string | null>(null);

  const generateGuide = useCallback(async () => {
    if (guideBusy) return;
    setGuideBusy(true);
    setGuideError(null);
    setGuideSavedTo(null);
    try {
      const a = api();
      if (!a?.sendMessage) {
        throw new Error('Guide generation needs the desktop app (chat engine unavailable here).');
      }
      const prompt = buildTeachMePrompt(brief);
      const route = resolveChat(prompt, settings, providers); // throws with a clear message if no key
      const res = await a.sendMessage({
        provider: route.provider,
        model: route.model,
        apiKey: route.apiKey,
        messages: [
          { role: 'system', content: GUIDE_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.4,
        maxTokens: 3500,
      });
      const content = res?.content?.trim();
      if (!content) throw new Error('The model returned an empty guide — try again.');
      setGuide(content);
    } catch (e) {
      setGuideError(e instanceof Error ? e.message : 'Could not generate the guide.');
    } finally {
      setGuideBusy(false);
    }
  }, [brief, guideBusy, providers, settings]);

  const saveGuide = useCallback(async () => {
    if (!guide) return;
    const slug = coverSlug(brief.title);
    const rel = `covers/${slug}/cover-guide-${new Date().toISOString().slice(0, 10)}.md`;
    const a = api();
    try {
      if (a?.writeFile) {
        await a.writeFile(rel, guide);
        setGuideSavedTo(rel);
        return;
      }
      throw new Error('no fs');
    } catch {
      // Browser / web-mode fallback: download the markdown instead
      downloadDataUrl(
        `data:text/markdown;charset=utf-8,${encodeURIComponent(guide)}`,
        `${slug}-cover-guide.md`,
      );
      setGuideSavedTo('(downloaded — workspace unavailable)');
    }
  }, [brief.title, guide]);

  // ── Mode B — Do it for me ───────────────────────────────────────────────
  const openaiKey = providers.find((p) => p.id === 'openai')?.apiKey || '';

  const [artUrl, setArtUrl] = useState<string | null>(null); // data URL of generated art
  const [artBusy, setArtBusy] = useState(false);
  const [artError, setArtError] = useState<string | null>(null);
  const [layout, setLayout] = useState<LayoutPresetId>(getGenre('memoir').defaultLayout);
  const [layoutTouched, setLayoutTouched] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const artImgRef = useRef<HTMLImageElement | null>(null);

  // Follow the genre's default layout until the user picks one themselves.
  useEffect(() => {
    if (!layoutTouched) setLayout(getGenre(genreId).defaultLayout);
  }, [genreId, layoutTouched]);

  const generateArt = useCallback(async () => {
    if (artBusy) return;
    setArtBusy(true);
    setArtError(null);
    try {
      const prompt = buildArtPrompt(brief);
      let dataUrl: string;
      if (openaiKey) {
        // Same provider plumbing the ImageGen panel uses: DALL-E 3, b64 response.
        const res = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
          body: JSON.stringify({
            model: 'dall-e-3',
            prompt,
            n: 1,
            size: '1024x1792', // portrait — closest DALL-E size to a book cover
            quality: 'hd',
            response_format: 'b64_json',
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
          throw new Error(err?.error?.message || 'Image generation failed');
        }
        const data = await res.json();
        const b64 = data.data?.[0]?.b64_json;
        if (!b64) throw new Error('No image returned');
        dataUrl = `data:image/png;base64,${b64}`;
      } else {
        // Free fallback (same as the ImageGen panel): Pollinations.ai, no key.
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1792&nologo=true&enhance=true`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Free image service failed (${res.status})`);
        const blob = await res.blob();
        dataUrl = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error('Could not read the generated image.'));
          r.readAsDataURL(blob);
        });
      }
      artImgRef.current = await loadImage(dataUrl);
      setArtUrl(dataUrl);
    } catch (e) {
      setArtError(e instanceof Error ? e.message : 'Could not generate cover art.');
    } finally {
      setArtBusy(false);
    }
  }, [artBusy, brief, openaiKey]);

  // Re-compose the ebook-size preview whenever the brief, art, or layout changes.
  useEffect(() => {
    if (mode !== 'make') return;
    const t = setTimeout(() => {
      setPreviewUrl(
        renderCoverPng({
          image: artImgRef.current,
          width: EBOOK_COVER.widthPx,
          height: EBOOK_COVER.heightPx,
          title: brief.title,
          subtitle: brief.subtitle,
          author: brief.author,
          genreId,
          layout,
        }),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [mode, artUrl, brief.title, brief.subtitle, brief.author, genreId, layout]);

  const savePrintSpecs = useCallback(async (): Promise<string> => {
    const slug = coverSlug(brief.title);
    const rel = `covers/${slug}/print-specs.txt`;
    const text = buildPrintSpecsText(brief);
    const a = api();
    try {
      if (a?.writeFile) {
        await a.writeFile(rel, text);
        return rel;
      }
      throw new Error('no fs');
    } catch {
      downloadDataUrl(`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`, `${slug}-print-specs.txt`);
      return '(downloaded — workspace unavailable)';
    }
  }, [brief]);

  const exportEbook = useCallback(async () => {
    const slug = coverSlug(brief.title);
    const png = renderCoverPng({
      image: artImgRef.current,
      width: EBOOK_COVER.widthPx,
      height: EBOOK_COVER.heightPx,
      title: brief.title,
      subtitle: brief.subtitle,
      author: brief.author,
      genreId,
      layout,
    });
    downloadDataUrl(png, `${slug}-ebook-cover-${EBOOK_COVER.widthPx}x${EBOOK_COVER.heightPx}.png`);
    const specsPath = await savePrintSpecs();
    setExportNote(`Ebook cover downloaded. Print specs saved to workspace: ${specsPath}`);
  }, [brief, genreId, layout, savePrintSpecs]);

  const exportPrintFront = useCallback(async () => {
    const slug = coverSlug(brief.title);
    const png = renderCoverPng({
      image: artImgRef.current,
      width: frontPx.widthPx,
      height: frontPx.heightPx,
      title: brief.title,
      subtitle: brief.subtitle,
      author: brief.author,
      genreId,
      layout,
    });
    downloadDataUrl(png, `${slug}-print-front-${frontPx.widthPx}x${frontPx.heightPx}.png`);
    const specsPath = await savePrintSpecs();
    setExportNote(`Print front cover downloaded (300 DPI). Print specs saved to workspace: ${specsPath}`);
  }, [brief, frontPx, genreId, layout, savePrintSpecs]);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Brief */}
      <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4 mb-4">
        <h2 className="text-sm font-semibold text-henry-text mb-3">Cover brief</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Book title" className={inputCls} />
          <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="Subtitle (optional)" className={inputCls} />
          <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Author name" className={inputCls} />
          <select value={genreId} onChange={(e) => setGenreId(e.target.value)} className={inputCls}>
            {GENRES.map((g) => (
              <option key={g.id} value={g.id}>{g.label}</option>
            ))}
          </select>
        </div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Art direction / mood notes (optional) — e.g. 'dawn light over an Arkansas field, hopeful'"
          rows={2}
          className={`${inputCls} w-full resize-y mb-2`}
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[11px] text-henry-text-muted">Trim</label>
          <select value={trimId} onChange={(e) => setTrimId(e.target.value)} className={inputCls}>
            {TRIM_SIZES.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          <label className="text-[11px] text-henry-text-muted ml-2">Pages</label>
          <input
            value={pageCountRaw}
            onChange={(e) => setPageCountRaw(e.target.value.replace(/[^0-9]/g, ''))}
            inputMode="numeric"
            className={`${inputCls} w-20`}
          />
          <select value={paper} onChange={(e) => setPaper(e.target.value as PaperType)} className={inputCls}>
            {PAPER_TYPES.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        {/* Live spec line — computed from coverSpecs */}
        <p className="text-[11px] text-henry-text-muted mt-3 leading-relaxed">
          Spine {formatIn(wrap.spineIn)}{wrap.spineTextOk ? '' : ' (too thin for spine text)'} ·
          Full wrap {formatIn(wrap.widthIn)} × {formatIn(wrap.heightIn)} = {wrap.widthPx} × {wrap.heightPx} px @300 DPI ·
          Front {frontPx.widthPx} × {frontPx.heightPx} px ·
          Ebook {EBOOK_COVER.widthPx} × {EBOOK_COVER.heightPx} px
        </p>
      </div>

      {/* Mode switch */}
      <div className="flex gap-1.5 mb-4">
        <ModeButton active={mode === 'teach'} onClick={() => setMode('teach')} label="🎓 Teach me" sub="Step-by-step guide, you build it" />
        <ModeButton active={mode === 'make'} onClick={() => setMode('make')} label="🎨 Do it for me" sub="Henry generates + composes the cover" />
      </div>

      {mode === 'teach' ? (
        <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4">
          <p className="text-xs text-henry-text-muted mb-3 leading-relaxed">
            Henry writes you a complete guide — concept and genre conventions, the exact pixel dimensions for <em>your</em> book (already computed above), free tools (Canva, GIMP), typography, and KDP upload steps.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void generateGuide()}
              disabled={guideBusy}
              className="px-4 py-2 rounded-xl text-sm font-medium bg-henry-accent/20 text-henry-accent hover:bg-henry-accent/30 transition-colors disabled:opacity-40"
            >
              {guideBusy ? 'Writing your guide…' : guide ? 'Rewrite the guide' : 'Write my step-by-step guide'}
            </button>
            {guide && (
              <button onClick={() => void saveGuide()} className="px-4 py-2 rounded-xl text-sm font-medium bg-henry-surface border border-henry-border/40 text-henry-text-muted hover:text-henry-text transition-colors">
                Save to workspace
              </button>
            )}
          </div>
          {guideSavedTo && <p className="text-[11px] text-henry-accent mt-2">Saved: {guideSavedTo}</p>}
          {guideError && (
            <div className="mt-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-300">
              {guideError}
              {/no api key/i.test(guideError) && (
                <button onClick={() => setCurrentView('settings')} className="block mt-1 text-henry-accent hover:underline">Open Settings</button>
              )}
            </div>
          )}
          {guide && (
            <div className="mt-4 border-t border-henry-border/30 pt-4 text-sm text-henry-text leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2 [&_li]:my-0.5 [&_strong]:text-henry-text [&_code]:text-henry-accent [&_code]:text-xs [&_a]:text-henry-accent">
              <ReactMarkdown>{guide}</ReactMarkdown>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[1fr_minmax(220px,300px)] gap-4">
          {/* Controls */}
          <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4 min-w-0">
            {!openaiKey && (
              <div className="mb-3 px-3 py-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-300 leading-relaxed">
                No image provider key is configured, so art quality will be limited.{' '}
                <button onClick={() => setCurrentView('settings')} className="text-henry-accent hover:underline">Add an OpenAI key in Settings</button>{' '}
                for DALL-E 3 quality — or use <strong>Teach me</strong> mode meanwhile. The button below falls back to the free Pollinations.ai service.
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <button
                onClick={() => void generateArt()}
                disabled={artBusy}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-henry-accent/20 text-henry-accent hover:bg-henry-accent/30 transition-colors disabled:opacity-40"
              >
                {artBusy ? 'Generating art…' : artUrl ? '🔄 Regenerate art' : openaiKey ? '🎨 Generate cover art (DALL-E 3)' : '🎨 Generate free art (Pollinations)'}
              </button>
              {!artUrl && !artBusy && (
                <span className="text-[11px] text-henry-text-muted">No art yet — the preview uses a genre-toned background, so you can design type-only too.</span>
              )}
            </div>
            {artError && (
              <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-300">{artError}</div>
            )}

            {/* Layout presets */}
            <p className="text-[11px] text-henry-text-muted mb-1.5">Layout</p>
            <div className="flex flex-wrap gap-1.5 mb-4">
              {LAYOUT_PRESETS.map((l) => (
                <button
                  key={l.id}
                  onClick={() => { setLayout(l.id); setLayoutTouched(true); }}
                  title={l.hint}
                  className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors border ${
                    layout === l.id
                      ? 'bg-henry-accent/15 border-henry-accent/40 text-henry-accent'
                      : 'border-henry-border/30 text-henry-text-muted hover:text-henry-text'
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>

            {/* Exports */}
            <p className="text-[11px] text-henry-text-muted mb-1.5">Export</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => void exportEbook()} className={exportBtnCls}>
                Ebook PNG · {EBOOK_COVER.widthPx}×{EBOOK_COVER.heightPx}
              </button>
              <button onClick={() => void exportPrintFront()} className={exportBtnCls}>
                Print front PNG · {frontPx.widthPx}×{frontPx.heightPx} @300 DPI
              </button>
              <button
                onClick={() => { void savePrintSpecs().then((p) => setExportNote(`Print specs saved: ${p}`)); }}
                className={exportBtnCls}
              >
                Save print specs (.txt)
              </button>
            </div>
            {exportNote && <p className="text-[11px] text-henry-accent mt-2">{exportNote}</p>}
            <p className="text-[10px] text-henry-text-dim mt-3 leading-relaxed">
              PNGs download to your computer; the print-specs text is saved into your Henry workspace under <code>covers/</code>.
              Heads-up: Henry exports the <strong>front</strong> cover only — the full-wrap print PDF (back + spine {formatIn(wrap.spineIn)} + front = {formatIn(wrap.widthIn)} × {formatIn(wrap.heightIn)}, {wrap.widthPx} × {wrap.heightPx} px) is finished in Canva using the saved print specs.
            </p>
          </div>

          {/* Preview at true ebook aspect ratio (1600:2560 = 5:8) */}
          <div className="min-w-0">
            <p className="text-[11px] text-henry-text-muted mb-1.5">Preview</p>
            <div className="rounded-xl overflow-hidden border border-henry-border/30 bg-henry-surface/40" style={{ aspectRatio: `${EBOOK_COVER.widthPx} / ${EBOOK_COVER.heightPx}` }}>
              {previewUrl ? (
                <img src={previewUrl} alt="Cover preview" className="w-full h-full object-contain" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs text-henry-text-dim">Composing…</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls =
  'bg-henry-surface border border-henry-border/30 rounded-lg px-3 py-1.5 text-sm text-henry-text placeholder:text-henry-text-muted outline-none';

const exportBtnCls =
  'px-3 py-2 rounded-xl text-xs font-medium bg-henry-surface border border-henry-border/40 text-henry-text-muted hover:text-henry-text hover:border-henry-accent/30 transition-colors';

function ModeButton({ active, onClick, label, sub }: { active: boolean; onClick: () => void; label: string; sub: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 text-left px-4 py-3 rounded-2xl border transition-colors ${
        active
          ? 'bg-henry-accent/10 border-henry-accent/40'
          : 'bg-henry-surface/40 border-henry-border/30 hover:border-henry-border/60'
      }`}
    >
      <span className={`block text-sm font-medium ${active ? 'text-henry-accent' : 'text-henry-text'}`}>{label}</span>
      <span className="block text-[11px] text-henry-text-muted mt-0.5">{sub}</span>
    </button>
  );
}
