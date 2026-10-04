import { useState, useCallback } from 'react';
import { useStore } from '../../store';
import { henryQuickAsk } from '../../henry/henryQuickAsk';

interface GeneratedImage {
  id: string;
  prompt: string;
  url: string;
  revisedPrompt?: string;
  createdAt: string;
  size: string;
  style: string;
}

const SIZES = ['1024x1024', '1792x1024', '1024x1792'] as const;
type ImageSize = typeof SIZES[number];
const STYLES = ['vivid', 'natural'] as const;
type ImageStyle = typeof STYLES[number];

const HISTORY_KEY = 'henry:imagegen:history';

function loadHistory(): GeneratedImage[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}
function saveToHistory(img: GeneratedImage) {
  // Store only metadata, not the base64 data — keeps localStorage lean
  const meta = { ...img, url: img.url.startsWith('data:') ? '[base64-omitted]' : img.url };
  const h = loadHistory().filter(i => i.id !== img.id);
  h.unshift(meta);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 50)));
  } catch { /* ignore */ }
}

// In-session image store (keeps base64 alive until page reload)
const SESSION_IMAGES = new Map<string, string>();

export default function ImageGenPanel() {
  const { providers } = useStore();
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState<ImageSize>('1024x1024');
  const [style, setStyle] = useState<ImageStyle>('vivid');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<GeneratedImage[]>(loadHistory);
  const [selectedImage, setSelectedImage] = useState<GeneratedImage | null>(null);

  const openaiProvider = providers.find((p) => p.id === 'openai');
  const openaiKey = openaiProvider?.apiKey || '';

  async function generate() {
    if (!prompt.trim() || generating) return;
    if (!openaiKey) {
      // Free fallback: use Pollinations.ai (free, no key needed)
      setGenerating(true);
      setError(null);
      try {
        const encoded = encodeURIComponent(prompt.trim());
        const freeUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&enhance=true`;
        const newImg: GeneratedImage = { id: crypto.randomUUID(), url: freeUrl, prompt: prompt.trim(), size: '1024x1024', style: 'vivid', revisedPrompt: undefined, createdAt: new Date().toISOString() };
        const updated = [newImg, ...history.slice(0, 49)];
        setHistory(updated);
        setSelectedImage(newImg);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
      } catch (e: any) {
        setError('Free image generation failed: ' + (e as Error).message);
      }
      setGenerating(false);
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: 'dall-e-3', prompt: prompt.trim(), n: 1, size, style, response_format: 'b64_json' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
        throw new Error(err?.error?.message || 'Generation failed');
      }
      const data = await res.json();
      const item = data.data?.[0];
      if (!item?.b64_json) throw new Error('No image returned');
      const dataUrl = `data:image/png;base64,${item.b64_json}`;
      const img: GeneratedImage = {
        id: `img_${Date.now()}`,
        prompt: prompt.trim(),
        url: dataUrl,
        revisedPrompt: item.revised_prompt,
        createdAt: new Date().toISOString(),
        size,
        style,
      };
      saveToHistory(img);
      setHistory(loadHistory());
      setSelectedImage(img);
      setPrompt('');
    } catch (e: any) {
      setError(e.message || 'Unknown error');
    } finally {
      setGenerating(false);
    }
  }

  function downloadImage(img: GeneratedImage) {
    const a = document.createElement('a');
    a.href = img.url;
    a.download = `henry-image-${img.id}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <div className="flex h-full bg-henry-bg">
      {/* Main area */}
      <div className="flex flex-col flex-1 min-h-0">
        {/* Header + Controls */}
        <div className="p-6 border-b border-henry-border/30">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-semibold text-henry-text">Image Generation</h1>
              <p className="text-xs text-henry-text-muted mt-0.5">{openaiKey ? 'DALL-E 3 via OpenAI' : 'Free via Pollinations.ai'}</p>
            </div>
            {!openaiKey && (
              <span className="text-xs px-3 py-1.5 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-lg">
                OpenAI key required
              </span>
            )}
          </div>

          {/* Prompt */}
          <div className="space-y-3">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate(); }}
              placeholder="Describe the image you want to create..."
              rows={3}
              className="w-full bg-henry-surface/50 border border-henry-border/40 rounded-xl px-4 py-3 text-sm text-henry-text placeholder-henry-text-dim focus:outline-none focus:border-henry-accent/50 resize-none"
            />

            {/* Options + Generate */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1">
                <span className="text-xs text-henry-text-muted mr-1">Size:</span>
                {SIZES.map((s) => (
                  <button key={s} onClick={() => setSize(s)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-medium transition-colors border ${size === s ? 'bg-henry-accent/15 border-henry-accent/40 text-henry-accent' : 'border-henry-border/30 text-henry-text-dim hover:text-henry-text'}`}>
                    {s === '1024x1024' ? 'Square' : s === '1792x1024' ? 'Landscape' : 'Portrait'}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-henry-text-muted mr-1">Style:</span>
                {STYLES.map((s) => (
                  <button key={s} onClick={() => setStyle(s)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-medium capitalize transition-colors border ${style === s ? 'bg-henry-accent/15 border-henry-accent/40 text-henry-accent' : 'border-henry-border/30 text-henry-text-dim hover:text-henry-text'}`}>
                    {s}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => henryQuickAsk({
                    prompt: prompt.trim()
                      ? `Improve this image generation prompt — add style, lighting, mood, composition, and detail. Keep it under 150 words.\n\nOriginal: "${prompt}"`
                      : 'Help me write a detailed image generation prompt. Ask what image I want, then craft a rich, specific prompt with style, lighting, mood, and composition.',
                  })}
                  className="text-[11px] px-3 py-2 rounded-xl bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-accent hover:border-henry-accent/30 transition-all"
                  title="Ask Henry to improve your prompt"
                >🧠 Improve</button>
                <button
                  onClick={generate}
                  disabled={!prompt.trim() || generating || !openaiKey}
                  className="flex items-center gap-2 px-5 py-2.5 bg-henry-accent text-henry-bg rounded-xl text-sm font-semibold hover:bg-henry-accent/90 disabled:opacity-40 transition-colors"
                >
                  {generating ? (
                    <>
                      <span className="w-4 h-4 border-2 border-henry-bg/30 border-t-henry-bg rounded-full animate-spin" />
                      Generating...
                    </>
                  ) : '🎨 Generate'}
                </button>
              </div>
            </div>

            {error && (
              <div className="px-4 py-2.5 bg-henry-error/10 border border-henry-error/20 rounded-xl text-xs text-henry-error">
                {error}
              </div>
            )}
            <p className="text-[10px] text-henry-text-dim">Tip: ⌘+Enter to generate · DALL-E 3 enhances your prompt automatically</p>
          </div>
        </div>

        {/* Gallery */}
        <div className="flex-1 overflow-y-auto p-4">
          {history.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-henry-text-dim">
              <span className="text-4xl mb-3">🎨</span>
              <p className="text-sm">Your generated images will appear here</p>
              <p className="text-xs mt-1">Add an OpenAI key in Settings for DALL-E 3 quality. Free tier uses Pollinations.ai.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {history.map((img) => (
                <div key={img.id} className="group relative cursor-pointer" onClick={() => setSelectedImage(img)}>
                  <div className="aspect-square rounded-xl overflow-hidden bg-henry-surface/40 border border-henry-border/30 hover:border-henry-accent/40 transition-colors">
                    <img src={img.url} alt={img.prompt} className="w-full h-full object-cover" loading="lazy"
                      onError={(e) => { (e.target as HTMLImageElement).src = ''; }} />
                  </div>
                  <p className="text-[10px] text-henry-text-dim mt-1 truncate">{img.prompt}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Selected image detail */}
      {selectedImage && (
        <div className="w-full md:w-80 border-l border-henry-border/30 bg-henry-surface/50 flex flex-col">
          <div className="p-4 border-b border-henry-border/30 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-henry-text">Image</h2>
            <button onClick={() => setSelectedImage(null)} className="text-henry-text-dim hover:text-henry-text text-lg leading-none">×</button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <div className="p-4">
              <div className="rounded-xl overflow-hidden mb-4 bg-henry-surface/40">
                <img src={selectedImage.url} alt={selectedImage.prompt} className="w-full" />
              </div>
              <div className="space-y-3">
                <div>
                  <p className="text-[10px] text-henry-text-muted uppercase tracking-wider mb-1">Your prompt</p>
                  <p className="text-xs text-henry-text">{selectedImage.prompt}</p>
                </div>
                {selectedImage.revisedPrompt && selectedImage.revisedPrompt !== selectedImage.prompt && (
                  <div>
                    <p className="text-[10px] text-henry-text-muted uppercase tracking-wider mb-1">DALL-E enhanced</p>
                    <p className="text-xs text-henry-text-dim">{selectedImage.revisedPrompt}</p>
                  </div>
                )}
                <div className="flex gap-2 text-[10px] text-henry-text-dim">
                  <span>{selectedImage.size}</span>
                  <span>·</span>
                  <span className="capitalize">{selectedImage.style}</span>
                  <span>·</span>
                  <span>{new Date(selectedImage.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
            </div>
          </div>
          <div className="p-4 border-t border-henry-border/30 flex gap-2">
            <button onClick={() => downloadImage(selectedImage)} className="flex-1 py-2.5 bg-henry-accent text-henry-bg rounded-xl text-sm font-semibold hover:bg-henry-accent/90 transition-colors">
              Download
            </button>
            <button onClick={() => { setPrompt(selectedImage.prompt); setSelectedImage(null); }}
              className="px-3 py-2.5 bg-henry-surface border border-henry-border/40 text-henry-text-muted rounded-xl text-sm hover:text-henry-text transition-colors">
              Reuse
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
