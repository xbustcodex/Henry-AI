/**
 * Tests for the direct render bridge + tools. Hermetic: `fetch`
 * is stubbed, no daemon required. Verifies the HTTP contract, quality presets,
 * status mapping, and the tool safety surface.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveRenderConfig, submitRender, pollRender, QUALITY_PRESETS } from "./renderBridge";
import { renderTools } from "./tools/render";

function makeDb(endpoint?: string) {
  return {
    prepare() {
      return { get: () => (endpoint === undefined ? undefined : { value: endpoint }) };
    },
  } as any;
}

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({ status, text: async () => JSON.stringify(body) }));
  // @ts-expect-error test override
  global.fetch = fn;
  return fn;
}

beforeEach(() => vi.restoreAllMocks());

describe("resolveRenderConfig", () => {
  it("defaults to localhost:8799 and strips trailing slash", () => {
    expect(resolveRenderConfig(makeDb()).endpoint).toBe("http://localhost:8799");
    expect(resolveRenderConfig(makeDb("http://x:9000/")).endpoint).toBe("http://x:9000");
  });
});

describe("submitRender", () => {
  const cfg = { endpoint: "http://localhost:8799" };

  it("POSTs to /render with the quality preset folded in, returns jobId", async () => {
    const fn = stubFetch(202, { jobId: "rnd_1", status: "queued" });
    const res = await submitRender(cfg, { prompt: "a cat", quality: "high" });
    expect(res).toMatchObject({ ok: true, jobId: "rnd_1" });
    const [url, init] = fn.mock.calls[0] as unknown as [string, any];
    expect(url).toBe("http://localhost:8799/render");
    expect(JSON.parse(init.body)).toMatchObject({ prompt: "a cat", ...QUALITY_PRESETS.high });
  });

  it("defaults to the balanced preset", async () => {
    const fn = stubFetch(202, { jobId: "rnd_2" });
    await submitRender(cfg, { prompt: "x" });
    expect(JSON.parse((fn.mock.calls[0] as unknown as [string, any])[1].body)).toMatchObject(QUALITY_PRESETS.balanced);
  });

  it("surfaces a non-2xx as an error", async () => {
    stubFetch(500, { error: "boom" });
    const res = await submitRender(cfg, { prompt: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/HTTP 500/);
  });
});

describe("pollRender", () => {
  const cfg = { endpoint: "http://localhost:8799" };
  it("maps completed → done with videoUrl", async () => {
    stubFetch(200, { status: "completed", videoUrl: "http://localhost:8799/video/rnd_1" });
    const res = await pollRender(cfg, "rnd_1");
    expect(res).toMatchObject({ ok: true, done: true, failed: false, videoUrl: "http://localhost:8799/video/rnd_1" });
  });
  it("maps failed → failed=true", async () => {
    stubFetch(200, { status: "failed", error: "oom" });
    expect(await pollRender(cfg, "r")).toMatchObject({ ok: true, failed: true, error: "oom" });
  });
});

describe("render tools — surface + guards", () => {
  const tools = renderTools();
  const gen = tools.find((t) => t.name === "generate_video")!;
  const status = tools.find((t) => t.name === "video_status")!;
  const ctx = { db: makeDb(), getWindow: () => null } as any;

  it("exposes generate_video (confirm) + video_status (silent)", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(["generate_video", "video_status"]);
    expect(gen.safetyLevel).toBe("confirm");
    expect(status.safetyLevel).toBe("silent");
  });
  it("generate_video rejects an empty prompt", async () => {
    expect((await gen.execute({ prompt: " " }, ctx)).ok).toBe(false);
  });
  it("generate_video submits + returns a jobId", async () => {
    stubFetch(202, { jobId: "rnd_9", status: "queued" });
    const r = await gen.execute({ prompt: "a dog", quality: "fast" }, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as any).jobId).toBe("rnd_9");
  });
  it("video_status requires a jobId", async () => {
    expect((await status.execute({}, ctx)).ok).toBe(false);
  });
});
