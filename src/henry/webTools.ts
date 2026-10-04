/**
 * Henry Web Tools — structured tool definitions + execution layer.
 *
 * These tools are the bridge between Henry's LLMs and the live web.
 * LLMs cannot browse on their own — this layer does the browsing, then
 * injects the results as rich context before the streaming call.
 *
 * Tool definitions follow OpenAI function-calling schema so they are
 * ready for agentic use (Groq compound, GPT-4o tool calling, etc.).
 */

import {
  webSearch,
  fetchPageContent,
  formatSearchResultsForHenry,
  formatPageContentForHenry,
  type SearchResult,
} from '@/henry/webSearch';

// ── Tool schema definitions ────────────────────────────────────────────────────

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

export const HENRY_WEB_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search the web for current information, news, prices, facts, or any live data. Use when the user asks about recent events, current prices, latest news, or any topic that requires up-to-date information beyond training data.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. Be specific and focused.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open and read the full content of a specific URL. Use when the user shares a link or when search results point to a page that needs to be read in full.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to open (must start with https:// or http://).',
          },
          question: {
            type: 'string',
            description: 'Optional: the specific question to answer from this page.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_page_text',
      description: 'Extract the raw text content from a URL for analysis or summarization.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to extract text from.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'summarize_page',
      description: 'Summarize the content of a web page given its text. Use after extract_page_text.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The raw page content to summarize.',
          },
          focus: {
            type: 'string',
            description: 'Optional: what aspect of the page to focus on in the summary.',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'collect_sources',
      description: 'Collect and format source citations from search results or browsed pages.',
      parameters: {
        type: 'object',
        properties: {
          results: {
            type: 'string',
            description: 'JSON array of source objects with title and url fields.',
          },
        },
        required: ['results'],
      },
    },
  },
];

// ── Source tracking ────────────────────────────────────────────────────────────

export interface WebSource {
  title: string;
  url: string;
  type: 'search' | 'page';
}

// ── Detection ──────────────────────────────────────────────────────────────────

const WEB_TOOL_PATTERNS = [
  // Explicit requests
  /\b(search|look up|find|google|check online|research)\b/i,
  /\b(what'?s? (the )?latest|what'?s? new|any news)\b/i,
  /\b(current|latest|recent|today'?s?|this week'?s?|live)\b.{0,20}\b(news|price|rate|score|status|version|update|event)\b/i,
  // Time-sensitive queries
  /\b(right now|as of|currently|at the moment)\b/i,
  /\b202[4-9]\b/,
  // Price / stock / currency
  /\b(price of|cost of|how much (is|does|do)|stock price|market cap|exchange rate|usd|eur|gbp|crypto)\b/i,
  // News / events
  /\b(news|breaking|announcement|just (announced|released|launched|happened))\b/i,
  /\bwhat happened\b/i,
  // Weather
  /\b(weather|forecast|temperature|rain|snow) (in |for |at )?\w/i,
  // People / companies (live)
  /\b(ceo|founder|president|prime minister) of\b/i,
  /\b(who (is|runs|leads|owns)|when (did|was|is))\b.{5,}/i,
  // Explicit URL browsing
  /https?:\/\/[^\s]{5,}/,
  // Research requests
  /\b(summarize|analyze|read).{0,10}(this (page|article|link|url|site)|the link)\b/i,
  /\b(find me|show me|tell me about).{5,}online\b/i,
];

/**
 * Returns true if this message should trigger web tool access.
 * More comprehensive than autoShouldSearch — covers research tasks,
 * URL browsing, and explicit search requests.
 */
export function shouldUseWebTools(content: string): boolean {
  const lower = content.toLowerCase().trim();
  // Always skip for very short messages (< 8 chars)
  if (lower.length < 8) return false;
  return WEB_TOOL_PATTERNS.some((p) => p.test(content));
}

/**
 * Extract the most likely search query from a user message.
 * Falls back to the whole message trimmed.
 */
export function extractSearchQuery(content: string): string {
  const trimmed = content.trim();
  // If message starts with explicit "search for X" or "look up X"
  const explicit = trimmed.match(/^(?:search (?:for|the web for|online for)?|look up|google|find)\s+(.+)/i);
  if (explicit) return explicit[1].replace(/[?.!]+$/, '').trim();
  // Strip filler prefixes like "what is the", "tell me about", etc.
  const stripped = trimmed
    .replace(/^(what('?s| is) |who('?s| is) |when('?s| is) |where('?s| is) |how (much|many|do|does) |tell me about |find out |show me |give me |i need to know )/i, '')
    .replace(/[?.!]+$/, '')
    .trim();
  return stripped.slice(0, 200);
}

/**
 * Extract the first URL found in a message, if any.
 */
export function extractUrlFromMessage(content: string): string | null {
  const match = content.match(/https?:\/\/[^\s<>"']+/);
  return match ? match[0] : null;
}

// ── Tool execution ─────────────────────────────────────────────────────────────

export interface ToolResult {
  toolName: string;
  context: string;
  sources: WebSource[];
}

/** Execute the search_web tool. */
async function executeSearchWeb(
  query: string,
  apiKeys: { googleApiKey?: string; googleCx?: string; braveApiKey?: string },
): Promise<ToolResult> {
  const sr = await webSearch(query, apiKeys);
  const context = formatSearchResultsForHenry(sr);
  const sources: WebSource[] = sr.results.slice(0, 6).map((r: SearchResult) => ({
    title: r.title,
    url: r.url,
    type: 'search' as const,
  }));
  return { toolName: 'search_web', context, sources };
}

/** Execute the open_url tool. */
async function executeOpenUrl(url: string, question?: string): Promise<ToolResult> {
  const page = await fetchPageContent(url);
  const context = formatPageContentForHenry(page) + (question ? `\n\nFocus on: ${question}` : '');
  const sources: WebSource[] = page.error
    ? []
    : [{ title: page.title || url, url, type: 'page' as const }];
  return { toolName: 'open_url', context, sources };
}

/** Summarize page content (client-side formatting, no extra LLM call). */
function executeSummarizePage(content: string, focus?: string): ToolResult {
  const trimmed = content.slice(0, 6000);
  const context = focus
    ? `[Page content — focus on: ${focus}]\n${trimmed}`
    : `[Page content]\n${trimmed}`;
  return { toolName: 'summarize_page', context, sources: [] };
}

/** Format collected sources. */
function executeCollectSources(resultsJson: string): ToolResult {
  try {
    const items = JSON.parse(resultsJson) as Array<{ title: string; url: string }>;
    const lines = items.map((s, i) => `${i + 1}. [${s.title}](${s.url})`);
    return { toolName: 'collect_sources', context: lines.join('\n'), sources: [] };
  } catch {
    return { toolName: 'collect_sources', context: resultsJson, sources: [] };
  }
}

// ── Main auto-tool runner ─────────────────────────────────────────────────────

export interface WebToolsResult {
  contextBlock: string;
  sources: WebSource[];
  toolsUsed: string[];
}

export interface WebToolsOptions {
  googleApiKey?: string;
  googleCx?: string;
  braveApiKey?: string;
  onStatus?: (msg: string) => void;
}

/**
 * Automatically decide which web tools to run for a user message,
 * execute them, and return enriched context + sources for injection
 * into the LLM system prompt.
 *
 * Priority:
 * 1. If message contains a URL → open_url
 * 2. Otherwise → search_web with extracted query
 */
export async function runWebTools(
  content: string,
  options: WebToolsOptions = {},
): Promise<WebToolsResult> {
  const { googleApiKey, googleCx, braveApiKey, onStatus } = options;
  const apiKeys = { googleApiKey, googleCx, braveApiKey };

  const allResults: ToolResult[] = [];
  const toolsUsed: string[] = [];

  // 1. URL in message → open it
  const url = extractUrlFromMessage(content);
  if (url) {
    onStatus?.('Reading page…');
    const urlContent = content.replace(url, '').trim() || undefined;
    const result = await executeOpenUrl(url, urlContent);
    allResults.push(result);
    toolsUsed.push('open_url');
  }

  // 2. Also search the web (unless the message is purely a URL with no other text)
  const hasNonUrlContent = content.replace(/https?:\/\/[^\s]+/g, '').trim().length > 5;
  if (hasNonUrlContent) {
    const query = extractSearchQuery(content);
    onStatus?.(`Searching: "${query.slice(0, 50)}${query.length > 50 ? '…' : ''}"`);
    const result = await executeSearchWeb(query, apiKeys);
    allResults.push(result);
    toolsUsed.push('search_web');
  }

  // Merge context blocks
  const contextParts = allResults.map((r) => r.context);
  const allSources = allResults.flatMap((r) => r.sources);

  const contextBlock = contextParts.length > 0
    ? `## Live Web Context\n\n${contextParts.join('\n\n---\n\n')}\n\n---\n\nUse the above web results to answer accurately. Always cite source URLs when referencing specific facts.`
    : '';

  return { contextBlock, sources: allSources, toolsUsed };
}

// ── Source citation formatter ──────────────────────────────────────────────────

/**
 * Format sources into a compact citation block shown below Henry's response.
 */
export function formatSourceCitations(sources: WebSource[]): string {
  if (sources.length === 0) return '';
  const unique = sources.filter((s, i, arr) => arr.findIndex((x) => x.url === s.url) === i);
  const lines = unique.slice(0, 6).map((s, i) => `${i + 1}. [${s.title.slice(0, 80)}](${s.url})`);
  return `\n\n---\n**Sources**\n${lines.join('\n')}`;
}
