/**
 * Pure G-code → layer-polyline parser (slicer plan, P5). Extracted so it can be
 * unit-tested without React. Parses G0/G1 moves into per-layer extrusion
 * segments (`;LAYER:` markers when present, otherwise Z-based), excluding travel
 * moves. Designed to never throw on malformed/partial/huge input.
 */

export interface Seg { x1: number; y1: number; x2: number; y2: number; }

export function parseGcode(text: string): Seg[][] {
  const src = typeof text === 'string' ? text : String(text ?? '');
  const layers: Seg[][] = [];
  let cur: Seg[] = [];
  let x = 0, y = 0, z = 0, e = 0;
  let absXYZ = true, absE = true, started = false, lastZ = 0;
  const hasMarkers = /;LAYER:/.test(src);

  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === ';') {
      if (hasMarkers && /^;LAYER:/.test(line)) {
        if (started) { layers.push(cur); cur = []; }
        started = true;
      }
      continue;
    }
    const semi = line.indexOf(';');
    const parts = (semi >= 0 ? line.slice(0, semi) : line).trim().split(/\s+/);
    const cmd = parts[0]?.toUpperCase();

    if (cmd === 'G90') absXYZ = true;
    else if (cmd === 'G91') absXYZ = false;
    else if (cmd === 'M82') absE = true;
    else if (cmd === 'M83') absE = false;
    else if (cmd === 'G92') {
      for (const p of parts.slice(1)) {
        const a = p[0]?.toUpperCase(); const v = parseFloat(p.slice(1));
        if (Number.isNaN(v)) continue;
        if (a === 'E') e = v; else if (a === 'X') x = v; else if (a === 'Y') y = v; else if (a === 'Z') z = v;
      }
    } else if (cmd === 'G0' || cmd === 'G1') {
      let nx = x, ny = y, nz = z, ne = e, eSpecified = false, deltaE = 0;
      for (const p of parts.slice(1)) {
        const a = p[0]?.toUpperCase(); const v = parseFloat(p.slice(1));
        if (Number.isNaN(v)) continue;
        if (a === 'X') nx = absXYZ ? v : x + v;
        else if (a === 'Y') ny = absXYZ ? v : y + v;
        else if (a === 'Z') nz = absXYZ ? v : z + v;
        else if (a === 'E') { eSpecified = true; if (absE) { deltaE = v - e; ne = v; } else { deltaE = v; ne = e + v; } }
      }
      if (!hasMarkers && nz > lastZ + 0.0001) {
        if (started) { layers.push(cur); cur = []; }
        started = true; lastZ = nz;
      }
      if (eSpecified && deltaE > 0.0001 && (nx !== x || ny !== y)) {
        cur.push({ x1: x, y1: y, x2: nx, y2: ny });
        started = true;
      }
      x = nx; y = ny; z = nz; e = ne;
    }
  }
  if (cur.length) layers.push(cur);
  return layers.filter((l) => l.length > 0);
}
