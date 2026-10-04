/**
 * Video generation tools — Henry makes real video on-device, free (FastVideo /
 * Wan2.1 text→video), by driving the local Henry Render Daemon directly. No
 * cloud, no API key.
 *
 *   - `generate_video` — start a render. confirm tier (it kicks off minutes of
 *                        real GPU/MPS work). Returns a jobId.
 *   - `video_status`   — poll a render by jobId. silent tier (a read).
 *
 * Renders take minutes, so `generate_video` returns as soon as the job is
 * accepted; poll `video_status` for the finished file (videoUrl / outputPath).
 */

import type { ToolDefinition, ToolResult } from "../types";
import {
  resolveRenderConfig,
  submitRender,
  pollRender,
  QUALITY_PRESETS,
  type RenderQuality,
} from "../renderBridge";

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}
function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

export function renderTools(): ToolDefinition[] {
  return [
    {
      name: "generate_video",
      description:
        "Generate a real video from a text description, on-device and free " +
        "(no cloud, no API key). Use when the user wants a video/clip made. " +
        "Describe the shot in plain language. Rendering runs in the background " +
        "and takes a few minutes; this returns a jobId immediately — poll " +
        "video_status with it to get the finished file. Quality 'fast' (~2 min), " +
        "'balanced' (~5 min), or 'high' (~12 min).",
      category: "external",
      safetyLevel: "confirm",
      confirmPrompt: (p) => `Generate a video for: "${String(p.prompt ?? "").slice(0, 200)}"`,
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "What the video should show, in plain language (subject, action, setting).",
          },
          durationSec: { type: "number", description: "Approx clip length in seconds (default 3)." },
          style: { type: "string", description: "Optional look, e.g. 'cinematic', 'anime', 'slow motion'." },
          outputName: { type: "string", description: "Optional friendly file name." },
          quality: {
            type: "string",
            enum: ["fast", "balanced", "high"],
            description: "Render quality/speed tradeoff (default 'balanced').",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      async execute(params, context): Promise<ToolResult> {
        const prompt = String(params.prompt ?? "").trim();
        if (!prompt) return fail("prompt is required");

        const quality = (["fast", "balanced", "high"].includes(String(params.quality))
          ? String(params.quality)
          : "balanced") as RenderQuality;

        const rawDur = Number(params.durationSec);
        const config = resolveRenderConfig(context.db);
        const res = await submitRender(config, {
          prompt,
          durationSec: Number.isFinite(rawDur) ? Math.min(6, Math.max(1, rawDur)) : 3,
          style: params.style ? String(params.style) : undefined,
          outputName: params.outputName ? String(params.outputName) : undefined,
          quality,
        });
        if (!res.ok) return fail(res.error ?? "Video generation failed to start.");

        const eta = { fast: "~2 min", balanced: "~5 min", high: "~12 min" }[quality];
        return ok({
          jobId: res.jobId,
          status: res.status ?? "queued",
          quality,
          resolution: `${QUALITY_PRESETS[quality].width}x${QUALITY_PRESETS[quality].height}`,
          message: `Video render started (${quality}, ${eta}). Check on it with video_status (jobId: ${res.jobId}).`,
        });
      },
    },

    {
      name: "video_status",
      description:
        "Check a video render started with generate_video. Pass the jobId. " +
        "Returns the status (queued/running/completed/failed) and, when done, the " +
        "video's local path and a URL to view it.",
      category: "external",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: { jobId: { type: "string", description: "The jobId from generate_video." } },
        required: ["jobId"],
        additionalProperties: false,
      },
      async execute(params, context): Promise<ToolResult> {
        const jobId = String(params.jobId ?? "").trim();
        if (!jobId) return fail("jobId is required");
        const config = resolveRenderConfig(context.db);
        const res = await pollRender(config, jobId);
        if (!res.ok) return fail(res.error ?? "Could not fetch render status.", true);
        return ok({
          jobId: res.jobId,
          status: res.status,
          done: res.done,
          failed: res.failed,
          videoUrl: res.videoUrl,
          outputPath: res.outputPath,
          seconds: res.seconds,
          error: res.error,
        });
      },
    },
  ];
}
