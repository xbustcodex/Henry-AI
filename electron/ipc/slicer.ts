/**
 * Slicer integration — P1 engine plumbing (slicer plan).
 *
 * Wraps a CuraEngine binary (a proven open-source slicing engine) as a
 * subprocess: STL/3MF/OBJ in, printer-ready G-code out, plus a time + filament
 * estimate parsed from the G-code header. The engine is AGPL — it is invoked
 * arms-length as a separate process, never linked into Henry.
 *
 * Configuration (settings table, set in Settings or via the Slice panel):
 *   - slicer_engine_path      absolute path to the CuraEngine binary
 *   - slicer_definitions_dir  Cura "definitions" folder (for CURA_ENGINE_SEARCH_PATH)
 *   - slicer_printer_def      a printer .def.json inside that folder
 *
 * Channels: `slicer:status`, `slicer:slice`. All local; nothing leaves the Mac.
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

export interface SliceEstimate {
  timeSeconds?: number;
  filamentMm?: number;
  filamentGrams?: number;
}

const MODEL_EXT = new Set(['.stl', '.3mf', '.obj']);

function getSetting(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
  return (row?.value ?? '').trim();
}

function resolveConfig(db: Database.Database) {
  return {
    enginePath: getSetting(db, 'slicer_engine_path'),
    definitionsDir: getSetting(db, 'slicer_definitions_dir'),
    printerDef: getSetting(db, 'slicer_printer_def'),
  };
}

/** Parse Cura's G-code header comments for the time + filament estimate. */
export function parseEstimate(gcode: string): SliceEstimate {
  const head = (typeof gcode === 'string' ? gcode : String(gcode ?? '')).slice(0, 8000);
  const est: SliceEstimate = {};
  const time = head.match(/;TIME:\s*([\d.]+)/i);
  if (time) est.timeSeconds = Math.round(Number(time[1]));
  // Cura: ";Filament used: 1.23456m" (metres, may be multiple comma-separated for multi-extruder)
  const fil = head.match(/;Filament used:\s*([\d.,\s]+)m/i);
  if (fil) {
    const metres = fil[1].split(',').reduce((s, v) => s + (Number(v.trim()) || 0), 0);
    est.filamentMm = Math.round(metres * 1000);
    // Rough grams: 1.75mm PLA ≈ 2.98 g/m (area × density 1.24). Good enough for a heads-up.
    est.filamentGrams = Math.round(metres * 2.98);
  }
  return est;
}

export function registerSlicerHandlers(db: Database.Database): void {
  // Read a sliced G-code file back (for the layer preview). Capped so a huge
  // file can't blow up the renderer.
  ipcMain.handle('slicer:readGcode', async (_e, payload: { gcodePath: string }) => {
    try {
      const p = String(payload?.gcodePath ?? '').trim();
      if (!p || !fs.existsSync(p)) throw new Error('G-code not found.');
      if (path.extname(p).toLowerCase() !== '.gcode') throw new Error('Not a .gcode file.');
      const MAX = 24 * 1024 * 1024; // 24 MB
      const stat = fs.statSync(p);
      if (stat.size > MAX) throw new Error('G-code too large to preview (over 24 MB).');
      return { ok: true, result: { text: fs.readFileSync(p, 'utf8') } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Is the engine configured and present?
  ipcMain.handle('slicer:status', async () => {
    try {
      const cfg = resolveConfig(db);
      const missing: string[] = [];
      if (!cfg.enginePath) missing.push('engine path');
      else if (!fs.existsSync(cfg.enginePath)) missing.push('engine binary (path set but file not found)');
      if (!cfg.definitionsDir) missing.push('definitions folder');
      else if (!fs.existsSync(cfg.definitionsDir)) missing.push('definitions folder (path set but not found)');
      if (!cfg.printerDef) missing.push('printer definition');

      let version = '';
      if (cfg.enginePath && fs.existsSync(cfg.enginePath)) {
        try {
          const { stdout, stderr } = await execFileAsync(cfg.enginePath, ['--version'], { timeout: 5000 });
          version = (stdout || stderr || '').split('\n')[0].trim().slice(0, 120);
        } catch {
          /* some builds print version without a clean exit — non-fatal */
        }
      }
      return { ok: true, result: { available: missing.length === 0, missing, version, ...cfg } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Slice a model → G-code + estimate.
  ipcMain.handle(
    'slicer:slice',
    async (_e, payload: { modelPath: string; settings?: Record<string, string | number>; outPath?: string; printerDef?: string }) => {
      try {
        const cfg = resolveConfig(db);
        if (!cfg.enginePath || !fs.existsSync(cfg.enginePath)) {
          throw new Error('Slicer engine not set up. Set the CuraEngine path in the Slice panel.');
        }
        // A profile may override the printer definition; otherwise use the global one.
        const printerDef = (payload?.printerDef && String(payload.printerDef).trim()) || cfg.printerDef;
        if (!printerDef) throw new Error('No printer definition configured.');

        const modelPath = String(payload?.modelPath ?? '').trim();
        if (!modelPath || !fs.existsSync(modelPath)) throw new Error(`Model not found: ${modelPath || '(none)'}`);
        if (!MODEL_EXT.has(path.extname(modelPath).toLowerCase())) {
          throw new Error('Model must be an .stl, .3mf, or .obj file.');
        }

        const outPath =
          (payload?.outPath && String(payload.outPath).trim()) ||
          path.join(os.tmpdir(), `henry-slice-${Date.now()}.gcode`);

        // CuraEngine: slice -j <printer.def.json> -l <model> -o <out> -s key=value …
        const args = ['slice', '-v', '-j', printerDef, '-l', modelPath, '-o', outPath];
        for (const [k, v] of Object.entries(payload?.settings ?? {})) {
          args.push('-s', `${k}=${v}`);
        }

        const env = { ...process.env, CURA_ENGINE_SEARCH_PATH: cfg.definitionsDir || path.dirname(cfg.printerDef) };
        await execFileAsync(cfg.enginePath, args, { timeout: 5 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, env });

        if (!fs.existsSync(outPath)) throw new Error('Slicing finished but no G-code was produced.');
        const gcode = fs.readFileSync(outPath, 'utf8');
        const estimate = parseEstimate(gcode);
        return { ok: true, result: { gcodePath: outPath, estimate, bytes: Buffer.byteLength(gcode) } };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    },
  );
}
