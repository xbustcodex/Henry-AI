/**
 * Maker Studio — generalized data layer for ALL maker machine types.
 *
 * Covers: 3D printers, laser cutters/etchers, CNC mills/routers,
 * embroidery machines, vinyl cutters, sublimation, sewing,
 * pottery/kilns, leatherworking, electronics — anything makers do.
 *
 * Schema:
 *   machines          — every machine you own
 *   materials         — every consumable (filament, wood, vinyl, thread, etc.)
 *   production_runs   — every job run on a machine
 *   waste_log         — every failure/cutoff/scrap event
 *   maintenance_log   — every service/calibration/repair
 *
 * Persistence: SQLite (durable, queryable by Henry's AI memory).
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';

let db: Database.Database;

export function registerMakerStudioHandlers(database: Database.Database) {
  db = database;

  // ── Schema ─────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      machine_type TEXT NOT NULL,
      brand TEXT,
      model TEXT,
      serial_number TEXT,
      connection_type TEXT DEFAULT 'manual',
      connection_address TEXT,
      status TEXT NOT NULL DEFAULT 'idle'
        CHECK(status IN ('idle','running','maintenance','broken','retired')),
      hourly_rate REAL DEFAULT 0,
      power_watts INTEGER DEFAULT 0,
      purchase_date TEXT,
      purchase_cost REAL,
      total_runtime_hours REAL DEFAULT 0,
      last_maintenance_at TEXT,
      next_maintenance_at TEXT,
      photo_path TEXT,
      notes TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_machines_type ON machines(machine_type, active);

    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      brand TEXT,
      color TEXT,
      color_hex TEXT,
      specs TEXT,
      unit TEXT NOT NULL DEFAULT 'piece',
      quantity_total REAL DEFAULT 0,
      quantity_unit_cost REAL DEFAULT 0,
      reorder_threshold REAL DEFAULT 0,
      supplier TEXT,
      supplier_url TEXT,
      location TEXT,
      purchase_date TEXT,
      photo_path TEXT,
      notes TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_materials_category ON materials(category, active);
    CREATE INDEX IF NOT EXISTS idx_materials_color ON materials(color_hex);

    CREATE TABLE IF NOT EXISTS production_runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      machine_id TEXT,
      project TEXT,
      customer_id TEXT,
      materials_used TEXT DEFAULT '[]',
      started_at TEXT,
      completed_at TEXT,
      duration_minutes REAL,
      success INTEGER NOT NULL DEFAULT 1,
      failure_reason TEXT,
      material_cost REAL DEFAULT 0,
      machine_cost REAL DEFAULT 0,
      electricity_cost REAL DEFAULT 0,
      labor_cost REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      charged_amount REAL DEFAULT 0,
      profit REAL DEFAULT 0,
      source_file_path TEXT,
      output_photo_path TEXT,
      payload TEXT DEFAULT '{}',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_machine ON production_runs(machine_id, completed_at);
    CREATE INDEX IF NOT EXISTS idx_runs_customer ON production_runs(customer_id);
    CREATE INDEX IF NOT EXISTS idx_runs_project ON production_runs(project);

    CREATE TABLE IF NOT EXISTS waste_log (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      material_id TEXT,
      material_description TEXT,
      quantity REAL DEFAULT 0,
      unit TEXT,
      reason TEXT NOT NULL DEFAULT 'other',
      disposal_route TEXT DEFAULT 'pending',
      estimated_cost REAL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES production_runs(id) ON DELETE SET NULL,
      FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_waste_run ON waste_log(run_id);
    CREATE INDEX IF NOT EXISTS idx_waste_material ON waste_log(material_id);

    CREATE TABLE IF NOT EXISTS maintenance_log (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'inspection',
      description TEXT NOT NULL,
      cost REAL DEFAULT 0,
      duration_minutes REAL,
      parts_used TEXT,
      next_due_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_maint_machine ON maintenance_log(machine_id, created_at);
  `);

  // ── Machines ────────────────────────────────────────────────────────────
  ipcMain.handle('maker:machines:list', (_e, opts?: { type?: string; activeOnly?: boolean }) => {
    try {
      const where: string[] = [];
      const args: unknown[] = [];
      if (opts?.activeOnly !== false) where.push('active=1');
      if (opts?.type) { where.push('machine_type=?'); args.push(opts.type); }
      const sql = `SELECT * FROM machines ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name`;
      return db.prepare(sql).all(...args);
    } catch { return []; }
  });

  ipcMain.handle('maker:machines:save', (_e, m: Record<string, unknown>) => {
    try {
      const now = new Date().toISOString();
      const id = String(m.id || crypto.randomUUID());
      db.prepare(`INSERT INTO machines
        (id, name, machine_type, brand, model, serial_number, connection_type,
         connection_address, status, hourly_rate, power_watts, purchase_date,
         purchase_cost, total_runtime_hours, last_maintenance_at, next_maintenance_at,
         photo_path, notes, active, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, machine_type=excluded.machine_type, brand=excluded.brand,
          model=excluded.model, serial_number=excluded.serial_number,
          connection_type=excluded.connection_type, connection_address=excluded.connection_address,
          status=excluded.status, hourly_rate=excluded.hourly_rate, power_watts=excluded.power_watts,
          purchase_date=excluded.purchase_date, purchase_cost=excluded.purchase_cost,
          total_runtime_hours=excluded.total_runtime_hours,
          last_maintenance_at=excluded.last_maintenance_at,
          next_maintenance_at=excluded.next_maintenance_at, photo_path=excluded.photo_path,
          notes=excluded.notes, active=excluded.active, updated_at=excluded.updated_at`)
        .run(id, m.name, m.machine_type, m.brand||null, m.model||null, m.serial_number||null,
          m.connection_type||'manual', m.connection_address||null, m.status||'idle',
          Number(m.hourly_rate)||0, Number(m.power_watts)||0, m.purchase_date||null,
          m.purchase_cost==null?null:Number(m.purchase_cost), Number(m.total_runtime_hours)||0,
          m.last_maintenance_at||null, m.next_maintenance_at||null, m.photo_path||null,
          m.notes||null, m.active===false?0:1, m.created_at||now, now);
      return { ok: true, id };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle('maker:machines:delete', (_e, id: string) => {
    try { db.prepare('DELETE FROM machines WHERE id=?').run(id); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  // ── Materials ───────────────────────────────────────────────────────────
  ipcMain.handle('maker:materials:list', (_e, opts?: { category?: string; lowStock?: boolean; activeOnly?: boolean }) => {
    try {
      const where: string[] = [];
      const args: unknown[] = [];
      if (opts?.activeOnly !== false) where.push('active=1');
      if (opts?.category) { where.push('category=?'); args.push(opts.category); }
      if (opts?.lowStock) where.push('reorder_threshold > 0 AND quantity_total <= reorder_threshold');
      const sql = `SELECT * FROM materials ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY category, name`;
      return db.prepare(sql).all(...args);
    } catch { return []; }
  });

  ipcMain.handle('maker:materials:save', (_e, m: Record<string, unknown>) => {
    try {
      const now = new Date().toISOString();
      const id = String(m.id || crypto.randomUUID());
      db.prepare(`INSERT INTO materials
        (id, name, category, brand, color, color_hex, specs, unit, quantity_total,
         quantity_unit_cost, reorder_threshold, supplier, supplier_url, location,
         purchase_date, photo_path, notes, active, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, category=excluded.category, brand=excluded.brand,
          color=excluded.color, color_hex=excluded.color_hex, specs=excluded.specs,
          unit=excluded.unit, quantity_total=excluded.quantity_total,
          quantity_unit_cost=excluded.quantity_unit_cost,
          reorder_threshold=excluded.reorder_threshold, supplier=excluded.supplier,
          supplier_url=excluded.supplier_url, location=excluded.location,
          purchase_date=excluded.purchase_date, photo_path=excluded.photo_path,
          notes=excluded.notes, active=excluded.active, updated_at=excluded.updated_at`)
        .run(id, m.name, m.category, m.brand||null, m.color||null, m.color_hex||null,
          m.specs||null, m.unit||'piece', Number(m.quantity_total)||0,
          Number(m.quantity_unit_cost)||0, Number(m.reorder_threshold)||0,
          m.supplier||null, m.supplier_url||null, m.location||null, m.purchase_date||null,
          m.photo_path||null, m.notes||null, m.active===false?0:1, m.created_at||now, now);
      return { ok: true, id };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle('maker:materials:delete', (_e, id: string) => {
    try { db.prepare('DELETE FROM materials WHERE id=?').run(id); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  // Color library — distinct colors with stock summary, for "what colors do I have" queries
  ipcMain.handle('maker:materials:colors', () => {
    try {
      return db.prepare(`SELECT color, color_hex, category,
        COUNT(*) as count, SUM(quantity_total) as total_stock
        FROM materials WHERE active=1 AND color IS NOT NULL AND color != ''
        GROUP BY color, color_hex, category ORDER BY category, color`).all();
    } catch { return []; }
  });

  // ── Production Runs ─────────────────────────────────────────────────────
  ipcMain.handle('maker:runs:list', (_e, opts?: { machineId?: string; project?: string; limit?: number }) => {
    try {
      const where: string[] = [];
      const args: unknown[] = [];
      if (opts?.machineId) { where.push('machine_id=?'); args.push(opts.machineId); }
      if (opts?.project) { where.push('project=?'); args.push(opts.project); }
      const limit = Number(opts?.limit) || 200;
      const sql = `SELECT * FROM production_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY COALESCE(completed_at, started_at, created_at) DESC LIMIT ?`;
      args.push(limit);
      return db.prepare(sql).all(...args);
    } catch { return []; }
  });

  ipcMain.handle('maker:runs:save', (_e, r: Record<string, unknown>) => {
    try {
      const now = new Date().toISOString();
      const id = String(r.id || crypto.randomUUID());
      const matCost = Number(r.material_cost)||0;
      const machCost = Number(r.machine_cost)||0;
      const elecCost = Number(r.electricity_cost)||0;
      const labCost = Number(r.labor_cost)||0;
      const totalCost = matCost + machCost + elecCost + labCost;
      const charged = Number(r.charged_amount)||0;
      const profit = charged - totalCost;
      db.prepare(`INSERT INTO production_runs
        (id, name, machine_id, project, customer_id, materials_used, started_at,
         completed_at, duration_minutes, success, failure_reason, material_cost,
         machine_cost, electricity_cost, labor_cost, total_cost, charged_amount,
         profit, source_file_path, output_photo_path, payload, notes,
         created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, machine_id=excluded.machine_id, project=excluded.project,
          customer_id=excluded.customer_id, materials_used=excluded.materials_used,
          started_at=excluded.started_at, completed_at=excluded.completed_at,
          duration_minutes=excluded.duration_minutes, success=excluded.success,
          failure_reason=excluded.failure_reason, material_cost=excluded.material_cost,
          machine_cost=excluded.machine_cost, electricity_cost=excluded.electricity_cost,
          labor_cost=excluded.labor_cost, total_cost=excluded.total_cost,
          charged_amount=excluded.charged_amount, profit=excluded.profit,
          source_file_path=excluded.source_file_path,
          output_photo_path=excluded.output_photo_path, payload=excluded.payload,
          notes=excluded.notes, updated_at=excluded.updated_at`)
        .run(id, r.name, r.machine_id||null, r.project||null, r.customer_id||null,
          typeof r.materials_used==='string' ? r.materials_used : JSON.stringify(r.materials_used||[]),
          r.started_at||null, r.completed_at||null, r.duration_minutes==null?null:Number(r.duration_minutes),
          r.success===false?0:1, r.failure_reason||null, matCost, machCost, elecCost, labCost,
          totalCost, charged, profit, r.source_file_path||null, r.output_photo_path||null,
          typeof r.payload==='string' ? r.payload : JSON.stringify(r.payload||{}),
          r.notes||null, r.created_at||now, now);
      return { ok: true, id, total_cost: totalCost, profit };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle('maker:runs:delete', (_e, id: string) => {
    try { db.prepare('DELETE FROM production_runs WHERE id=?').run(id); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  // Profit by machine / by month — fast Henry-AI lookups
  ipcMain.handle('maker:runs:summary', (_e, opts?: { month?: string; machineId?: string }) => {
    try {
      const where: string[] = ['success=1'];
      const args: unknown[] = [];
      if (opts?.month) { where.push("substr(completed_at,1,7)=?"); args.push(opts.month); }
      if (opts?.machineId) { where.push('machine_id=?'); args.push(opts.machineId); }
      const sql = `SELECT COUNT(*) as runs, SUM(total_cost) as total_cost,
        SUM(charged_amount) as revenue, SUM(profit) as profit,
        SUM(duration_minutes) as total_minutes
        FROM production_runs WHERE ${where.join(' AND ')}`;
      return db.prepare(sql).get(...args);
    } catch { return { runs:0, total_cost:0, revenue:0, profit:0, total_minutes:0 }; }
  });

  // ── Waste Log ───────────────────────────────────────────────────────────
  ipcMain.handle('maker:waste:list', (_e, limit=200) => {
    try { return db.prepare('SELECT * FROM waste_log ORDER BY created_at DESC LIMIT ?').all(limit); }
    catch { return []; }
  });

  ipcMain.handle('maker:waste:save', (_e, w: Record<string, unknown>) => {
    try {
      const now = new Date().toISOString();
      const id = String(w.id || crypto.randomUUID());
      db.prepare(`INSERT INTO waste_log
        (id, run_id, material_id, material_description, quantity, unit, reason,
         disposal_route, estimated_cost, notes, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          run_id=excluded.run_id, material_id=excluded.material_id,
          material_description=excluded.material_description, quantity=excluded.quantity,
          unit=excluded.unit, reason=excluded.reason, disposal_route=excluded.disposal_route,
          estimated_cost=excluded.estimated_cost, notes=excluded.notes`)
        .run(id, w.run_id||null, w.material_id||null, w.material_description||null,
          Number(w.quantity)||0, w.unit||null, w.reason||'other',
          w.disposal_route||'pending', Number(w.estimated_cost)||0, w.notes||null,
          w.created_at||now);
      return { ok: true, id };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle('maker:waste:delete', (_e, id: string) => {
    try { db.prepare('DELETE FROM waste_log WHERE id=?').run(id); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  // Henry-AI helper: failure pattern detection (e.g., "you've had 4 layer-shift failures this month")
  ipcMain.handle('maker:waste:patterns', (_e, opts?: { sinceDays?: number }) => {
    try {
      const days = Number(opts?.sinceDays) || 30;
      const since = new Date(Date.now() - days*86400000).toISOString();
      return db.prepare(`SELECT reason, COUNT(*) as count, SUM(quantity) as total_qty,
        SUM(estimated_cost) as total_cost
        FROM waste_log WHERE created_at >= ?
        GROUP BY reason ORDER BY count DESC`).all(since);
    } catch { return []; }
  });

  // ── Maintenance Log ─────────────────────────────────────────────────────
  ipcMain.handle('maker:maintenance:list', (_e, machineId?: string) => {
    try {
      if (machineId) {
        return db.prepare('SELECT * FROM maintenance_log WHERE machine_id=? ORDER BY created_at DESC').all(machineId);
      }
      return db.prepare('SELECT * FROM maintenance_log ORDER BY created_at DESC LIMIT 200').all();
    } catch { return []; }
  });

  ipcMain.handle('maker:maintenance:save', (_e, m: Record<string, unknown>) => {
    try {
      const now = new Date().toISOString();
      const id = String(m.id || crypto.randomUUID());
      db.prepare(`INSERT INTO maintenance_log
        (id, machine_id, type, description, cost, duration_minutes, parts_used,
         next_due_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, m.machine_id, m.type||'inspection', m.description,
          Number(m.cost)||0, m.duration_minutes==null?null:Number(m.duration_minutes),
          m.parts_used||null, m.next_due_at||null, m.created_at||now);
      // Update machine's last_maintenance_at
      if (m.machine_id) {
        db.prepare('UPDATE machines SET last_maintenance_at=?, next_maintenance_at=?, updated_at=? WHERE id=?')
          .run(now, m.next_due_at||null, now, m.machine_id);
      }
      return { ok: true, id };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle('maker:maintenance:delete', (_e, id: string) => {
    try { db.prepare('DELETE FROM maintenance_log WHERE id=?').run(id); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  // ── One-shot migration: localStorage → SQLite ───────────────────────────
  // Called by renderer with the old localStorage payload. Idempotent.
  ipcMain.handle('maker:migrate:from-localStorage', (_e, data: {
    spools?: unknown[]; jobs?: unknown[]; bom?: unknown[];
  }) => {
    try {
      const migrated = { spools: 0, jobs: 0, bom: 0 };
      const now = new Date().toISOString();

      // Spools → materials (category=filament)
      if (Array.isArray(data?.spools)) {
        for (const sRaw of data.spools) {
          const s = sRaw as Record<string, unknown>;
          if (!s?.id) continue;
          const exists = db.prepare('SELECT id FROM materials WHERE id=?').get(String(s.id));
          if (exists) continue;
          const remainingPct = Number(s.remainingPercent) || 100;
          const totalGrams = Number(s.weightGrams) || 1000;
          db.prepare(`INSERT INTO materials
            (id, name, category, brand, color, specs, unit, quantity_total,
             notes, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(String(s.id),
              `${s.brand || 'Unknown'} ${s.material || 'PLA'} ${s.color || ''}`.trim(),
              'filament', s.brand||null, s.color||null,
              `${s.material||'PLA'} ${s.weightGrams||1000}g spool`,
              'g', Math.round(totalGrams * remainingPct / 100),
              s.notes||null, s.purchaseDate||now, now);
          migrated.spools++;
        }
      }

      // Jobs → production_runs (machine_type=3d-printer, machine_id=null since we don't know)
      if (Array.isArray(data?.jobs)) {
        for (const jRaw of data.jobs) {
          const j = jRaw as Record<string, unknown>;
          if (!j?.id) continue;
          const exists = db.prepare('SELECT id FROM production_runs WHERE id=?').get(String(j.id));
          if (exists) continue;
          const payload = JSON.stringify({
            material: j.material, layerHeight: j.layerHeight,
            infillPercent: j.infillPercent, color: j.color,
            filamentSpoolId: j.filamentSpoolId,
          });
          db.prepare(`INSERT INTO production_runs
            (id, name, project, started_at, completed_at, duration_minutes,
             success, payload, notes, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(String(j.id), j.name||'Untitled', null, j.date||null, j.date||null,
              j.durationMinutes==null?null:Number(j.durationMinutes),
              j.success===false?0:1, payload, j.notes||null,
              j.createdAt||now, now);
          migrated.jobs++;
        }
      }

      // BOM items kept as-is in their own table for now (project-scoped wishlist)
      // We'll surface them as a Project Bills tab later.
      db.exec(`CREATE TABLE IF NOT EXISTS bom_items (
        id TEXT PRIMARY KEY, project_name TEXT NOT NULL, component TEXT NOT NULL,
        quantity REAL DEFAULT 1, unit TEXT DEFAULT 'pcs', source TEXT,
        unit_cost REAL DEFAULT 0, status TEXT DEFAULT 'needed',
        notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      if (Array.isArray(data?.bom)) {
        for (const bRaw of data.bom) {
          const b = bRaw as Record<string, unknown>;
          if (!b?.id) continue;
          const exists = db.prepare('SELECT id FROM bom_items WHERE id=?').get(String(b.id));
          if (exists) continue;
          db.prepare(`INSERT INTO bom_items
            (id, project_name, component, quantity, unit, source, unit_cost,
             status, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(String(b.id), b.projectName||'', b.component||'',
              Number(b.quantity)||1, b.unit||'pcs', b.source||null,
              Number(b.unitCost)||0, b.status||'needed', b.notes||null,
              b.createdAt||now);
          migrated.bom++;
        }
      }

      return { ok: true, migrated };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  // BOM CRUD (kept for back-compat with Print Studio panel)
  ipcMain.handle('maker:bom:list', (_e, projectName?: string) => {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS bom_items (
        id TEXT PRIMARY KEY, project_name TEXT NOT NULL, component TEXT NOT NULL,
        quantity REAL DEFAULT 1, unit TEXT DEFAULT 'pcs', source TEXT,
        unit_cost REAL DEFAULT 0, status TEXT DEFAULT 'needed',
        notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      if (projectName) {
        return db.prepare('SELECT * FROM bom_items WHERE project_name=? ORDER BY created_at DESC').all(projectName);
      }
      return db.prepare('SELECT * FROM bom_items ORDER BY created_at DESC').all();
    } catch { return []; }
  });

  ipcMain.handle('maker:bom:save', (_e, b: Record<string, unknown>) => {
    try {
      const id = String(b.id || crypto.randomUUID());
      db.prepare(`INSERT INTO bom_items
        (id, project_name, component, quantity, unit, source, unit_cost, status, notes, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET project_name=excluded.project_name,
          component=excluded.component, quantity=excluded.quantity, unit=excluded.unit,
          source=excluded.source, unit_cost=excluded.unit_cost, status=excluded.status,
          notes=excluded.notes`)
        .run(id, b.project_name||b.projectName||'', b.component||'',
          Number(b.quantity)||1, b.unit||'pcs', b.source||null,
          Number(b.unit_cost||b.unitCost)||0, b.status||'needed', b.notes||null,
          b.created_at||b.createdAt||new Date().toISOString());
      return { ok: true, id };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle('maker:bom:delete', (_e, id: string) => {
    try { db.prepare('DELETE FROM bom_items WHERE id=?').run(id); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });
}
