/**
 * Render bridge (Henry → Henry Render Daemon).
 *
 * The direct path for making video: Henry's `generate_video` tool
 * talks straight to the local Henry Render Daemon (free on-device text→video via
 * FastVideo/Wan2.1). Just Henry and the daemon.
 *
 * The daemon is async (a render takes minutes): `submitRender` returns a jobId
 * immediately, `pollRender` checks progress. Endpoint is configurable via the
 * `render_endpoint` setting (default http://localhost:8799).
 */

import type Database from "better-sqlite3";

export interface RenderConfig {
  endpoint: string;
}

export type RenderQuality = "fast" | "balanced" | "high";

/** quality → (width, height, steps). Times on M1 Max/MPS: fast≈1.7min, balanced≈5min, high≈12min. */
export const QUALITY_PRESETS: Record<RenderQuality, { width: number; height: number; steps: number }> = {
  fast: { width: 256, height: 256, steps: 20 },
  balanced: { width: 384, height: 384, steps: 24 },
  high: { width: 480, height: 480, steps: 28 },
};

export interface RenderJobInput {
  prompt: string;
  durationSec?: number;
  style?: string;
  outputName?: string;
  quality?: RenderQuality;
}

export interface RenderSubmitResult {
  ok: boolean;
  jobId?: string;
  status?: string;
  error?: string;
}

export interface RenderStatusResult {
  ok: boolean;
  jobId?: string;
  status?: string; // queued | running | completed | failed
  videoUrl?: string | null;
  outputPath?: string | null;
  seconds?: number | null;
  error?: string | null;
  done?: boolean;
  failed?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Read the render daemon endpoint from settings (default localhost:8799). */
export function resolveRenderConfig(db: Database.Database): RenderConfig {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'render_endpoint'").get() as
    | { value: string }
    | undefined;
  const endpoint = (row?.value ?? "http://localhost:8799").trim().replace(/\/+$/, "");
  return { endpoint };
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      /* raw text */
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Kick off a render. Resolves with a jobId; never rejects. */
export async function submitRender(
  config: RenderConfig,
  input: RenderJobInput,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RenderSubmitResult> {
  const preset = QUALITY_PRESETS[input.quality ?? "balanced"];
  const payload = {
    prompt: input.prompt,
    durationSec: input.durationSec,
    style: input.style,
    outputName: input.outputName,
    ...preset,
  };
  try {
    const { status, body } = await fetchJson(
      `${config.endpoint}/render`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      timeoutMs,
    );
    if (status < 200 || status >= 300) {
      const detail = typeof body === "string" ? body : JSON.stringify(body);
      return { ok: false, error: `Render daemon returned HTTP ${status}: ${detail.slice(0, 200)}` };
    }
    const obj = (body ?? {}) as Record<string, unknown>;
    const jobId = String(obj.jobId ?? "");
    if (!jobId) return { ok: false, error: "Render daemon accepted the job but returned no jobId." };
    return { ok: true, jobId, status: String(obj.status ?? "queued") };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = /abort/i.test(msg);
    return {
      ok: false,
      error: timedOut
        ? `Could not reach the render daemon at ${config.endpoint} (timed out). Is it running?`
        : `Could not reach the render daemon at ${config.endpoint}: ${msg}`,
    };
  }
}

const DONE = new Set(["completed", "succeeded", "success"]);
const FAILED = new Set(["failed", "cancelled", "canceled", "error"]);

/** Poll a render job. Never rejects. */
export async function pollRender(
  config: RenderConfig,
  jobId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RenderStatusResult> {
  try {
    const { status, body } = await fetchJson(
      `${config.endpoint}/render/${encodeURIComponent(jobId)}`,
      { method: "GET" },
      timeoutMs,
    );
    if (status < 200 || status >= 300) {
      const detail = typeof body === "string" ? body : JSON.stringify(body);
      return { ok: false, error: `Render status returned HTTP ${status}: ${detail.slice(0, 200)}` };
    }
    const obj = (body ?? {}) as Record<string, unknown>;
    const s = String(obj.status ?? "running").toLowerCase();
    return {
      ok: true,
      jobId,
      status: s,
      videoUrl: (obj.videoUrl as string) ?? null,
      outputPath: (obj.outputPath as string) ?? null,
      seconds: (obj.seconds as number) ?? null,
      error: obj.error ? String(obj.error) : null,
      done: DONE.has(s),
      failed: FAILED.has(s),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Could not reach the render daemon: ${msg}` };
  }
}
