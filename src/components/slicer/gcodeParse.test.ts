import { describe, it, expect } from 'vitest';
import { parseGcode } from './gcodeParse';

describe('parseGcode', () => {
  it('splits by ;LAYER: markers and counts extrusion segments', () => {
    const g =
      ';LAYER:0\nG1 X0 Y0 E0\nG1 X10 Y0 E0.5\nG1 X10 Y10 E1.0\nG0 X0 Y0\n' +
      ';LAYER:1\nG1 X0 Y0 E1.0\nG1 X10 Y0 E1.5\n';
    const layers = parseGcode(g);
    expect(layers.length).toBe(2);
    expect(layers[0].length).toBe(2); // two extrusions; the G0 travel is excluded
    expect(layers[1].length).toBe(1);
  });

  it('falls back to Z-based layering and excludes travel moves', () => {
    const g = 'G1 Z0.2\nG1 X0 Y0 E0\nG1 X5 Y0 E0.3\nG0 X5 Y5\nG1 Z0.4\nG1 X5 Y5 E0.3\nG1 X0 Y5 E0.6\n';
    const layers = parseGcode(g);
    expect(layers.length).toBe(2);
    expect(layers[0].length).toBe(1); // only the extruding move, not the G0
  });

  it('honours relative extrusion (M83)', () => {
    const g = ';LAYER:0\nM83\nG1 X0 Y0\nG1 X5 Y0 E0.2\nG1 X5 Y5 E0.2\n';
    const layers = parseGcode(g);
    expect(layers.length).toBe(1);
    expect(layers[0].length).toBe(2);
  });

  // The crown jewel: it must never throw, whatever it's fed.
  const garbage: unknown[] = [
    '', '   ', '\n\n', ';only comments', 'G1', 'G1 X Y E', 'G1 Xabc Ynan',
    'G1 X1e999 Y-1e999 E5', 'binary\x00\x01', 'G92 E', ';LAYER:\nG1', '🔥\nG1 X1 Y1 E1',
    'G1 X1 Y1 E0.1\n'.repeat(20000), null, undefined, 42, {},
  ];
  it.each(garbage.map((g, i) => [i, g]))('never throws on garbage input #%s', (_i, g) => {
    expect(() => parseGcode(g as string)).not.toThrow();
    expect(Array.isArray(parseGcode(g as string))).toBe(true);
  });
});
