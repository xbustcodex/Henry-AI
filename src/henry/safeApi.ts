/**
 * Safe API wrapper — prevents "api.X is not a function" crashes.
 * Use safeApi(fn, fallback) instead of direct api.X() calls in components.
 */

const api = (window as any).henryAPI as Record<string, unknown>;

/**
 * Safely call an API method. Returns fallback if not available or throws.
 * @example const tasks = await safeApi(() => api.tasksList({ status: 'todo' }), []);
 */
export async function safeApi<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    if (typeof fn !== 'function') return fallback;
    const result = await fn();
    return result ?? fallback;
  } catch (e) {
    console.warn('[Henry] API call failed:', e);
    return fallback;
  }
}

/**
 * Safely call a sync API method. Returns fallback if not available or throws.
 */
export function safeApiSync<T>(fn: () => T, fallback: T): T {
  try {
    if (typeof fn !== 'function') return fallback;
    return fn() ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Check if an API method exists before calling it.
 */
export function hasApi(name: string): boolean {
  return typeof api?.[name] === 'function';
}

export { api };
