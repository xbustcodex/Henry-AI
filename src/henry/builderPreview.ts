/**
 * Henry Builder Preview — utilities for extracting rendered HTML from
 * builder-mode responses and managing live iframe previews.
 */

/**
 * Extract the first complete HTML document from an AI message.
 * Looks for ```html ... ``` blocks first, then bare <!DOCTYPE blocks.
 */
export function extractHtmlFromMessage(content: string): string | null {
  const htmlBlock = content.match(/```html\s*([\s\S]+?)```/i);
  if (htmlBlock) return htmlBlock[1].trim();

  const genericBlock = content.match(/```\s*(<!DOCTYPE[\s\S]+?)```/i);
  if (genericBlock) return genericBlock[1].trim();

  return null;
}

/**
 * Try to extract a partial/in-progress HTML document from streaming content.
 * Returns partial HTML as soon as we see a <!DOCTYPE or <html tag opening.
 * The partial HTML may be incomplete but browsers render it gracefully.
 */
export function extractPartialHtmlFromStream(streamingContent: string): string | null {
  const lower = streamingContent.toLowerCase();

  const codeBlockStart = lower.indexOf('```html');
  if (codeBlockStart !== -1) {
    const htmlStart = streamingContent.indexOf('\n', codeBlockStart) + 1;
    if (htmlStart > 0) {
      const partial = streamingContent.slice(htmlStart);
      if (partial.length > 50) return partial;
    }
  }

  const doctypeIdx = lower.indexOf('<!doctype');
  if (doctypeIdx !== -1) {
    const partial = streamingContent.slice(doctypeIdx);
    if (partial.length > 50) return partial;
  }

  const htmlIdx = lower.indexOf('<html');
  if (htmlIdx !== -1) {
    const partial = streamingContent.slice(htmlIdx);
    if (partial.length > 50) return partial;
  }

  return null;
}

/**
 * Download an HTML string as a .html file.
 */
export function downloadHtml(html: string, filename = 'app.html'): void {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
