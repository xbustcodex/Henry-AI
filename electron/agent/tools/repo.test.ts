/**
 * Safety tests for Build Mode repo tools (Phase 4). These assert the sandbox
 * actually refuses the dangerous cases — the whole point of letting Henry edit
 * files is that it CAN'T edit the wrong ones. Pure: no git repo needed, because
 * every case here is rejected before any write.
 */

import { describe, it, expect } from 'vitest';
import { repoTools } from './repo';

const tools = repoTools();
const edit = tools.find((t) => t.name === 'repo_edit')!;
const read = tools.find((t) => t.name === 'repo_read')!;
const ctx = { db: {} as any, getWindow: () => null };

describe('repo tools — sandbox', () => {
  it('exposes exactly the read-only + confirm-gated edit surface', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(['repo_edit', 'repo_read', 'repo_status']);
    expect(read.safetyLevel).toBe('silent');
    expect(tools.find((t) => t.name === 'repo_status')!.safetyLevel).toBe('silent');
    expect(edit.safetyLevel).toBe('confirm'); // every write routes through the Approval Queue
  });

  it('refuses to edit outside the home directory', async () => {
    const r = await edit.execute({ path: '/etc/hosts', content: 'x' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/outside your home/i);
  });

  it('refuses to read protected key directories (.ssh)', async () => {
    const r = await read.execute({ path: '~/.ssh/id_rsa' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/protected directory|secrets/i);
  });

  it('refuses to edit the credentials key store (.keys)', async () => {
    const r = await edit.execute({ path: '~/.keys/henry/notarize.env', content: 'x' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/protected directory|secrets/i);
  });

  it('refuses files that look like secrets (.env, *.pem)', async () => {
    const a = await edit.execute({ path: '~/code/app/.env', content: 'x' }, ctx);
    const b = await edit.execute({ path: '~/code/app/server.pem', content: 'x' }, ctx);
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/secrets|credentials/i);
    expect(b.ok).toBe(false);
  });

  it('requires both find and replace (or content) for an edit', async () => {
    // A path inside home but not a git repo, with no content/find — rejected on inputs
    // before touching git. (Uses a clearly-nonexistent project path.)
    const r = await edit.execute({ path: '~/definitely-not-a-real-henry-project-xyz/file.ts' }, ctx);
    expect(r.ok).toBe(false);
  });
});
