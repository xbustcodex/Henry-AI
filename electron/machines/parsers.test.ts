/**
 * Unit tests for the pure protocol parsers/mappers in the machine layer.
 * No sockets, no serial ports — just payload → MachineStatus logic.
 */

import { describe, expect, it } from 'vitest';
import { buildBambuCurlArgs, mapBambuGcodeState, mapBambuReport } from './bambu';
import { mapMoonrakerState, mapMoonrakerStatus } from './moonraker';
import { mapOctoPrintState, mapOctoPrintStatus } from './octoprint';
import { parseGrblStatus, parseMarlinTemps, prepareGcodeLines } from './serial';

// ── GRBL status line parser ─────────────────────────────────────────────────

describe('parseGrblStatus', () => {
  it('parses an Idle report with MPos', () => {
    const r = parseGrblStatus('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');
    expect(r).not.toBeNull();
    expect(r!.state).toBe('idle');
    expect(r!.grblState).toBe('Idle');
    expect(r!.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(r!.positionType).toBe('MPos');
    expect(r!.feedRate).toBe(0);
  });

  it('parses a Run report with WPos and negative coords', () => {
    const r = parseGrblStatus('<Run|WPos:12.500,-3.100,1.000|FS:500,8000>');
    expect(r!.state).toBe('running');
    expect(r!.position).toEqual({ x: 12.5, y: -3.1, z: 1 });
    expect(r!.positionType).toBe('WPos');
    expect(r!.feedRate).toBe(500);
  });

  it('maps Hold (with sub-state) to paused', () => {
    const r = parseGrblStatus('<Hold:0|MPos:5.000,5.000,0.000|FS:0,0>');
    expect(r!.state).toBe('paused');
    expect(r!.grblState).toBe('Hold:0');
  });

  it('maps Alarm to error and Jog/Home to running', () => {
    expect(parseGrblStatus('<Alarm|MPos:0.000,0.000,0.000>')!.state).toBe('error');
    expect(parseGrblStatus('<Jog|MPos:1.000,2.000,3.000>')!.state).toBe('running');
    expect(parseGrblStatus('<Home|MPos:1.000,2.000,3.000>')!.state).toBe('running');
  });

  it('parses GRBL 0.9-style F field', () => {
    const r = parseGrblStatus('<Run|MPos:1.000,2.000,3.000|F:1200>');
    expect(r!.feedRate).toBe(1200);
  });

  it('returns null for non-status lines', () => {
    expect(parseGrblStatus('ok')).toBeNull();
    expect(parseGrblStatus('error:9')).toBeNull();
    expect(parseGrblStatus("Grbl 1.1h ['$' for help]")).toBeNull();
    expect(parseGrblStatus('')).toBeNull();
  });
});

// ── Marlin M105 temp parser ─────────────────────────────────────────────────

describe('parseMarlinTemps', () => {
  it('parses a full ok temp report', () => {
    const t = parseMarlinTemps('ok T:210.4 /210.0 B:60.1 /60.0 @:127 B@:127');
    expect(t).toEqual({ nozzle: 210.4, nozzleTarget: 210, bed: 60.1, bedTarget: 60 });
  });

  it('parses an autoreport line without ok prefix', () => {
    const t = parseMarlinTemps('T:24.3 /0.0 B:23.9 /0.0 @:0 B@:0');
    expect(t!.nozzle).toBeCloseTo(24.3);
    expect(t!.bedTarget).toBe(0);
  });

  it('returns null for non-temp lines', () => {
    expect(parseMarlinTemps('ok')).toBeNull();
    expect(parseMarlinTemps('echo:busy: processing')).toBeNull();
  });
});

// ── G-code line preparation ─────────────────────────────────────────────────

describe('prepareGcodeLines', () => {
  it('strips comments and blank lines', () => {
    const lines = prepareGcodeLines('; header\nG28 ; home\n\nG1 X10 (move)\n;done\n');
    expect(lines).toEqual(['G28', 'G1 X10']);
  });
});

// ── Bambu report mapper ─────────────────────────────────────────────────────

describe('mapBambuReport', () => {
  it('maps a full print report', () => {
    const s = mapBambuReport({
      gcode_state: 'RUNNING',
      mc_percent: 42,
      mc_remaining_time: 90, // minutes
      nozzle_temper: 219.6,
      nozzle_target_temper: 220,
      bed_temper: 55.1,
      bed_target_temper: 55,
      subtask_name: 'benchy.3mf',
    });
    expect(s.state).toBe('printing');
    expect(s.progressPct).toBe(42);
    expect(s.timeRemainingSec).toBe(90 * 60);
    expect(s.tempNozzle).toBeCloseTo(219.6);
    expect(s.tempNozzleTarget).toBe(220);
    expect(s.tempBed).toBeCloseTo(55.1);
    expect(s.jobName).toBe('benchy.3mf');
  });

  it('merges a partial report over the previous status', () => {
    const prev = mapBambuReport({
      gcode_state: 'RUNNING', mc_percent: 10, nozzle_temper: 220, subtask_name: 'part.3mf',
    });
    const next = mapBambuReport({ mc_percent: 11 }, prev);
    expect(next.state).toBe('printing');   // kept
    expect(next.progressPct).toBe(11);     // updated
    expect(next.tempNozzle).toBe(220);     // kept
    expect(next.jobName).toBe('part.3mf'); // kept
  });

  it('maps gcode_state variants', () => {
    expect(mapBambuGcodeState('PAUSE')).toBe('paused');
    expect(mapBambuGcodeState('FAILED')).toBe('error');
    expect(mapBambuGcodeState('FINISH')).toBe('idle');
    expect(mapBambuGcodeState('PREPARE')).toBe('printing');
    expect(mapBambuGcodeState('SOMETHING_NEW')).toBeUndefined();
  });
});

// ── Moonraker mapper ────────────────────────────────────────────────────────

describe('mapMoonrakerStatus', () => {
  it('maps an active print with remaining-time estimate and position', () => {
    const s = mapMoonrakerStatus({
      print_stats: { state: 'printing', filename: 'widget.gcode', print_duration: 600 },
      extruder: { temperature: 205.2, target: 205 },
      heater_bed: { temperature: 60.4, target: 60 },
      virtual_sdcard: { progress: 0.25, is_active: true },
      toolhead: { position: [110.5, 90.2, 3.4, 812.3] },
    });
    expect(s.state).toBe('printing');
    expect(s.progressPct).toBe(25);
    expect(s.jobName).toBe('widget.gcode');
    // 600s at 25% → 1800s remaining
    expect(s.timeRemainingSec).toBe(1800);
    expect(s.positionXYZ).toEqual({ x: 110.5, y: 90.2, z: 3.4 });
    expect(s.tempNozzle).toBeCloseTo(205.2);
    expect(s.tempBed).toBeCloseTo(60.4);
  });

  it('maps standby/complete/cancelled to idle and error to error', () => {
    expect(mapMoonrakerState('standby')).toBe('idle');
    expect(mapMoonrakerState('complete')).toBe('idle');
    expect(mapMoonrakerState('cancelled')).toBe('idle');
    expect(mapMoonrakerState('paused')).toBe('paused');
    expect(mapMoonrakerState('error')).toBe('error');
    expect(mapMoonrakerState(undefined)).toBe('idle');
  });

  it('omits remaining time when progress is ~0', () => {
    const s = mapMoonrakerStatus({
      print_stats: { state: 'printing', print_duration: 5 },
      virtual_sdcard: { progress: 0 },
    });
    expect(s.timeRemainingSec).toBeUndefined();
  });
});

// ── OctoPrint mapper ────────────────────────────────────────────────────────

describe('mapOctoPrintStatus', () => {
  it('maps an active print', () => {
    const s = mapOctoPrintStatus(
      {
        temperature: { tool0: { actual: 210.1, target: 210 }, bed: { actual: 59.8, target: 60 } },
        state: { text: 'Printing', flags: { operational: true, printing: true } },
      },
      {
        job: { file: { name: 'case.gcode' } },
        progress: { completion: 66.6, printTimeLeft: 1234 },
      },
    );
    expect(s.state).toBe('printing');
    expect(s.progressPct).toBe(67);
    expect(s.jobName).toBe('case.gcode');
    expect(s.timeRemainingSec).toBe(1234);
    expect(s.tempNozzle).toBeCloseTo(210.1);
    expect(s.tempBedTarget).toBe(60);
  });

  it('maps flags to states', () => {
    expect(mapOctoPrintState({ paused: true })).toBe('paused');
    expect(mapOctoPrintState({ pausing: true })).toBe('paused');
    expect(mapOctoPrintState({ error: true })).toBe('error');
    expect(mapOctoPrintState({ closedOrError: true })).toBe('error');
    expect(mapOctoPrintState({ operational: true })).toBe('idle');
    expect(mapOctoPrintState({})).toBe('offline');
    expect(mapOctoPrintState(undefined)).toBe('idle');
  });

  it('tolerates null progress fields (no active job)', () => {
    const s = mapOctoPrintStatus(
      { state: { flags: { operational: true } } },
      { job: { file: { name: null } }, progress: { completion: null, printTimeLeft: null } },
    );
    expect(s.state).toBe('idle');
    expect(s.progressPct).toBeUndefined();
    expect(s.jobName).toBeUndefined();
    expect(s.timeRemainingSec).toBeUndefined();
  });
});

describe('buildBambuCurlArgs', () => {
  it('builds an implicit-FTPS upload command for the printer SD card', () => {
    const args = buildBambuCurlArgs('192.168.1.50', '12345678', '/tmp/part.3mf', 'part.3mf');
    expect(args).toContain('--insecure');
    expect(args).toContain('-T');
    expect(args[args.indexOf('-T') + 1]).toBe('/tmp/part.3mf');
    expect(args[args.indexOf('--user') + 1]).toBe('bblp:12345678');
    expect(args[args.length - 1]).toBe('ftps://192.168.1.50:990/part.3mf');
  });

  it('URL-encodes remote names with spaces', () => {
    const args = buildBambuCurlArgs('10.0.0.2', 'code', '/tmp/my part.gcode', 'my part.gcode');
    expect(args[args.length - 1]).toBe('ftps://10.0.0.2:990/my%20part.gcode');
  });
});
