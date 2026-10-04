/**
 * Web tools — Henry's window onto the open internet (design §1.6).
 *
 * Henry ships local-first with no bundled search API key, so this kit avoids
 * paid providers entirely:
 *
 *   - `web_search`     — DuckDuckGo's free Instant Answer API for quick factual
 *                        answers. No key, no signup. Silent tier (a read).
 *   - `web_fetch_page` — fetch an arbitrary URL, strip its HTML to text, and
 *                        truncate. Confirm tier: pulling a user/model-supplied
 *                        URL into context warrants a quick "ok?" so Henry can't
 *                        be steered into fetching something unexpected.
 *
 * Both cache in-process (Map, 5-min TTL) so repeated calls in one task — common
 * when the model retries or re-reasons — don't hammer the same endpoint.
 *
 * Network failures are `retryable: true` so the ToolRunner's backoff (design §5
 * retry policy for web_*) can have a second go.
 */

import { lookup } from "dns/promises";
import type { ToolDefinition, ToolResult } from "../types";

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

// ── In-memory cache (5-minute TTL) ──────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  expires: number;
  data: unknown;
}

const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): unknown | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return undefined;
  }
  return hit.data;
}

function cacheSet(key: string, data: unknown): void {
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

// ── HTTP with timeout ───────────────────────────────────────────────────────

const USER_AGENT = "HenryAI/1.0 (+https://henry.ai; local-first contractor assistant)";

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, ...headers },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── SSRF guard ──────────────────────────────────────────────────────────────
// `web_fetch_page` pulls a model/user-supplied URL into context. Even though
// it is confirm-tier, a page the user approves can 30x-redirect to an internal
// address (cloud metadata at 169.254.169.254, a LAN router, localhost admin).
// So we resolve each hop's host to its IP(s) and refuse private / loopback /
// link-local / unique-local ranges, and follow redirects manually so every hop
// is re-validated rather than trusting `redirect: "follow"`.

const MAX_REDIRECTS = 5;

/** True if an IPv4/IPv6 literal falls in a non-public (SSRF-sensitive) range. */
function isPrivateIp(ip: string): boolean {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — unwrap and check as IPv4.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPrivateIp(mapped[1]);

  if (ip.includes(".")) {
    const o = ip.split(".").map(Number);
    if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → refuse
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127) return true;            // this-network, private, loopback
    if (a === 169 && b === 254) return true;                      // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;             // private
    if (a === 192 && b === 168) return true;                      // private
    if (a === 100 && b >= 64 && b <= 127) return true;            // CGNAT
    if (a === 192 && b === 0 && o[2] === 0) return true;          // IETF protocol assignments
    if (a >= 224) return true;                                    // multicast / reserved
    return false;
  }

  // IPv6
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true;                   // loopback / unspecified
  if (v6.startsWith("fe80") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) return true; // link-local
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true;   // unique-local (fc00::/7)
  return false;
}

/** Resolve `hostname` and throw if it (or any literal it is) maps to a private IP. */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  // Obvious local names — block before any DNS.
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error(`Refusing to fetch a local address: ${hostname}`);
  }
  // IP literal → check directly. Hostname → resolve all A/AAAA and check each.
  const isLiteral = /^[\d.]+$/.test(host) || host.includes(":");
  if (isLiteral) {
    if (isPrivateIp(host)) throw new Error(`Refusing to fetch a private address: ${hostname}`);
    return;
  }
  const records = await lookup(host, { all: true });
  if (records.length === 0) throw new Error(`Could not resolve host: ${hostname}`);
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      throw new Error(`Refusing to fetch ${hostname} — it resolves to a private address (${r.address}).`);
    }
  }
}

/**
 * Fetch a public URL with SSRF protection: validate the host, follow redirects
 * manually (re-validating each hop), and time out. Throws on a blocked host.
 */
async function fetchPublicWithTimeout(
  startUrl: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Only http and https URLs are supported.");
      }
      await assertPublicHost(parsed.hostname);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, ...headers },
        redirect: "manual",
      });

      // Manual redirect handling so every hop is re-validated.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return res; // redirect without a target — hand back as-is
        url = new URL(loc, url).toString();
        continue;
      }
      return res;
    }
    throw new Error(`Too many redirects (>${MAX_REDIRECTS}).`);
  } finally {
    clearTimeout(timer);
  }
}

// ── HTML → text ─────────────────────────────────────────────────────────────

/**
 * Strip a page to readable text: drop script/style/noscript blocks and all
 * tags, decode the handful of entities that matter, and collapse whitespace.
 * Deliberately dependency-free — good enough to feed a spec sheet or pricing
 * page to the model, not a full DOM parse.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── DuckDuckGo Instant Answer shapes (only the fields we read) ───────────────

interface DDGRelatedTopic {
  Text?: string;
  FirstURL?: string;
  // Grouped topics nest their entries under Topics[]
  Topics?: DDGRelatedTopic[];
}

interface DDGResponse {
  Abstract?: string;
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Heading?: string;
  Answer?: string;
  AnswerType?: string;
  Definition?: string;
  DefinitionSource?: string;
  DefinitionURL?: string;
  RelatedTopics?: DDGRelatedTopic[];
}

/** Flatten DDG's (sometimes nested) RelatedTopics into {text, url} entries. */
function flattenRelated(topics: DDGRelatedTopic[] | undefined, max: number): Array<{ text: string; url: string }> {
  const out: Array<{ text: string; url: string }> = [];
  const walk = (list: DDGRelatedTopic[] | undefined) => {
    if (!list) return;
    for (const t of list) {
      if (out.length >= max) return;
      if (t.Text) out.push({ text: t.Text, url: t.FirstURL ?? "" });
      if (t.Topics) walk(t.Topics);
    }
  };
  walk(topics);
  return out.slice(0, max);
}

export function webTools(): ToolDefinition[] {
  return [
    // ── web_search ─────────────────────────────────────────────────────────
    {
      name: "web_search",
      description:
        "Search the web for a quick factual answer using DuckDuckGo's free " +
        "instant-answer service (no API key). Best for definitions, facts, " +
        '"who/what is", units, and well-known entities. Returns an abstract ' +
        "summary, its source, and a few related topics. Note: this is an " +
        "instant-answer service, not a full results page — for niche or very " +
        "recent queries the abstract may be empty, in which case use " +
        "web_fetch_page on a known URL instead.",
      category: "external",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(params) {
        const query = String(params.query ?? "").trim();
        if (!query) return fail("query is required");

        const cacheKey = `search:${query.toLowerCase()}`;
        const cached = cacheGet(cacheKey);
        if (cached !== undefined) return ok({ ...(cached as object), cached: true });

        try {
          const url =
            "https://api.duckduckgo.com/?q=" +
            encodeURIComponent(query) +
            "&format=json&no_html=1&skip_disambig=1";
          const res = await fetchWithTimeout(url, 10_000, { Accept: "application/json" });
          if (!res.ok) {
            return fail(`DuckDuckGo returned HTTP ${res.status}`, res.status >= 500);
          }
          const data = (await res.json()) as DDGResponse;

          const abstract = (data.AbstractText || data.Abstract || data.Answer || data.Definition || "").trim();
          const related = flattenRelated(data.RelatedTopics, 5);

          const result = {
            query,
            abstract,
            abstractSource: data.AbstractSource || data.DefinitionSource || "",
            abstractURL: data.AbstractURL || data.DefinitionURL || "",
            heading: data.Heading || "",
            relatedTopics: related,
            // Honest signal so the model knows when to fall back rather than
            // treating an empty abstract as "nothing exists".
            hasAnswer: abstract.length > 0 || related.length > 0,
            note:
              abstract.length === 0 && related.length === 0
                ? "DuckDuckGo had no instant answer for this query. Try rephrasing, or fetch a specific page with web_fetch_page."
                : undefined,
          };

          cacheSet(cacheKey, result);
          return ok(result);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const timedOut = /abort/i.test(msg);
          return fail(timedOut ? "web_search timed out after 10s" : `web_search failed: ${msg}`, true);
        }
      },
    },

    // ── web_fetch_page ───────────────────────────────────────────────────────
    {
      name: "web_fetch_page",
      description:
        "Fetch a specific web page and return its text content (HTML stripped, " +
        "truncated to ~4000 characters). Use to read a supplier's pricing page, " +
        "a product spec sheet, a tracking page, or any URL the user names. " +
        "Provide a full http(s) URL.",
      category: "external",
      safetyLevel: "confirm",
      confirmPrompt: (p) => `Fetch and read the page at ${String(p.url)}`,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full http(s) URL to fetch." },
        },
        required: ["url"],
        additionalProperties: false,
      },
      async execute(params) {
        const raw = String(params.url ?? "").trim();
        if (!raw) return fail("url is required");

        let parsed: URL;
        try {
          parsed = new URL(raw);
        } catch {
          return fail(`Not a valid URL: "${raw}"`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return fail("Only http and https URLs are supported.");
        }

        const cacheKey = `fetch:${parsed.toString()}`;
        const cached = cacheGet(cacheKey);
        if (cached !== undefined) return ok({ ...(cached as object), cached: true });

        try {
          const res = await fetchPublicWithTimeout(parsed.toString(), 10_000, {
            Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          });
          if (!res.ok) {
            return fail(`Fetch returned HTTP ${res.status} for ${parsed.toString()}`, res.status >= 500);
          }
          const contentType = res.headers.get("content-type") || "";
          const body = await res.text();
          const isHtml = /html|xml/i.test(contentType) || /^\s*</.test(body);
          const text = isHtml ? htmlToText(body) : body.trim();

          const MAX = 4000;
          const truncated = text.length > MAX;
          const result = {
            url: parsed.toString(),
            contentType,
            text: truncated ? text.slice(0, MAX) : text,
            truncated,
            originalLength: text.length,
          };

          cacheSet(cacheKey, result);
          return ok(result);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const timedOut = /abort/i.test(msg);
          // SSRF refusals, protocol errors, and too-many-redirects are
          // deterministic — retrying won't help, so mark them non-retryable.
          const deterministic = /Refusing to fetch|Only http|Too many redirects|Could not resolve host/i.test(msg);
          return fail(
            timedOut ? "web_fetch_page timed out after 10s" : `web_fetch_page failed: ${msg}`,
            timedOut ? true : !deterministic,
          );
        }
      },
    },
  ];
}
