/**
 * Action Layer — chat bridge.
 *
 * Lets action handlers inject prompts into Henry's chat view
 * without tight coupling. Uses the same custom DOM event system
 * as the rest of the app (henry_secretary_prompt, henry_mode_launch, etc.)
 *
 * ChatView listens for 'henry_action_prompt' and pre-fills the input.
 *
 * Usage in a handler:
 *   import { sendToHenry } from '../../store/chatBridgeStore';
 *   sendToHenry('Summarize this thread: …');
 */

import { useStore as useAppStore } from '../../store';

/**
 * Navigate to Henry chat and inject a prompt to be auto-submitted.
 * The prompt is dispatched as a DOM event; ChatView fills the chat input.
 */
export function sendToHenry(prompt: string): void {
  useAppStore.getState().setCurrentView('chat');
  window.dispatchEvent(
    new CustomEvent('henry_action_prompt', { detail: { prompt } })
  );
}
