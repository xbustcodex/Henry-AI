import { describe, it, expect, vi } from 'vitest';

// slicer.ts imports `ipcMain` from electron at module load; we only test the
// pure `parseEstimate`, so stub electron so the import resolves in plain Node.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { parseEstimate } from './slicer';

describe('parseEstimate', () => {
  it('parses Cura time + filament headers', () => {
    const g = ';FLAVOR:Marlin\n;TIME:5400\n;Filament used: 3.14159m\n;LAYER_COUNT:120\nG28\n';
    const est = parseEstimate(g);
    expect(est.timeSeconds).toBe(5400);
    expect(est.filamentMm).toBe(3142);
    expect(est.filamentGrams).toBe(9);
  });

  it('sums multi-extruder filament', () => {
    const est = parseEstimate(';TIME:7325\n;Filament used: 2.5, 1.0m\n');
    expect(est.timeSeconds).toBe(7325);
    expect(est.filamentMm).toBe(3500);
  });

  it('returns an empty estimate when the headers are absent', () => {
    expect(parseEstimate('G28\nG1 X0 Y0\n')).toEqual({});
  });

  const garbage: unknown[] = ['', '   ', ';TIME:abc', ';Filament used: x,y,zm', ';Filament used: m', null, undefined, 42, '\x00\x01'];
  it.each(garbage.map((g, i) => [i, g]))('never throws on garbage input #%s', (_i, g) => {
    expect(() => parseEstimate(g as string)).not.toThrow();
  });
});
