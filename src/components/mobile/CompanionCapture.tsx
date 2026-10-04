/**
 * Companion Capture Screen
 *
 * Lets the user send content to Henry on the desktop:
 *   - Text prompt (typed)
 *   - Voice note (Capacitor SpeechRecognition)
 *   - Photo / image (Capacitor Camera)
 *   - File (file input fallback — Capacitor Filesystem / share extension)
 *
 * All captures are sent to the desktop via POST /sync/capture.
 */

import { useState, useRef } from 'react';
import { useSyncStore } from '../../sync/syncStore';
import { sendCapture } from '../../sync/syncClient';
import type { CapturePayload, CaptureType } from '../../sync/types';
import { hapticLight, hapticMedium, hapticSuccess, hapticError } from '../../capacitor';
import { isNative } from '../../capacitor';
import { toast } from '../ui/Toast';

type CaptureMode = 'text' | 'voice' | 'image' | 'file';

interface Props {
  onDone: () => void;
}

export default function CompanionCapture({ onDone }: Props) {
  const { config, setCaptureInFlight, captureInFlight, status } = useSyncStore();
  const [mode, setMode] = useState<CaptureMode>('text');
  const [text, setText] = useState('');
  const [context, setContext] = useState('');
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [imageData, setImageData] = useState<string | null>(null);
  const [imageType, setImageType] = useState<string>('image/jpeg');
  const [fileName, setFileName] = useState<string>('');
  const [fileData, setFileData] = useState<string | null>(null);
  const [fileType, setFileType] = useState<string>('');
  const [fileSize, setFileSize] = useState(0);
  const [result, setResult] = useState<'success' | 'error' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const canSend = status === 'connected' && !captureInFlight;

  async function startVoice() {
    if (!isNative) {
      toast.info('Voice recording requires the native app on iPhone/iPad.');
      return;
    }
    try {
      // Dynamically import Capacitor SpeechRecognition
      const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
      const perm = await SpeechRecognition.requestPermissions();
      if ((perm as { speechRecognition?: string }).speechRecognition !== 'granted') return;

      setRecording(true);
      setTranscript('');
      void hapticLight();

      await SpeechRecognition.start({
        language: 'en-US',
        maxResults: 1,
        popup: false,
        partialResults: true,
      });

      SpeechRecognition.addListener('partialResults', (data: { matches: string[] }) => {
        if (data.matches?.[0]) setTranscript(data.matches[0]);
      });
    } catch {
      setRecording(false);
      void hapticError();
    }
  }

  async function stopVoice() {
    if (!isNative) return;
    try {
      const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
      const result = await SpeechRecognition.stop() as { matches?: string[] } | void;
      const text = (result as { matches?: string[] } | undefined)?.matches?.[0] ?? transcript;
      setTranscript(text);
      setRecording(false);
      void hapticLight();
    } catch {
      setRecording(false);
    }
  }

  async function pickImage() {
    if (isNative) {
      try {
        const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
        const photo = await Camera.getPhoto({
          quality: 80,
          allowEditing: false,
          resultType: CameraResultType.Base64,
          source: CameraSource.Prompt,
        });
        if (photo.base64String) {
          setImageData(photo.base64String);
          setImageType(`image/${photo.format ?? 'jpeg'}`);
          void hapticLight();
        }
      } catch { /* user cancelled */ }
    } else {
      fileRef.current?.click();
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();

    if (mode === 'image') {
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1] ?? result;
        setImageData(base64);
        setImageType(file.type || 'image/jpeg');
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1] ?? result;
        setFileData(base64);
        setFileName(file.name);
        setFileType(file.type || 'application/octet-stream');
        setFileSize(file.size);
      };
      reader.readAsDataURL(file);
    }
  }

  async function submit() {
    if (!config || !canSend) return;

    let captureType: CaptureType = 'text';
    let content = '';
    let mimeType: string | undefined;
    let fn: string | undefined;
    let fileSize_: number | undefined;
    let transcription: string | undefined;

    switch (mode) {
      case 'text':
        if (!text.trim()) return;
        captureType = 'text';
        content = text.trim();
        break;
      case 'voice':
        if (!transcript.trim()) return;
        captureType = 'voice';
        content = transcript;
        transcription = transcript;
        break;
      case 'image':
        if (!imageData) return;
        captureType = 'image';
        content = imageData;
        mimeType = imageType;
        fn = `capture_${Date.now()}.jpg`;
        break;
      case 'file':
        if (!fileData) return;
        captureType = 'file';
        content = fileData;
        mimeType = fileType;
        fn = fileName;
        fileSize_ = fileSize;
        break;
    }

    const capture: CapturePayload = {
      id: crypto.randomUUID(),
      type: captureType,
      content,
      mimeType,
      fileName: fn,
      fileSizeBytes: fileSize_,
      transcription,
      context: context.trim() || undefined,
      fromDevice: config.deviceId,
      timestamp: Date.now(),
    };

    setCaptureInFlight(true);
    void hapticMedium();
    try {
      await sendCapture(config, capture);
      setResult('success');
      void hapticSuccess();
      setText('');
      setTranscript('');
      setImageData(null);
      setFileData(null);
      setContext('');
      setTimeout(onDone, 1200);
    } catch {
      setResult('error');
      void hapticError();
      setTimeout(() => setResult(null), 3000);
    } finally {
      setCaptureInFlight(false);
    }
  }

  const offline = status !== 'connected';

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-3">
        <h1 className="text-xl font-bold text-henry-text">Send to Henry</h1>
        <p className="text-xs text-henry-text-muted mt-0.5">
          {offline ? 'Desktop offline — captures will not be delivered' : 'Your desktop Henry will receive and process this'}
        </p>
      </div>

      {/* Mode selector */}
      <div className="shrink-0 flex gap-2 px-4 pb-4">
        {(['text', 'voice', 'image', 'file'] as CaptureMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 py-2.5 rounded-xl text-xs font-medium transition-colors border ${
              mode === m
                ? 'bg-henry-accent text-white border-henry-accent'
                : 'bg-henry-surface text-henry-text-muted border-henry-border/30'
            }`}
          >
            {m === 'text' ? '⌨️' : m === 'voice' ? '🎙' : m === 'image' ? '📸' : '📎'}
            <br />
            {m.charAt(0).toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4 space-y-4">

        {/* Text mode */}
        {mode === 'text' && (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type your message or question for Henry…"
            rows={6}
            className="w-full bg-henry-surface rounded-2xl px-4 py-3.5 text-sm text-henry-text placeholder-henry-text-muted resize-none outline-none border border-henry-border/30 focus:border-henry-accent/50 transition-colors"
          />
        )}

        {/* Voice mode */}
        {mode === 'voice' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <button
              onPointerDown={() => void startVoice()}
              onPointerUp={() => void stopVoice()}
              onPointerLeave={() => { if (recording) void stopVoice(); }}
              className={`w-24 h-24 rounded-full flex items-center justify-center text-4xl shadow-lg transition-all active:scale-95 ${
                recording
                  ? 'bg-henry-error animate-pulse'
                  : 'bg-henry-surface border-2 border-henry-border/40'
              }`}
            >
              🎙
            </button>
            <p className="text-xs text-henry-text-muted">
              {recording ? 'Recording… release to stop' : 'Hold to record'}
            </p>
            {transcript && (
              <div className="w-full bg-henry-surface rounded-2xl px-4 py-3 border border-henry-border/30">
                <p className="text-xs font-medium text-henry-text-muted mb-1">Transcript</p>
                <p className="text-sm text-henry-text">{transcript}</p>
              </div>
            )}
          </div>
        )}

        {/* Image mode */}
        {mode === 'image' && (
          <div className="flex flex-col items-center gap-4">
            <input
              ref={mode === 'image' ? fileRef : undefined}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
            {imageData ? (
              <div className="relative w-full">
                <img
                  src={`data:${imageType};base64,${imageData}`}
                  className="w-full rounded-2xl object-cover max-h-64"
                  alt="Capture preview"
                />
                <button
                  onClick={() => setImageData(null)}
                  className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 text-white flex items-center justify-center text-xs"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                onClick={() => void pickImage()}
                className="w-full h-40 bg-henry-surface rounded-2xl border-2 border-dashed border-henry-border/40 flex flex-col items-center justify-center gap-2 active:bg-henry-surface/70 transition-colors"
              >
                <span className="text-4xl">📸</span>
                <p className="text-sm text-henry-text-muted">Tap to take or choose a photo</p>
              </button>
            )}
          </div>
        )}

        {/* File mode */}
        {mode === 'file' && (
          <div className="flex flex-col items-center gap-4">
            <input
              ref={mode === 'file' ? fileRef : undefined}
              type="file"
              className="hidden"
              onChange={handleFileChange}
            />
            {fileData ? (
              <div className="w-full bg-henry-surface rounded-2xl px-4 py-4 border border-henry-border/30 flex items-center gap-3">
                <span className="text-3xl shrink-0">📄</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-henry-text truncate">{fileName}</p>
                  <p className="text-xs text-henry-text-muted">{formatBytes(fileSize)}</p>
                </div>
                <button
                  onClick={() => setFileData(null)}
                  className="text-henry-error text-xs active:opacity-60 transition-opacity"
                >
                  Remove
                </button>
              </div>
            ) : (
              <button
                onClick={() => fileRef.current?.click()}
                className="w-full h-40 bg-henry-surface rounded-2xl border-2 border-dashed border-henry-border/40 flex flex-col items-center justify-center gap-2 active:bg-henry-surface/70 transition-colors"
              >
                <span className="text-4xl">📎</span>
                <p className="text-sm text-henry-text-muted">Tap to choose a file</p>
              </button>
            )}
          </div>
        )}

        {/* Context note (optional for all modes) */}
        <div>
          <p className="text-xs font-medium text-henry-text-muted mb-2">Add context (optional)</p>
          <input
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="e.g. 'summarise this' or 'add to my project notes'"
            className="w-full bg-henry-surface rounded-2xl px-4 py-3 text-sm text-henry-text placeholder-henry-text-muted outline-none border border-henry-border/30 focus:border-henry-accent/50 transition-colors"
          />
        </div>

        {/* Result feedback */}
        {result === 'success' && (
          <div className="text-center py-2">
            <p className="text-sm font-semibold text-henry-success">✅ Sent to Henry</p>
          </div>
        )}
        {result === 'error' && (
          <div className="text-center py-2">
            <p className="text-sm font-semibold text-henry-error">❌ Failed to send</p>
            <p className="text-xs text-henry-text-muted mt-1">Check your desktop connection</p>
          </div>
        )}
      </div>

      {/* Send button */}
      <div
        className="shrink-0 px-4 py-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
      >
        <button
          onClick={() => void submit()}
          disabled={!canSend || offline || captureInFlight}
          className="w-full py-4 rounded-2xl bg-henry-accent text-white text-sm font-semibold active:bg-henry-accent/80 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {captureInFlight ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Sending…
            </>
          ) : offline ? (
            'Desktop offline'
          ) : (
            `Send to Henry`
          )}
        </button>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
