/**
 * Henry Web Search — multi-source web access.
 * DuckDuckGo + Google CSE + Brave Search + URL content fetching via Jina.ai
 * Works in both Electron (direct) and web mode (CORS proxies).
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  abstract?: string;
  abstractUrl?: string;
  answer?: string;
  query: string;
  source?: string;
}

export interface BrowseResponse {
  url: string;
  content: string;
  title?: string;
  error?: string;
}

// ── URL pattern ───────────────────────────────────────────────────────────────

export function extractUrlsFromText(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"']+/g;
  return [...new Set(text.match(urlRegex) || [])];
}

export function startsWithUrl(text: string): string | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^(https?:\/\/[^\s]+)/);
  return match ? match[1] : null;
}

// ── Auto-search detection ─────────────────────────────────────────────────────

const SEARCH_TRIGGER_PATTERNS = [
  /\blatest\b/i, /\brecent\b/i, /\bbreaking\b/i, /\bnews\b/i,
  /\btoday\b/i, /\byesterday\b/i, /\bthis week\b/i, /\bthis month\b/i,
  /\bcurrent\b.*\b(price|rate|score|status|version)\b/i,
  /\bprice of\b/i, /\bstock price\b/i, /\bweather\b/i,
  /\bwho (is|was|are)\b.*\b(ceo|founder|president|prime minister)\b/i,
  /\bwhat happened\b/i, /\bjust announced\b/i, /\bjust released\b/i,
  /\bsearch (for|the web|online)\b/i, /\blook (it )?up\b/i,
  /\bfind out\b/i, /\b(google|search)\b.*\bfor\b/i,
  /\b202[456]\b/,
];

export function autoShouldSearch(message: string): boolean {
  return SEARCH_TRIGGER_PATTERNS.some((p) => p.test(message));
}

// ── URL Content Fetching (via Jina.ai — free, no API key) ────────────────────

export async function fetchPageContent(url: string): Promise<BrowseResponse> {
  const jinaUrl = `https://r.jina.ai/${url}`;
  try {
    const res = await fetch(jinaUrl, {
      signal: AbortSignal.timeout(20000),
      headers: { Accept: 'text/plain' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const firstLine = text.split('\n')[0] || '';
    const title = firstLine.startsWith('Title:') ? firstLine.slice(6).trim() : undefined;
    return {
      url,
      content: text.slice(0, 8000),
      title,
    };
  } catch (err) {
    return {
      url,
      content: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatPageContentForHenry(browse: BrowseResponse): string {
  if (browse.error) {
    return `🌐 **Browse failed for:** ${browse.url}\nError: ${browse.error}\n\nTry a different URL or summarize from your training knowledge.`;
  }
  const lines = [
    `🌐 **Web page content from:** ${browse.url}`,
    browse.title ? `**Title:** ${browse.title}` : '',
    '',
    browse.content,
  ];
  return lines.filter(Boolean).join('\n');
}

// ── DuckDuckGo ────────────────────────────────────────────────────────────────

function parseDDG(data: Record<string, unknown>, query: string): SearchResponse {
  const results: SearchResult[] = [];

  const topics = (data.RelatedTopics as unknown[]) || [];
  for (const item of topics) {
    const t = item as Record<string, unknown>;
    if (t.FirstURL && t.Text) {
      results.push({
        title: (t.Text as string).slice(0, 120),
        url: t.FirstURL as string,
        snippet: t.Text as string,
        source: 'ddg',
      });
    }
    if (t.Topics) {
      for (const sub of (t.Topics as Record<string, unknown>[]) || []) {
        if (sub.FirstURL && sub.Text) {
          results.push({
            title: (sub.Text as string).slice(0, 120),
            url: sub.FirstURL as string,
            snippet: sub.Text as string,
            source: 'ddg',
          });
        }
        if (results.length >= 10) break;
      }
    }
    if (results.length >= 10) break;
  }

  return {
    results,
    abstract: (data.AbstractText as string) || undefined,
    abstractUrl: (data.AbstractURL as string) || undefined,
    answer: (data.Answer as string) || undefined,
    query,
    source: 'DuckDuckGo',
  };
}

async function searchDDG(query: string): Promise<SearchResponse | null> {
  const qs = `?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const ddgUrl = `https://api.duckduckgo.com/${qs}`;
  const proxies = [
    `/proxy/ddg/${qs}`,
    ddgUrl,
    `https://corsproxy.io/?${encodeURIComponent(ddgUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(ddgUrl)}`,
  ];
  for (const url of proxies) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        return parseDDG(data as Record<string, unknown>, query);
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ── Google Custom Search Engine ───────────────────────────────────────────────

async function searchGoogle(query: string, apiKey: string, cx: string): Promise<SearchResponse | null> {
  try {
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${apiKey}&cx=${cx}&num=8`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json() as {
      items?: Array<{ title: string; link: string; snippet: string }>;
    };
    const results: SearchResult[] = (data.items || []).map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
      source: 'google',
    }));
    return { results, query, source: 'Google' };
  } catch {
    return null;
  }
}

// ── Brave Search ──────────────────────────────────────────────────────────────

async function searchBrave(query: string, apiKey: string): Promise<SearchResponse | null> {
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      web?: { results?: Array<{ title: string; url: string; description: string }> };
    };
    const results: SearchResult[] = (data.web?.results || []).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.description,
      source: 'brave',
    }));
    return { results, query, source: 'Brave' };
  } catch {
    return null;
  }
}

// ── Main search entry point ───────────────────────────────────────────────────

export async function webSearch(query: string, options?: {
  googleApiKey?: string;
  googleCx?: string;
  braveApiKey?: string;
}): Promise<SearchResponse> {
  const { googleApiKey, googleCx, braveApiKey } = options || {};

  // Try providers in priority order
  if (googleApiKey && googleCx) {
    const result = await searchGoogle(query, googleApiKey, googleCx);
    if (result && result.results.length > 0) return result;
  }

  if (braveApiKey) {
    const result = await searchBrave(query, braveApiKey);
    if (result && result.results.length > 0) return result;
  }

  const ddgResult = await searchDDG(query);
  if (ddgResult) return ddgResult;

  return {
    results: [],
    query,
    abstract: 'Search unavailable — check network connectivity.',
    source: 'none',
  };
}

// ── Format for Henry ──────────────────────────────────────────────────────────

export function formatSearchResultsForHenry(sr: SearchResponse): string {
  const lines: string[] = [`🔍 **Web search results for:** "${sr.query}"${sr.source ? ` (via ${sr.source})` : ''}\n`];

  if (sr.answer) {
    lines.push(`**Direct answer:** ${sr.answer}\n`);
  }

  if (sr.abstract) {
    lines.push(`**Summary:** ${sr.abstract}`);
    if (sr.abstractUrl) lines.push(`Source: ${sr.abstractUrl}`);
    lines.push('');
  }

  if (sr.results.length > 0) {
    lines.push('**Results:**');
    for (const r of sr.results.slice(0, 6)) {
      lines.push(`- **${r.title}**\n  ${r.snippet}\n  ${r.url}`);
    }
  } else if (!sr.abstract && !sr.answer) {
    lines.push('No results found. Answering from training knowledge — note this may not reflect the latest information.');
  }

  return lines.join('\n');
}

// ── Settings helpers ──────────────────────────────────────────────────────────

export function getSearchApiKeys(): { googleApiKey?: string; googleCx?: string; braveApiKey?: string } {
  try {
    const s = JSON.parse(localStorage.getItem('henry:settings') || '{}') as Record<string, string>;
    return {
      googleApiKey: s['search_google_api_key'] || undefined,
      googleCx: s['search_google_cx'] || undefined,
      braveApiKey: s['search_brave_api_key'] || undefined,
    };
  } catch {
    return {};
  }
}
