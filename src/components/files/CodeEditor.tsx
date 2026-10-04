import { useRef, useEffect, useState } from 'react';

interface CodeEditorProps {
  content: string;
  language: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}

/**
 * Simple code editor with syntax highlighting.
 * Phase 3 will integrate Monaco Editor for full IDE experience.
 * For now, a styled textarea with line numbers gets the job done.
 */
export default function CodeEditor({
  content,
  language,
  onChange,
  readOnly = false,
}: CodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const [lineCount, setLineCount] = useState(1);

  useEffect(() => {
    const lines = content.split('\n').length;
    setLineCount(lines);
  }, [content]);

  // Sync scroll between line numbers and editor
  function handleScroll() {
    if (lineNumbersRef.current && textareaRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }

  // Handle tab key
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;

      // Insert 2 spaces
      const newValue = value.substring(0, start) + '  ' + value.substring(end);
      onChange(newValue);

      // Restore cursor position
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      });
    }

    // Cmd/Ctrl+S to save
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      // Save is handled by parent component
    }
  }

  return (
    <div className="h-full flex font-mono text-xs bg-henry-bg">
      {/* Line numbers */}
      <div
        ref={lineNumbersRef}
        className="shrink-0 w-12 overflow-hidden bg-henry-surface/20 border-r border-henry-border/20 text-right pr-3 pt-3 select-none"
        style={{ overflowY: 'hidden' }}
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div
            key={i}
            className="leading-5 text-henry-text-muted"
          >
            {i + 1}
          </div>
        ))}
      </div>

      {/* Editor */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => onChange(e.target.value)}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        readOnly={readOnly}
        spellCheck={false}
        className="flex-1 bg-transparent text-henry-text outline-none resize-none p-3 leading-5 overflow-auto"
        style={{
          tabSize: 2,
          fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
        }}
      />
    </div>
  );
}
