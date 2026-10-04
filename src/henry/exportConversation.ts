/**
 * Export conversation as a clean Markdown file.
 * Strips streaming artifacts, formats code blocks, preserves structure.
 */

import type { Message } from '../types';

export function conversationToMarkdown(
  messages: Message[],
  conversationTitle?: string,
): string {
  const title = conversationTitle ?? 'Henry Conversation';
  const date = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const lines: string[] = [
    `# ${title}`,
    `*Exported ${date}*`,
    '',
    '---',
    '',
  ];

  for (const msg of messages) {
    if (!msg.content?.trim()) continue;

    const role = msg.role === 'user' ? '**You**' : '**Henry**';
    const engine = msg.engine === 'worker' ? ' *(Worker)*' : '';
    const ts = msg.created_at
      ? new Date(msg.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : '';

    lines.push(`### ${role}${engine}${ts ? ` · ${ts}` : ''}`);
    lines.push('');

    // Clean up streaming artifacts
    const clean = msg.content
      .replace(/\n\n\*\[Cancelled\]\*$/, '')
      .replace(/\*\[Response cancelled\]\*/g, '')
      .trim();

    lines.push(clean);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

export function downloadMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.md') ? filename : `${filename}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportConversation(
  messages: Message[],
  conversationTitle?: string,
): void {
  const md = conversationToMarkdown(messages, conversationTitle);
  const slug = (conversationTitle ?? 'henry-chat')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  const date = new Date().toISOString().slice(0, 10);
  downloadMarkdown(md, `${slug}-${date}.md`);
}
