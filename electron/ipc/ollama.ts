/**
 * Ollama — Local model management.
 * 
 * Connects to Ollama running on the user's machine.
 * Supports model listing, pulling, and generation.
 * M1 Max 64GB can comfortably run Llama 3.1 70B, Codestral, Mistral, etc.
 */

import { ipcMain, BrowserWindow } from 'electron';
import {
  findOllamaBinary,
  downloadOllama,
  launchOllama,
  isOllamaResponding,
  OLLAMA_URL,
} from './ollamaManager';
import { readNdjsonStream } from '../providers/ndjson';
import { discoverOllamaModels, type OllamaModelCatalogue } from './ollamaCapabilities';

type WindowGetter = () => BrowserWindow | null;

/** Safely send to renderer — skips if window is destroyed (Vite HMR). */
function safeSend(getWin: WindowGetter, channel: string, data: any) {
  const win = getWin();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

let getWindow: WindowGetter;

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/**
 * The exact inventory the given base URL holds right now, with the
 * capabilities the runtime reports for each model. There is no static list
 * behind this: pull a model and it appears, remove one and it disappears, with
 * no change to Henry.
 */
export async function ollamaCatalogue(baseUrl?: string): Promise<OllamaModelCatalogue> {
  const base = (baseUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  const found = await discoverOllamaModels(base);
  return {
    models: found.models,
    baseUrl: found.baseUrl,
    runtime: 'ollama',
    warnings: found.warnings,
    error: found.models.length === 0 && found.warnings.length > 0 ? found.warnings[0] : undefined,
  };
}

export function registerOllamaHandlers(winGetter: WindowGetter) {
  getWindow = winGetter;

  // Check if Ollama is running
  ipcMain.handle('ollama:status', async (_event, baseUrl?: string) => {
    const url = baseUrl || DEFAULT_OLLAMA_URL;
    try {
      const response = await fetch(`${url}/api/version`);
      if (response.ok) {
        const data = await response.json();
        return { running: true, version: data.version, url };
      }
      return { running: false, url };
    } catch {
      return { running: false, url, error: 'Ollama not reachable. Make sure it\'s installed and running.' };
    }
  });

  // List the models this Ollama instance actually holds, with the capabilities
  // it reports for each one. This is the only source of local models; the
  // renderer must not carry its own copy of the list.
  ipcMain.handle('ollama:models', async (_event, baseUrl?: string) => {
    try {
      return await ollamaCatalogue(baseUrl);
    } catch (err: unknown) {
      return {
        models: [],
        baseUrl: baseUrl || DEFAULT_OLLAMA_URL,
        runtime: 'ollama',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Pull a model (with progress)
  ipcMain.handle('ollama:pull', async (_event, modelName: string, baseUrl?: string) => {
    const url = baseUrl || DEFAULT_OLLAMA_URL;
    try {
      const response = await fetch(`${url}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName, stream: true }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n').filter(Boolean);

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            safeSend(getWindow, 'ollama:pull:progress', {
              model: modelName,
              status: data.status,
              completed: data.completed,
              total: data.total,
              digest: data.digest,
            });
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      return { success: true, model: modelName };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ── Lifecycle: detect / install / launch ────────────────────────────────

  /** Check whether the Ollama binary exists anywhere on this machine. */
  ipcMain.handle('ollama:isInstalled', async () => {
    const binPath = findOllamaBinary();
    const running = await isOllamaResponding();
    return { installed: binPath !== null, running, binPath: binPath ?? undefined };
  });

  /**
   * Launch Ollama (must already be installed).
   * Waits up to 12 s for it to start accepting requests.
   */
  ipcMain.handle('ollama:launch', async (_event, binPath?: string) => {
    try {
      const resolved = binPath ?? findOllamaBinary();
      if (!resolved) return { success: false, error: 'Ollama binary not found.' };
      await launchOllama(resolved);
      const running = await isOllamaResponding();
      return { success: running, error: running ? undefined : 'Ollama did not start in time.' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Download + install Ollama into Henry's userData/bin.
   * Sends progress events: { phase, downloaded, total, message }
   */
  ipcMain.handle('ollama:install', async () => {
    try {
      const binPath = await downloadOllama((progress) => {
        safeSend(getWindow, 'ollama:install:progress', progress);
      });
      // Auto-launch after install
      await launchOllama(binPath);
      const running = await isOllamaResponding();
      return { success: true, binPath, running };
    } catch (err: any) {
      safeSend(getWindow, 'ollama:install:progress', {
        phase: 'error',
        downloaded: 0,
        total: 0,
        message: err.message,
      });
      return { success: false, error: err.message };
    }
  });

  // Delete a model
  ipcMain.handle('ollama:delete', async (_event, modelName: string, baseUrl?: string) => {
    const url = baseUrl || DEFAULT_OLLAMA_URL;
    try {
      const response = await fetch(`${url}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName }),
      });
      return { success: response.ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Generate (chat) with local model — streaming
  ipcMain.handle('ollama:chat', async (_event, params: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    channelId: string;
    baseUrl?: string;
    temperature?: number;
  }) => {
    const url = params.baseUrl || DEFAULT_OLLAMA_URL;
    try {
      const response = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: params.model,
          messages: params.messages,
          stream: true,
          options: {
            temperature: params.temperature ?? 0.7,
          },
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      let fullText = '';
      let sawDone = false;

      // A single reader.read() does not align with a line boundary: splitting
      // each read on '\n' and parsing the pieces dropped every partial line, so
      // tokens went missing at random. The shared reader carries a leftover
      // buffer between reads.
      await readNdjsonStream(response, (record) => {
        const data = (record ?? {}) as {
          message?: { content?: string };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
          error?: string;
        };
        if (typeof data.error === 'string' && data.error) throw new Error(data.error);
        if (data.message?.content) {
          fullText += data.message.content;
          safeSend(getWindow, 'ai:stream:chunk', {
            channelId: params.channelId,
            chunk: data.message.content,
          });
        }
        if (data.done) {
          sawDone = true;
          safeSend(getWindow, 'ai:stream:done', {
            channelId: params.channelId,
            fullText,
            usage: {
              prompt_tokens: data.prompt_eval_count || 0,
              completion_tokens: data.eval_count || 0,
              total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
              cost: 0, // Local models = free
            },
          });
        }
      });

      // Ollama closes the stream without a `done` record when generation is
      // cut short; without this the renderer waited forever for a done event.
      if (!sawDone) {
        safeSend(getWindow, 'ai:stream:done', {
          channelId: params.channelId,
          fullText,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 },
        });
      }

      return { success: true };
    } catch (err: any) {
      safeSend(getWindow, 'ai:stream:error', {
        channelId: params.channelId,
        error: err.message,
      });
      return { success: false, error: err.message };
    }
  });
}
