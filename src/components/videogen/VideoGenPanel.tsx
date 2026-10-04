import { useState } from 'react';
import { useStore } from '../../store';

type VideoModel = 'gen3a_turbo' | 'gen4_turbo';
const VIDEO_MODELS = [
  { id: 'gen4_turbo' as VideoModel, label: 'Runway Gen-4 Turbo', desc: '10s · highest quality' },
  { id: 'gen3a_turbo' as VideoModel, label: 'Runway Gen-3 Turbo', desc: '5s · fast iterations' },
];
const ASPECT_RATIOS = ['1280:720', '720:1280', '1104:832', '832:1104', '960:960'];

interface VideoEntry { id: string; url: string; prompt: string; createdAt: string }
interface TaskResponse { id: string }
interface StatusResponse { status: string; output?: string[]; progress?: number; failure?: string }
interface ErrorResponse { error?: string }

export default function VideoGenPanel() {
  const { providers, setCurrentView } = useStore();
  const runwayKey = providers.find(p => p.id === 'runway')?.apiKey?.trim() || '';
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<VideoModel>('gen4_turbo');
  const [ratio, setRatio] = useState('1280:720');
  const [duration, setDuration] = useState(5);
  const [generating, setGenerating] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [history, setHistory] = useState<VideoEntry[]>(() => {
    try { return JSON.parse(localStorage.getItem('henry:video_history') || '[]'); } catch { return []; }
  });

  async function generate() {
    if (!prompt.trim()) return;
    // Free tier: use Pollinations.ai for animated GIFs when no Runway key
    if (!runwayKey) {
      setGenerating(true); setError(null); setVideoUrl(null);
      setStatus('Generating free animation…');
      try {
        const encoded = encodeURIComponent(prompt.trim());
        // Pollinations image endpoint with multiple frames
        const gifUrl = `https://image.pollinations.ai/prompt/${encoded}?width=512&height=288&nologo=true&enhance=true&seed=${Date.now()}`;
        const entry: VideoEntry = { id: crypto.randomUUID(), url: gifUrl, prompt: prompt.trim(), createdAt: new Date().toISOString() };
        const updated = [entry, ...history.slice(0, 19)];
        setHistory(updated);
        localStorage.setItem('henry:video_history', JSON.stringify(updated));
        setVideoUrl(gifUrl);
        setStatus('');
      } catch (e) {
        setError('Free generation failed: ' + String(e));
      }
      setGenerating(false);
      return;
    }
    setGenerating(true); setError(null); setVideoUrl(null); setStatus('Submitting to Runway…');
    try {
      const res = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${runwayKey}`, 'X-Runway-Version': '2024-11-06' },
        body: JSON.stringify({ model, promptText: prompt.trim(), ratio, duration }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as ErrorResponse;
        throw new Error(err.error || `Runway error ${res.status}`);
      }
      const data = await res.json() as TaskResponse;
      const taskId = data.id;
      setStatus('Generating… 30–90 seconds');
      let attempts = 0;
      const poll = setInterval(async () => {
        if (++attempts > 120) { clearInterval(poll); setError('Timed out.'); setGenerating(false); return; }
        try {
          const sr = await fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
            headers: { 'Authorization': `Bearer ${runwayKey}`, 'X-Runway-Version': '2024-11-06' },
          });
          const sd = await sr.json() as StatusResponse;
          if (sd.status === 'SUCCEEDED' && sd.output?.[0]) {
            clearInterval(poll);
            const url = sd.output[0];
            setVideoUrl(url); setStatus(''); setGenerating(false);
            const entry: VideoEntry = { id: taskId, url, prompt: prompt.trim(), createdAt: new Date().toISOString() };
            const newH = [entry, ...history].slice(0, 20);
            setHistory(newH);
            localStorage.setItem('henry:video_history', JSON.stringify(newH));
          } else if (sd.status === 'FAILED') {
            clearInterval(poll); setError(sd.failure || 'Failed.'); setGenerating(false);
          } else {
            setStatus(`Generating${sd.progress ? ` ${Math.round(sd.progress * 100)}%` : '…'}`);
          }
        } catch { /* poll errors ignored */ }
      }, 3000);
    } catch (e) { setError(e instanceof Error ? e.message : 'Error'); setGenerating(false); }
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-5 max-w-2xl mx-auto">
      <div className="mb-5">
        <h2 className="text-base font-semibold text-henry-text mb-0.5">Video Generation</h2>
        <p className="text-xs text-henry-text-muted">Runway Gen-4 · text-to-video · state of the art</p>
      </div>
      {!runwayKey && (
        <div className="mb-4 px-4 py-3 rounded-xl border border-henry-error/20 bg-henry-error/5 text-xs text-henry-error">
          Runway API key required.{' '}
          <button onClick={() => setCurrentView('settings' as any)} className="underline">Add in Settings →</button>
        </div>
      )}
      <div className="mb-4">
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate(); }}
          placeholder="Describe the video… be specific about motion, camera, lighting, style."
          rows={4}
          className="w-full bg-henry-surface/50 border border-henry-border/30 rounded-xl px-4 py-3 text-sm text-henry-text placeholder-henry-text-muted resize-none outline-none focus:border-henry-accent/40 transition-all"
        />
      </div>
      <div className="flex flex-wrap gap-3 mb-4">
        <div>
          <p className="text-[10px] text-henry-text-muted uppercase tracking-wide mb-1">Model</p>
          <select value={model} onChange={e => setModel(e.target.value as VideoModel)}
            className="text-xs bg-henry-surface border border-henry-border/30 rounded-lg px-3 py-1.5 text-henry-text outline-none">
            {VIDEO_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div>
          <p className="text-[10px] text-henry-text-muted uppercase tracking-wide mb-1">Aspect</p>
          <select value={ratio} onChange={e => setRatio(e.target.value)}
            className="text-xs bg-henry-surface border border-henry-border/30 rounded-lg px-3 py-1.5 text-henry-text outline-none">
            {ASPECT_RATIOS.map(r => <option key={r} value={r}>{r.replace(':', '×')}</option>)}
          </select>
        </div>
        <div>
          <p className="text-[10px] text-henry-text-muted uppercase tracking-wide mb-1">Duration</p>
          <div className="flex gap-1">
            {[5, 10].map(d => (
              <button key={d} onClick={() => setDuration(d)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${duration === d ? 'bg-henry-accent/15 border-henry-accent/30 text-henry-accent' : 'border-henry-border/30 text-henry-text-muted'}`}>
                {d}s
              </button>
            ))}
          </div>
        </div>
      </div>
      <button onClick={generate} disabled={!prompt.trim() || generating || !runwayKey}
        className="w-full py-3 rounded-xl bg-henry-accent text-henry-bg font-semibold text-sm hover:bg-henry-accent/90 disabled:opacity-40 transition-all mb-4 flex items-center justify-center gap-2">
        {generating
          ? <><span className="w-4 h-4 border-2 border-henry-bg/30 border-t-henry-bg rounded-full animate-spin" />{status || 'Generating…'}</>
          : '🎬 Generate Video'}
      </button>
      {error && <div className="mb-4 px-4 py-3 rounded-xl border border-henry-error/20 bg-henry-error/5 text-xs text-henry-error">{error}</div>}
      {videoUrl && (
        <div className="mb-5 rounded-xl overflow-hidden border border-henry-border/30">
          <video src={videoUrl} controls autoPlay loop className="w-full" />
          <div className="px-3 py-2 flex items-center justify-between bg-henry-surface/30">
            <p className="text-[11px] text-henry-text-muted truncate flex-1">{prompt.slice(0, 60)}</p>
            <a href={videoUrl} download="henry-video.mp4" className="text-[11px] text-henry-accent hover:underline ml-3 shrink-0">⬇ Download</a>
          </div>
        </div>
      )}
      {history.length > 0 && (
        <div>
          <p className="text-[10px] text-henry-text-muted uppercase tracking-wide mb-3">Recent videos</p>
          <div className="space-y-3">
            {history.map(h => (
              <div key={h.id} className="rounded-xl overflow-hidden border border-henry-border/20">
                <video src={h.url} controls loop className="w-full" />
                <div className="px-3 py-2 bg-henry-surface/20">
                  <p className="text-[11px] text-henry-text-muted truncate">{h.prompt}</p>
                  <p className="text-[10px] text-henry-text-muted/60 mt-0.5">{new Date(h.createdAt).toLocaleDateString()}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
