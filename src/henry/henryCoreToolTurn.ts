/**
 * HenryCore — tool-capable turns for the local Ollama brain.
 *
 * `runHenryCoreOllamaToolTurn` / `handleOllamaToolEnabledTurn` run a bounded loop
 * (max 3 model calls): optional tool use → Henry-owned execution → grounded reply.
 * On failure or malformed provider output, returns `fallback_stream` so the UI
 * keeps the normal streaming chat path without crashing.
 */

export {
  runHenryOllamaToolAgent,
  runHenryOllamaToolAgent as runHenryCoreOllamaToolTurn,
  type HenryOllamaToolTurnResult,
} from './henryTools/henryOllamaToolAgent';

/** Alias: “tool-enabled” HenryCore turn (same implementation). */
export { runHenryOllamaToolAgent as handleOllamaToolEnabledTurn } from './henryTools/henryOllamaToolAgent';
