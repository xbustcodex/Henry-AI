/**
 * Discovery → normalisation seam.
 *
 * This is the hop the installed build proved was already correct (108 Zen
 * models, group `opencode-zen`, `isZen: true`) EXCEPT for one field: Zen ids
 * carry no `provider/` prefix, so the slash split produced `provider:
 * 'unknown'` for every one of them while `isZen` stayed true.
 *
 * The previous acceptance pass counted Zen models from a discovery endpoint and
 * called it proof. A count proves nothing about the next hop. Every test here
 * asserts that a specific model SURVIVES with a usable identity — that is what
 * a picker can act on.
 */
import { describe, it, expect } from 'vitest';
import { parseModelList } from './opencode';
import { opencodeProviderIdForModel, OPENCODE_ZEN_PROVIDER_ID, OPENCODE_PROVIDER_ID } from '../providers/classification';

/**
 * Real `opencode models` table shape, including the three observed Zen ids from
 * the installed Windows build and a slash-namespaced openrouter entry.
 */
const REAL_TABLE = [
  'opencode-zen (108)',
  '| model                          | context |  cost  | reasoning | tools |',
  '| deepseek-v4-flash-free         |    1M   |   $0   | no        |  yes |',
  '| hy3-free                       |    1M   |   $0   | no        |  yes |',
  '| ~hy3-preview-free              |    1M   |   $0   | no        |  yes |',
  '| anthropic/claude-fable-latest  |    1M   |  $3/M  | low,high  |  yes |',
  '',
  'openrouter (564)',
  '| openrouter/qwen3-235b-a22b     |  128K   |  $0.2  | low       |  yes |',
  '',
].join('\n');

const models = parseModelList(REAL_TABLE);
const byId = (id: string) => models.find((m) => m.id === id);

describe('a discovered Zen model survives normalisation', () => {
  it('keeps the exact id the CLI printed, with no table chrome', () => {
    // The id is what gets sent to the bridge as `--model`. Any decoration here
    // is an unselectable model.
    expect(byId('hy3-free')?.id).toBe('hy3-free');
    expect(byId('hy3-free')?.id).not.toMatch(/[|│]/);
  });

  it('strips the "~" highlighted marker from the id', () => {
    expect(byId('hy3-preview-free')).toBeDefined();
  });

  it('carries the opencode-zen group through untouched', () => {
    expect(byId('hy3-free')?.group).toBe('opencode-zen');
    expect(byId('hy3-free')?.isZen).toBe(true);
  });

  /**
   * THE DEFECT. Every consumer keyed off `provider`; Zen ids have no slash, so
   * this was the literal string 'unknown' for all 108 of them, and any grouping
   * or filtering on provider put them in a bucket nothing else was in.
   */
  it('never leaves a discovered Zen model with provider "unknown"', () => {
    for (const id of ['deepseek-v4-flash-free', 'hy3-free', 'hy3-preview-free']) {
      expect(byId(id)?.provider, `${id} lost its provider`).toBe('opencode-zen');
      expect(byId(id)?.provider).not.toBe('unknown');
    }
  });

  it('still reads the provider off a slash-namespaced id', () => {
    // openrouter entries do carry a prefix and must keep it, or a real
    // third-party model would be relabelled as Henry's own Zen service.
    expect(byId('openrouter/qwen3-235b-a22b')?.provider).toBe('openrouter');
    expect(byId('openrouter/qwen3-235b-a22b')?.isZen).toBe(false);
    expect(byId('openrouter/qwen3-235b-a22b')?.group).toBe('openrouter');
  });

  it('splits name off a slash-namespaced id', () => {
    expect(byId('openrouter/qwen3-235b-a22b')?.name).toBe('qwen3-235b-a22b');
  });
});

describe('a discovered model resolves to the provider it belongs to', () => {
  it('maps a Zen model to opencode-zen, not to opencode', () => {
    // This is the seam the picker calls. Returning plain `opencode` here is what
    // made 108 selectable-looking models all persist as one provider.
    expect(opencodeProviderIdForModel(byId('hy3-free')!)).toBe(OPENCODE_ZEN_PROVIDER_ID);
  });

  it('maps a non-Zen model to opencode', () => {
    expect(opencodeProviderIdForModel(byId('openrouter/qwen3-235b-a22b')!)).toBe(OPENCODE_PROVIDER_ID);
  });

  it('trusts the group even when isZen disagrees, and vice versa', () => {
    // isZen and group are produced together, but a mismatch should still land
    // on Zen rather than silently reverting to plain opencode.
    expect(opencodeProviderIdForModel({ isZen: false, group: 'opencode-zen' })).toBe(OPENCODE_ZEN_PROVIDER_ID);
    expect(opencodeProviderIdForModel({ isZen: true, group: 'openrouter' })).toBe(OPENCODE_ZEN_PROVIDER_ID);
  });

  it('does not mistake a provider that merely contains "zen" as Zen', () => {
    // 'zenith' is not the Zen service. Guarding here stops a future provider
    // name from being captured by a substring test.
    expect(opencodeProviderIdForModel({ isZen: false, group: 'zenith' })).toBe(OPENCODE_PROVIDER_ID);
  });
});

describe('list ordering keeps Zen findable', () => {
  it('puts Zen ahead of the bulk catalogue', () => {
    // Mirrors the sort in listOpencodeModels: Zen first, then free, then
    // alphabetical. Asserted here so the ordering contract has a home even
    // though sorting itself lives in the shelling-out layer.
    const sorted = [...models].sort((a, b) => {
      if (a.isZen !== b.isZen) return a.isZen ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
    expect(sorted[0].isZen).toBe(true);
    expect(sorted.filter((m) => m.isZen)).toHaveLength(4);
  });
});