const DEFAULT_DIRECT = 'http://127.0.0.1:11434';

/**
 * Prefer Henry’s loopback gateway (main process) when it is active so chat, tool agent,
 * and IPC share one URL and execution policy.
 */
export async function resolveLocalOllamaBaseUrl(
  fallback: string = DEFAULT_DIRECT
): Promise<string> {
  try {
    const gw = await window.henryAPI.getLocalGatewayStatus?.();
    if (gw?.active && gw.url) return gw.url.replace(/\/$/, '');
  } catch {
    /* ignore */
  }
  return fallback.replace(/\/$/, '');
}
