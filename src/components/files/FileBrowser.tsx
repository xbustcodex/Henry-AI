import { useState, useEffect } from 'react';
import CodeEditor from './CodeEditor';
import { setDesign3dReferencePath } from '@/henry/design3dReferenceContext';
import { HENRY_FILES_NAVIGATE_DIR_KEY } from '@/henry/writerDraftContext';
import { setActiveWorkspaceContext } from '@/henry/workspaceContext';

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: string;
}

export default function FileBrowser() {
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<string[]>([]);
  const [editedContent, setEditedContent] = useState<string>('');
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isBinaryFile, setIsBinaryFile] = useState(false);

  useEffect(() => {
    try {
      const dir = localStorage.getItem(HENRY_FILES_NAVIGATE_DIR_KEY)?.trim();
      if (dir) {
        localStorage.removeItem(HENRY_FILES_NAVIGATE_DIR_KEY);
        setCurrentPath(dir);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath]);

  async function loadDirectory(path: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await window.henryAPI.readDirectory(path || undefined);
      setEntries(result.entries || []);
      setBreadcrumbs(result.path ? result.path.split('/').filter(Boolean) : []);
    } catch (err: any) {
      setError(err.message || 'Failed to read directory');
    } finally {
      setLoading(false);
    }
  }

  async function openFile(filePath: string) {
    setIsBinaryFile(false);
    setError(null);
    try {
      const content = await window.henryAPI.readFile(filePath);
      setSelectedFile(filePath);
      setFileContent(content);
      setEditedContent(content);
      setHasChanges(false);
    } catch (err: any) {
      const msg: string = err.message || '';
      if (msg.startsWith('BINARY_FILE')) {
        // Binary file — show the file name in the tab but not garbage in the editor
        setSelectedFile(filePath);
        setIsBinaryFile(true);
        setFileContent('');
        setEditedContent('');
        setHasChanges(false);
      } else {
        setError(msg || 'Failed to read file');
      }
    }
  }

  async function saveFile() {
    if (!selectedFile || !hasChanges) return;
    setSaving(true);
    try {
      await window.henryAPI.writeFile(selectedFile, editedContent);
      setFileContent(editedContent);
      setHasChanges(false);
    } catch (err: any) {
      setError(err.message || 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }

  function navigateToDirectory(entry: FileEntry) {
    if (entry.isDirectory) {
      setCurrentPath(entry.path);
      setSelectedFile(null);
    } else {
      openFile(entry.path);
    }
  }

  function navigateUp() {
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    setCurrentPath(parts.length > 0 ? '/' + parts.join('/') : '');
  }

  function navigateToBreadcrumb(index: number) {
    const parts = breadcrumbs.slice(0, index + 1);
    setCurrentPath('/' + parts.join('/'));
  }

  function getFileIcon(entry: FileEntry): string {
    if (entry.isDirectory) return '📁';
    const ext = entry.name.split('.').pop()?.toLowerCase();
    const icons: Record<string, string> = {
      ts: '🔷', tsx: '⚛️', js: '🟨', jsx: '⚛️',
      json: '📋', md: '📝', html: '🌐', css: '🎨',
      py: '🐍', rs: '🦀', go: '🔵', yaml: '⚙️',
      yml: '⚙️', toml: '⚙️', txt: '📄', svg: '🖼️',
      png: '🖼️', jpg: '🖼️', gif: '🖼️',
      sh: '💻', sql: '🗄️', env: '🔐', lock: '🔒',
    };
    return icons[ext || ''] || '📄';
  }

  function getLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const langs: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      json: 'json', md: 'markdown', html: 'html', css: 'css',
      py: 'python', rs: 'rust', go: 'go', yaml: 'yaml',
      yml: 'yaml', toml: 'toml', sh: 'bash', sql: 'sql',
    };
    return langs[ext || ''] || 'text';
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-henry-border/50">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-lg font-semibold text-henry-text">Files</h1>
          {selectedFile && hasChanges && (
            <button
              onClick={saveFile}
              disabled={saving}
              className="px-4 py-1.5 bg-henry-accent text-white rounded-lg text-xs font-medium hover:bg-henry-accent-hover transition-colors"
            >
              {saving ? 'Saving...' : 'Save Changes (⌘S)'}
            </button>
          )}
        </div>

        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 text-xs">
          <button
            onClick={() => setCurrentPath('')}
            className="text-henry-text-dim hover:text-henry-text transition-colors"
          >
            ~
          </button>
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-henry-text-muted">/</span>
              <button
                onClick={() => navigateToBreadcrumb(i)}
                className="text-henry-text-dim hover:text-henry-text transition-colors"
              >
                {crumb}
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* File list */}
        <div className="w-64 shrink-0 border-r border-henry-border/30 overflow-y-auto">
          {currentPath && (
            <button
              onClick={navigateUp}
              className="w-full flex items-center gap-2 px-4 py-2 text-xs text-henry-text-dim hover:bg-henry-hover/50 transition-colors"
            >
              <span>⬆️</span>
              <span>..</span>
            </button>
          )}

          {loading ? (
            <div className="p-4 text-xs text-henry-text-muted">Loading...</div>
          ) : error ? (
            <div className="p-4 text-xs text-henry-error">{error}</div>
          ) : entries.length === 0 ? (
            <div className="p-4 text-xs text-henry-text-muted">Empty directory</div>
          ) : (
            <div>
              {/* Directories first, then files */}
              {[...entries]
                .sort((a, b) => {
                  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                  return a.name.localeCompare(b.name);
                })
                .map((entry) => (
                  <div
                    key={entry.path}
                    className={`flex items-stretch border-b border-henry-border/15 last:border-b-0 ${
                      selectedFile === entry.path ? 'bg-henry-accent/10' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => navigateToDirectory(entry)}
                      className={`flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors ${
                        selectedFile === entry.path
                          ? 'text-henry-accent'
                          : 'text-henry-text hover:bg-henry-hover/50'
                      }`}
                    >
                      <span className="text-sm shrink-0">{getFileIcon(entry)}</span>
                      <span className="truncate">{entry.name}</span>
                      {entry.isDirectory && (
                        <span className="ml-auto shrink-0 text-henry-text-muted">→</span>
                      )}
                    </button>
                    {!entry.isDirectory && (
                      <button
                        type="button"
                        title="Use as Design3D reference (path only)"
                        onClick={() => setDesign3dReferencePath(entry.path)}
                        className="shrink-0 px-2 py-2 text-[9px] font-semibold uppercase tracking-wide text-henry-text-muted hover:text-henry-accent hover:bg-henry-hover/40 border-l border-henry-border/20"
                      >
                        Ref
                      </button>
                    )}
                    <button
                      type="button"
                      title="Use as chat workspace context (path only; does not load file contents)"
                      onClick={() =>
                        setActiveWorkspaceContext({
                          path: entry.path,
                          kind: entry.isDirectory ? 'folder' : 'file',
                          label: entry.name,
                        })
                      }
                      className="shrink-0 px-2 py-2 text-[9px] font-medium text-henry-text-muted hover:text-henry-accent hover:bg-henry-hover/40 border-l border-henry-border/20"
                    >
                      Context
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>

        {/* File content / editor */}
        <div className="flex-1 overflow-hidden">
          {selectedFile ? (
            <div className="h-full flex flex-col">
              {/* File tab */}
              <div className="shrink-0 flex items-center gap-2 px-4 py-2 bg-henry-surface/30 border-b border-henry-border/30">
                <span className="text-xs text-henry-text-dim">
                  {selectedFile.split('/').pop()}
                </span>
                {hasChanges && (
                  <span className="w-2 h-2 rounded-full bg-henry-accent" />
                )}
              </div>

              {/* Editor — or binary-file notice */}
              <div className="flex-1 overflow-auto">
                {isBinaryFile ? (
                  <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-8">
                    <span className="text-3xl">🚫</span>
                    <p className="text-sm text-henry-text-muted">
                      This file can't be displayed as text.
                    </p>
                    <p className="text-xs text-henry-text-dim">
                      Binary files like images, PDFs, and compiled code can't be edited here.
                    </p>
                  </div>
                ) : (
                  <CodeEditor
                    content={editedContent}
                    language={getLanguage(selectedFile)}
                    onChange={(value) => {
                      setEditedContent(value);
                      setHasChanges(value !== fileContent);
                    }}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <div className="text-3xl mb-3">📂</div>
                <p className="text-sm text-henry-text-dim">
                  Select a file to view or edit
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
