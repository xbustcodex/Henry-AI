/**
 * What a folder IS, decided from its name and its children's names.
 *
 * ── Why classification exists ───────────────────────────────────────────────
 *
 * A flat list of 300,000 paths tells Henry nothing it can act on. Knowing that
 * `~/code/henry` is a git repository and `~/.ollama/models` is a model store is
 * what turns an inventory into a map — those are the folders a user asks
 * questions about, and the ones whose changes are worth reporting.
 *
 * ── Metadata only, and that is enough ───────────────────────────────────────
 *
 * Every signal below is a NAME: the folder's own name, or a name in the listing
 * the scanner already had to take to walk the tree. Nothing here opens a file. A
 * `.git` directory, a `package.json`, a `.gguf` file — identified by name, never
 * read. That constraint is what makes classification cheap enough to run on
 * every directory of every scan, and why the confidence values are honest
 * rather than clever.
 *
 * Confidence is reported because both alternatives are bad: claiming certainty
 * we do not have, or hiding the guess entirely. `high` means a marker that
 * essentially only that thing produces; `medium` means a naming convention that
 * is suggestive; `low` means the contents merely lean that way. A folder
 * matching nothing is `other` — an answer, not a failure.
 */

import type { DirectoryClassification, SystemMapFileType } from './types';

/** One directory's verdict. */
export interface Classification {
  classification: DirectoryClassification;
  /** How sure the classifier is. Absent for `other`. */
  confidence?: 'high' | 'medium' | 'low';
  /** The evidence, in words a user could read. */
  reason: string;
}

/** The facts about one directory that classification is allowed to use. */
export interface ClassifiableDirectory {
  /** The folder's own name, e.g. `Documents`. */
  name: string;
  /** Absolute path. Used only for platform-specific path conventions. */
  path: string;
  /** Names of its direct children. Names, not contents. */
  childNames: readonly string[];
}

/** What the classifier concluded, plus the tally it concluded it from. */
export interface ClassifyResult extends Classification {
  /** Children counted by file type, by extension. */
  childTypeCounts: Partial<Record<SystemMapFileType, number>>;
}

// ── Extension maps ───────────────────────────────────────────────────────────

/**
 * Model weight files. Large and distinctive: a couple of them in one folder is
 * a far stronger signal than a folder merely called `models`, which on some
 * machines is a symlink to something else entirely.
 */
const MODEL_EXTENSIONS: readonly string[] = [
  '.gguf',
  '.ggml',
  '.safetensors',
  '.ckpt',
  '.pt',
  '.pth',
  '.onnx',
  '.mlmodel',
  '.tflite',
];

const IMAGE_EXTENSIONS: readonly string[] = [
  '.jpg', '.jpeg', '.png', '.gif', '.heic', '.webp', '.tif', '.tiff', '.bmp', '.svg', '.raw', '.cr2',
];
const AUDIO_EXTENSIONS: readonly string[] = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus'];
const VIDEO_EXTENSIONS: readonly string[] = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.wmv'];

const DOCUMENT_EXTENSIONS: readonly string[] = ['.doc', '.docx', '.odt', '.rtf', '.txt', '.md', '.pages'];
const SPREADSHEET_EXTENSIONS: readonly string[] = ['.xlsx', '.xls', '.csv', '.numbers'];
const PRESENTATION_EXTENSIONS: readonly string[] = ['.pptx', '.ppt', '.key'];
const CODE_EXTENSIONS: readonly string[] = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.rb',
  '.swift', '.php', '.sh', '.lua', '.sql', '.css', '.html',
];
const CONFIG_EXTENSIONS: readonly string[] = ['.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.env'];
const DATABASE_EXTENSIONS: readonly string[] = ['.db', '.sqlite', '.sqlite3', '.mdb', '.realm'];
const ARCHIVE_EXTENSIONS: readonly string[] = ['.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.zst', '.tgz'];
const EXECUTABLE_EXTENSIONS: readonly string[] = [
  '.exe', '.dll', '.so', '.dylib', '.bin', '.app', '.msi', '.deb', '.rpm', '.appimage', '.command', '.jar',
];
const FONT_EXTENSIONS: readonly string[] = ['.ttf', '.otf', '.woff', '.woff2', '.eot'];

/** What a file is, from its extension alone. */
export function fileTypeForExtension(extension: string): SystemMapFileType {
  const ext = extension.toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.log') return 'log';
  if (MODEL_EXTENSIONS.includes(ext)) return 'model';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (DOCUMENT_EXTENSIONS.includes(ext)) return 'document';
  if (SPREADSHEET_EXTENSIONS.includes(ext)) return 'spreadsheet';
  if (PRESENTATION_EXTENSIONS.includes(ext)) return 'presentation';
  if (CODE_EXTENSIONS.includes(ext)) return 'code';
  if (CONFIG_EXTENSIONS.includes(ext)) return 'config';
  if (DATABASE_EXTENSIONS.includes(ext)) return 'database';
  if (ARCHIVE_EXTENSIONS.includes(ext)) return 'archive';
  if (EXECUTABLE_EXTENSIONS.includes(ext)) return 'executable';
  if (FONT_EXTENSIONS.includes(ext)) return 'font';
  if (ext === '.py' || ext === '.ts') return 'code';
  return 'other';
}

// ── Name conventions ─────────────────────────────────────────────────────────

/**
 * Folders that mean the same thing across the languages Henry ships in.
 *
 * Matched case-insensitively against the folder's own name. Deliberately not
 * exhaustive: a locale Henry does not ship in falls through to the content
 * signals below rather than to a wrong answer.
 */
const NAME_BY_DOCUMENTS: readonly string[] = [
  'documents', 'documentos', 'dokumente', 'documenti', 'bureau', '文書', 'ドキュメント', '文档',
  'escritorio', 'schreibtisch', 'Área de trabalho', 'area de trabalho', 'bureau des documents',
];
const NAME_BY_DESKTOP: readonly string[] = ['desktop', 'escritorio', 'schreibtisch', 'area de trabalho'];
const NAME_BY_DOWNLOADS: readonly string[] = ['downloads', 'descargas', 'download', 'ダウンロード', '下载'];
const NAME_BY_MEDIA: readonly string[] = [
  'pictures', 'photos', 'images', 'fotos', 'bilder', 'immagini', '写真', '图片',
  'videos', 'movies', 'vidéos', 'filme', '動画',
  'music', 'musik', 'musica', 'musique', '音楽', '音乐',
];
const NAME_BY_APPLICATIONS: readonly string[] = [
  'applications', 'program files', 'program files (x86)', 'apps', 'snap', 'flatpak', 'anwendungen',
];
const NAME_BY_USER_DATA: readonly string[] = [
  'application support', 'appdata', '.config', '.local', 'library', 'daten',
];
const NAME_BY_SYSTEM: readonly string[] = [
  'system', 'windows', 'system32', 'usr', 'etc', 'var', 'bin', 'sbin', 'lib', 'lib64', 'boot',
  'proc', 'sys', 'dev', 'private',
];

/** A directory containing this entry is a git working tree root. */
const GIT_MARKER = '.git';

/**
 * Project manifest files. Present ⇒ the folder is a software project.
 *
 * Each is written at a project root by its ecosystem, and none is read: the
 * name in the listing is the whole signal.
 */
const PROJECT_MARKERS: readonly string[] = [
  'package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'cargo.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'gemfile', 'composer.json', 'makefile',
  'cmakelists.txt', 'tsconfig.json', 'dockerfile', '.gitignore',
];

// ── The classifier ───────────────────────────────────────────────────────────

/**
 * Classify one directory from its name and its children's names.
 *
 * The pure function the scanner calls once per directory, exported for the
 * tests to drive directly with hand-written child lists.
 */
export function classifyDirectory(dir: ClassifiableDirectory): ClassifyResult {
  const lowerName = dir.name.toLowerCase().trim();
  const childNames = dir.childNames;
  const lowerChildren = childNames.map((child) => child.toLowerCase());

  const childTypeCounts: Partial<Record<SystemMapFileType, number>> = {};
  for (const child of lowerChildren) {
    const ext = extensionOf(child);
    if (!ext) continue;
    const type = fileTypeForExtension(ext);
    childTypeCounts[type] = (childTypeCounts[type] ?? 0) + 1;
  }
  const countOf = (type: SystemMapFileType): number => childTypeCounts[type] ?? 0;
  const mediaCount = countOf('image') + countOf('audio') + countOf('video');

  // ── git ───────────────────────────────────────────────────────────────
  // Checked before the broader project rule: a git repository is the more
  // specific and more useful answer, and both statements are true.
  if (childNames.includes(GIT_MARKER)) {
    return {
      classification: 'git-repository',
      confidence: 'high',
      reason: 'Contains a .git folder, so it is a version-controlled project.',
      childTypeCounts,
    };
  }

  // ── model store ───────────────────────────────────────────────────────
  const modelCount = countOf('model');
  const nameSaysModels = /(^|\W)(models?|weights|checkpoints)(\W|$)/.test(lowerName);
  if (modelCount >= 2 || (nameSaysModels && modelCount >= 1)) {
    return {
      classification: 'model-store',
      confidence: modelCount >= 2 ? 'high' : 'medium',
      reason:
        modelCount >= 2
          ? `Holds ${modelCount} model weight files.`
          : 'Its name says models and it holds a weight file.',
      childTypeCounts,
    };
  }

  // ── cache ─────────────────────────────────────────────────────────────
  // Before the generic user-data and name rules: "cache" is both the most
  // specific and the least interesting answer.
  if (CACHE_NAME_PATTERN.test(lowerName) || lowerName === '__pycache__') {
    return {
      classification: 'cache',
      confidence: 'high',
      reason: 'A cache folder — regenerable, so it needs no map entry of its own.',
      childTypeCounts,
    };
  }

  // ── project ───────────────────────────────────────────────────────────
  const markers = lowerChildren.filter((child) => PROJECT_MARKERS.includes(child));
  if (markers.length > 0) {
    return {
      classification: 'project',
      confidence: 'high',
      reason: `Holds project files (${markers.slice(0, 3).join(', ')}).`,
      childTypeCounts,
    };
  }
  // A folder that is nothing but source files is a project without a manifest —
  // common for scripts and notebooks. Real, and reported as weak.
  const codeCount = countOf('code');
  if (codeCount >= 3 && codeCount * 2 >= childNames.length) {
    return {
      classification: 'project',
      confidence: 'low',
      reason: 'Almost everything in it is source code.',
      childTypeCounts,
    };
  }

  // ── name conventions ──────────────────────────────────────────────────
  const named = (names: readonly string[]): boolean => names.includes(lowerName);
  if (named(NAME_BY_APPLICATIONS)) {
    return {
      classification: 'applications',
      confidence: 'high',
      reason: 'Its name says it holds applications.',
      childTypeCounts,
    };
  }
  if (named(NAME_BY_DOCUMENTS) || named(NAME_BY_DESKTOP) || named(NAME_BY_DOWNLOADS)) {
    const kind = named(NAME_BY_DOCUMENTS)
      ? 'documents'
      : named(NAME_BY_DESKTOP)
        ? 'desktop'
        : 'downloads';
    return {
      classification: 'documents',
      confidence: 'high',
      reason: `It is this user's ${kind} folder.`,
      childTypeCounts,
    };
  }
  if (named(NAME_BY_MEDIA)) {
    return {
      classification: 'media',
      confidence: mediaCount > 0 ? 'high' : 'medium',
      reason:
        mediaCount > 0
          ? `It is a media folder and holds ${mediaCount} media files.`
          : 'Its name says it holds photos, video or music.',
      childTypeCounts,
    };
  }
  if (named(NAME_BY_USER_DATA)) {
    return {
      classification: 'user-data',
      confidence: 'medium',
      reason: 'It is where applications keep per-user data.',
      childTypeCounts,
    };
  }
  if (named(NAME_BY_SYSTEM)) {
    return {
      classification: 'system',
      confidence: 'high',
      reason: 'It belongs to the operating system.',
      childTypeCounts,
    };
  }

  // ── content-based fallbacks, before giving up ─────────────────────────
  const documentCount = countOf('document') + countOf('pdf') + countOf('text');
  if (documentCount >= 3 && documentCount * 2 >= childNames.length) {
    return {
      classification: 'documents',
      confidence: 'low',
      reason: `Mostly documents (${documentCount} of them).`,
      childTypeCounts,
    };
  }
  if (mediaCount >= 5 && mediaCount * 2 >= childNames.length) {
    return {
      classification: 'media',
      confidence: 'low',
      reason: `Mostly photos, video or music (${mediaCount} files).`,
      childTypeCounts,
    };
  }

  // Nothing matched. Most folders on a machine are ordinary folders, and
  // labelling them as something would be a lie.
  return { classification: 'other', reason: 'An ordinary folder.', childTypeCounts };
}

/** Cache folder names, including the ones nested inside other folders. */
const CACHE_NAME_PATTERN = /(^|\/)\.?cache(s)?$|^\.npm$|^\.gradle$|^\.nuget$|^\.cargo$|^__pycache__$/;

/** The extension of a name, lower-cased and dotted, or `''` when it has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}