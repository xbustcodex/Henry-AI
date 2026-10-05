/**
 * What a folder is, decided from names alone.
 *
 * Two claims are under test:
 *
 *   1. **The specific cases are recognised.** A git repository, a model store, a
 *      documents folder and a project each get their own answer — asserted
 *      against the exact classification AND the evidence, because a classifier
 *      that reaches the right answer for the wrong reason will reach the wrong
 *      answer on the next machine.
 *   2. **The classifier never opens anything.** It takes names and returns a
 *      verdict; there is no path, no filesystem and no reader in its signature
 *      at all, which is asserted by construction (the input type has no
 *      content) rather than by a spy that would have nothing to spy on.
 *
 * The "ordinary folder" case matters as much as the others: a classifier that
 * labelled everything as a project would pass every positive assertion above and
 * be useless.
 */
import { describe, it, expect } from 'vitest';

import { classifyDirectory, fileTypeForExtension } from './classify';

/** Classify by name and child names, which is all the classifier gets. */
function classify(name: string, childNames: string[]) {
  return classifyDirectory({ name, path: `/home/buster/${name}`, childNames });
}

describe('a git repository is recognised', () => {
  it('identifies a folder holding a .git entry, with high confidence', () => {
    const result = classify('henry-ai', ['.git', 'package.json', 'src']);
    expect(result.classification).toBe('git-repository');
    expect(result.confidence).toBe('high');
    expect(result.reason).toContain('.git');
  });

  it('prefers git over the broader project answer', () => {
    // Both are true, but "git repository" is the more useful one, and a
    // classifier that answered "project" here would lose the fact the user
    // actually cares about.
    expect(classify('my-app', ['.git']).classification).toBe('git-repository');
  });

  it('does not call a folder with a .gitignore a repository', () => {
    // `.gitignore` is a file, not the repository marker.
    const result = classify('scripts', ['.gitignore', 'run.sh']);
    expect(result.classification).not.toBe('git-repository');
  });
});

describe('a model store is recognised', () => {
  it('identifies a folder holding several weight files', () => {
    const result = classify('blobs', ['model-1.gguf', 'model-2.gguf']);
    expect(result.classification).toBe('model-store');
    expect(result.confidence).toBe('high');
    expect(result.reason).toContain('model weight files');
  });

  it('identifies a folder named for models holding one weight file', () => {
    const result = classify('models', ['llama-3.gguf']);
    expect(result.classification).toBe('model-store');
    // One file plus a suggestive name is medium confidence, not certainty.
    expect(result.confidence).toBe('medium');
  });

  it('does not call an ordinary folder of documents a model store', () => {
    expect(classify('Documents', ['a.pdf', 'b.pdf']).classification).not.toBe('model-store');
  });

  it('counts weight extensions as the model file type', () => {
    expect(fileTypeForExtension('.gguf')).toBe('model');
    expect(fileTypeForExtension('.safetensors')).toBe('model');
    expect(fileTypeForExtension('.txt')).not.toBe('model');
  });
});

describe('a documents folder is recognised', () => {
  it('identifies the conventional name', () => {
    const result = classify('Documents', ['report.pdf', 'notes.docx']);
    expect(result.classification).toBe('documents');
    expect(result.confidence).toBe('high');
  });

  it('identifies a translated name, because users do not all have Documents', () => {
    expect(classify('Dokumente', ['a.pdf']).classification).toBe('documents');
    expect(classify('ドキュメント', []).classification).toBe('documents');
    expect(classify('Documentos', []).classification).toBe('documents');
  });

  it('identifies Desktop and Downloads as document locations too', () => {
    expect(classify('Desktop', ['screenshot.png']).classification).toBe('documents');
    expect(classify('Downloads', ['installer.dmg']).classification).toBe('documents');
  });

  it('identifies a folder of documents by what is in it, at low confidence', () => {
    const result = classify('inbox', ['a.pdf', 'b.pdf', 'c.docx', 'd.txt']);
    expect(result.classification).toBe('documents');
    // Reported as weak on purpose: "mostly documents" is a guess.
    expect(result.confidence).toBe('low');
  });
});

describe('a project is recognised', () => {
  it('identifies a folder holding a project manifest', () => {
    const result = classify('api', ['package.json', 'src', 'README.md']);
    expect(result.classification).toBe('project');
    expect(result.confidence).toBe('high');
    expect(result.reason).toContain('package.json');
  });

  it('recognises a non-JavaScript project by its own manifest', () => {
    expect(classify('service', ['pyproject.toml']).classification).toBe('project');
    expect(classify('tool', ['Cargo.toml']).classification).toBe('project');
    expect(classify('daemon', ['go.mod']).classification).toBe('project');
  });

  it('identifies a manifest-less folder of source as a weak project', () => {
    const result = classify('scripts', ['a.py', 'b.py', 'c.py', 'notes.txt']);
    expect(result.classification).toBe('project');
    expect(result.confidence).toBe('low');
  });
});

describe('the remaining classifications', () => {
  it('identifies a media folder', () => {
    expect(classify('Pictures', ['cat.jpg', 'dog.jpg']).classification).toBe('media');
    expect(classify('Music', ['song.mp3']).classification).toBe('media');
  });

  it('identifies an applications folder', () => {
    expect(classify('Applications', ['Firefox.app']).classification).toBe('applications');
  });

  it('identifies a cache folder before the broader user-data answer', () => {
    // Both would fit; "cache" is the more specific and more useful answer.
    expect(classify('.cache', ['pip', 'npm']).classification).toBe('cache');
  });

  it('identifies per-user application data', () => {
    expect(classify('Application Support', ['Firefox']).classification).toBe('user-data');
  });

  it('identifies an operating-system folder', () => {
    expect(classify('System', ['Library', 'Frameworks']).classification).toBe('system');
  });
});

describe('an ordinary folder is not forced into a category', () => {
  it('answers "other" with no confidence claim', () => {
    const result = classify('stuff', ['notes.txt', 'photo.jpg']);
    expect(result.classification).toBe('other');
    // No confidence, because no claim was made.
    expect(result.confidence).toBeUndefined();
  });

  it('handles an empty folder without inventing anything', () => {
    const result = classify('new folder', []);
    expect(result.classification).toBe('other');
  });
});

describe('file typing is by extension, never by content', () => {
  it('maps the extensions a map is asked about', () => {
    expect(fileTypeForExtension('.pdf')).toBe('pdf');
    expect(fileTypeForExtension('.docx')).toBe('document');
    expect(fileTypeForExtension('.xlsx')).toBe('spreadsheet');
    expect(fileTypeForExtension('.pptx')).toBe('presentation');
    expect(fileTypeForExtension('.jpg')).toBe('image');
    expect(fileTypeForExtension('.mp3')).toBe('audio');
    expect(fileTypeForExtension('.mp4')).toBe('video');
    expect(fileTypeForExtension('.zip')).toBe('archive');
    expect(fileTypeForExtension('.so')).toBe('executable');
    expect(fileTypeForExtension('.ts')).toBe('code');
    expect(fileTypeForExtension('.log')).toBe('log');
    expect(fileTypeForExtension('.unknown-ext')).toBe('other');
  });

  it('is case-insensitive, because filesystems are not always', () => {
    expect(fileTypeForExtension('.PDF')).toBe('pdf');
    expect(fileTypeForExtension('.JPG')).toBe('image');
  });
});