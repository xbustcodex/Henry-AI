/**
 * Henry Recorder Panel — voice memos stored in SQLite.
 */
import { useState, useEffect, useRef } from 'react';
import { sendToHenry } from '../../actions/store/chatBridgeStore';
import { useStore } from '../../store';

const getApi = () => (window as any).henryAPI as any;
interface Recording { id: string; title: string; duration_secs: number; recorded_at: string; transcript?: string; }

function fmtDur(secs: number) {
  const m = Math.floor(secs/60), s = secs%60;
  return `${m}:${String(s).padStart(2,'0')}`;
}

export default function RecorderPanel() {
  const { setCurrentView } = useStore();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [selected, setSelected] = useState<Recording|null>(null);
  const [title, setTitle] = useState('');
  const mediaRef = useRef<MediaRecorder|null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>|null>(null);

  useEffect(() => {
    getApi()?.recordingsList?.().then((r: Recording[]) => setRecordings(r||[])).catch(() => {});
  }, []);

  async function startRec() {
    try {
      const { ensureMicAccess } = await import('../../henry/voice');
      await ensureMicAccess();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64 = (reader.result as string).split(',')[1];
          const id = crypto.randomUUID();
          const rec: Recording = {
            id, title: title.trim() || `Voice memo ${new Date().toLocaleTimeString()}`,
            duration_secs: elapsed, recorded_at: new Date().toISOString(),
          };
          await getApi()?.recordingsSave?.({ ...rec, audio_data: base64 }).catch(() => {});
          setRecordings(prev => [rec, ...prev]);
          setSelected(rec);
          setTitle('');
        };
        reader.readAsDataURL(blob);
      };
      mr.start(500);
      mediaRef.current = mr;
      setElapsed(0);
      setRecording(true);
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } catch { alert('Microphone access needed. Check System Preferences → Privacy.'); }
  }

  function stopRec() {
    mediaRef.current?.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
  }

  async function deleteRec(id: string) {
    await getApi()?.recordingsDelete?.(id).catch(() => {});
    setRecordings(r => r.filter(x => x.id !== id));
    if (selected?.id === id) setSelected(null);
  }

  function sendToChat(r: Recording) {
    sendToHenry(`I recorded a voice memo titled "${r.title}" (${fmtDur(r.duration_secs)}) on ${new Date(r.recorded_at).toLocaleDateString()}. ${r.transcript ? 'Transcript: ' + r.transcript : 'Help me think about what to do with this recording.'}`);
    setCurrentView('chat' as any);
  }

  return (
    <div className="flex h-full bg-henry-bg overflow-hidden">
      {/* Sidebar */}
      <div className="w-64 flex-shrink-0 border-r border-henry-border/20 flex flex-col">
        <div className="p-4 border-b border-henry-border/20 space-y-3">
          <h1 className="text-base font-bold text-henry-text">Voice Memos</h1>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title (optional)"
            className="w-full bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50" />
          {recording ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
                <span className="text-henry-text text-sm font-mono">{fmtDur(elapsed)}</span>
              </div>
              <button onClick={stopRec}
                className="w-full py-2.5 rounded-xl bg-red-500/20 border border-red-500/40 text-red-400 text-sm font-semibold hover:bg-red-500/30 transition-all">
                ■ Stop
              </button>
            </div>
          ) : (
            <button onClick={() => void startRec()}
              className="w-full py-2.5 rounded-xl bg-henry-accent text-white text-sm font-semibold hover:bg-henry-accent/80 transition-all flex items-center justify-center gap-2">
              🎙 Record
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {recordings.length === 0 && <p className="p-4 text-henry-text-muted text-xs text-center">No recordings yet.</p>}
          {recordings.map(r => (
            <button key={r.id} onClick={() => setSelected(r)}
              className={`w-full text-left px-4 py-3 border-b border-henry-border/10 hover:bg-henry-surface/40 transition-all ${selected?.id===r.id ? 'bg-henry-surface/60 border-l-2 border-l-henry-accent' : ''}`}>
              <p className="text-sm font-medium text-henry-text truncate">{r.title}</p>
              <div className="flex items-center justify-between mt-0.5">
                <p className="text-[10px] text-henry-text-muted">{new Date(r.recorded_at).toLocaleDateString()}</p>
                <p className="text-[10px] text-henry-text-muted font-mono">{fmtDur(r.duration_secs)}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Detail */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selected ? (
          <div className="flex-1 flex flex-col p-6 space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-xl font-bold text-henry-text">{selected.title}</h2>
                <p className="text-sm text-henry-text-muted mt-0.5">{new Date(selected.recorded_at).toLocaleString()} · {fmtDur(selected.duration_secs)}</p>
              </div>
              <button onClick={() => void deleteRec(selected.id)} className="text-henry-text-muted hover:text-red-400 text-sm transition-all">Delete</button>
            </div>
            <div className="flex gap-2">
              <button onClick={() => sendToChat(selected)}
                className="text-[11px] px-3 py-1.5 rounded-xl bg-henry-accent/15 border border-henry-accent/30 text-henry-accent hover:bg-henry-accent/25 transition-all">
                ⚡ Send to Henry
              </button>
            </div>
            {selected.transcript && (
              <div className="flex-1 overflow-y-auto bg-henry-surface/40 rounded-2xl p-4 border border-henry-border/15">
                <p className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-2 font-semibold">Transcript</p>
                <p className="text-sm text-henry-text leading-relaxed whitespace-pre-wrap">{selected.transcript}</p>
              </div>
            )}
            {!selected.transcript && (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center space-y-2">
                  <p className="text-4xl">🎙</p>
                  <p className="text-henry-text-muted text-sm">Recording saved · {fmtDur(selected.duration_secs)}</p>
                  <p className="text-henry-text-muted text-xs">Send to Henry for AI transcription and analysis</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-3">
              <p className="text-5xl">🎙</p>
              <p className="text-henry-text-muted text-sm">Record a voice memo or select one to review.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
