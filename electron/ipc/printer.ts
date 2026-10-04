/**
 * 3D Printer — Henry's serial port communication layer.
 *
 * Uses Python's pyserial (typically pre-installed on Mac/Linux) to communicate
 * via USB serial with Marlin/Klipper/Prusa/Bambu-style printers.
 * Also supports discovering ports and sending raw G-code commands.
 *
 * Fallback: if pyserial isn't available, provides guidance on installing it.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

type WindowGetter = () => BrowserWindow | null;

interface PrinterConnection {
  port: string;
  baudRate: number;
  process: ChildProcess;
  buffer: string;
  connected: boolean;
}

let getWindow: WindowGetter;
let activeConnection: PrinterConnection | null = null;

function safeSend(channel: string, data: unknown) {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// ── Python detection ──────────────────────────────────────────────────────────
// Electron apps on Mac get a restricted PATH (/usr/bin:/bin) that typically
// misses Homebrew python3. We probe the most common locations explicitly.

const MAC_PYTHON_CANDIDATES = [
  '/opt/homebrew/bin/python3',   // Apple Silicon + Homebrew
  '/usr/local/bin/python3',      // Intel Mac + Homebrew
  '/usr/bin/python3',            // System Python (macOS 12.3+)
  '/usr/bin/python',             // Older system Python
  'python3',                     // PATH fallback
  'python',
];

let resolvedPython: string | null = null;

async function findPython(): Promise<string> {
  if (resolvedPython) return resolvedPython;
  if (process.platform === 'win32') { resolvedPython = 'python'; return resolvedPython; }

  for (const cmd of MAC_PYTHON_CANDIDATES) {
    const result = await runPythonWith(cmd, 'print("ok")', 3000);
    if (result.exitCode === 0 && result.stdout.trim() === 'ok') {
      resolvedPython = cmd;
      return resolvedPython;
    }
  }
  resolvedPython = 'python3'; // last resort
  return resolvedPython;
}

function runPythonWith(
  pythonCmd: string,
  script: string,
  timeout = 10000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(pythonCmd, ['-c', script], { timeout });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number | null) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    child.on('error', (e: Error) => resolve({ stdout: '', stderr: e.message, exitCode: -1 }));
  });
}

async function runPython(script: string, timeout = 10000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cmd = await findPython();
  return runPythonWith(cmd, script, timeout);
}

export function registerPrinterHandlers(winGetter: WindowGetter) {
  getWindow = winGetter;

  // ── Check if pyserial is available ───────────────────────────────────
  ipcMain.handle('printer:checkDeps', async () => {
    const result = await runPython('import serial; print(serial.__version__)');
    if (result.exitCode === 0) {
      return { available: true, version: result.stdout.trim() };
    }
    return {
      available: false,
      installCommand: process.platform === 'win32'
        ? 'pip install pyserial'
        : 'pip3 install pyserial',
      error: result.stderr,
    };
  });

  // ── List serial ports ─────────────────────────────────────────────────
  ipcMain.handle('printer:listPorts', async () => {
    // Try pyserial first
    const pyResult = await runPython(`
import json
try:
    import serial.tools.list_ports
    ports = [{'device': p.device, 'description': p.description, 'hwid': p.hwid} for p in serial.tools.list_ports.comports()]
    print(json.dumps(ports))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`);
    if (pyResult.exitCode === 0) {
      try {
        const parsed = JSON.parse(pyResult.stdout.trim());
        if (!parsed.error) return { ports: parsed, method: 'pyserial' };
      } catch {}
    }

    // Fallback: list /dev/tty.* ports on Mac/Linux
    if (process.platform !== 'win32') {
      const child = spawn('sh', ['-c', 'ls /dev/tty.* /dev/ttyUSB* /dev/ttyACM* 2>/dev/null']);
      let stdout = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      await new Promise((r) => child.on('close', r));
      const ports = stdout.trim().split('\n').filter(Boolean).map((device: string) => ({
        device: device.trim(),
        description: device.includes('usbmodem') || device.includes('usbserial')
          ? 'USB Serial Device'
          : 'Serial Port',
        hwid: '',
      }));
      return { ports, method: 'ls' };
    }

    return { ports: [], error: 'Install pyserial: pip3 install pyserial', method: 'none' };
  });

  // ── Connect to printer ────────────────────────────────────────────────
  ipcMain.handle('printer:connect', async (_event, params: { port: string; baudRate?: number }) => {
    if (activeConnection?.connected) {
      return { success: false, error: `Already connected to ${activeConnection.port}. Disconnect first.` };
    }

    const baudRate = params.baudRate || 115200;

    // Write a persistent Python script to a temp file for the connection process
    const scriptPath = path.join(os.tmpdir(), 'henry_printer_bridge.py');
    const script = `
import sys, serial, threading, time, json

port = ${JSON.stringify(params.port)}
baud = ${baudRate}

try:
    ser = serial.Serial(port, baud, timeout=2)
    time.sleep(2)  # Wait for printer to reset
    print(json.dumps({'connected': True, 'port': port, 'baud': baud}))
    sys.stdout.flush()
    
    def read_loop():
        while True:
            try:
                line = ser.readline().decode('utf-8', errors='replace').strip()
                if line:
                    print(json.dumps({'type': 'response', 'data': line}))
                    sys.stdout.flush()
            except Exception as e:
                print(json.dumps({'type': 'error', 'data': str(e)}))
                sys.stdout.flush()
                break
    
    t = threading.Thread(target=read_loop, daemon=True)
    t.start()
    
    # Command loop — read commands from stdin
    for line in sys.stdin:
        cmd = line.strip()
        if cmd == '__QUIT__':
            break
        if cmd:
            ser.write((cmd + '\\n').encode())
            ser.flush()
            print(json.dumps({'type': 'sent', 'data': cmd}))
            sys.stdout.flush()
    
    ser.close()
    print(json.dumps({'type': 'disconnected'}))
    sys.stdout.flush()
    
except Exception as e:
    print(json.dumps({'connected': False, 'error': str(e)}))
    sys.stdout.flush()
`;
    fs.writeFileSync(scriptPath, script);

    const pythonCmd = await findPython();
    return new Promise((resolve) => {
      const child = spawn(pythonCmd, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });

      let firstLine = true;

      child.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as { connected?: boolean; error?: string; port?: string; baud?: number; type?: string; data?: string };
            if (firstLine) {
              firstLine = false;
              if (parsed.connected) {
                activeConnection = {
                  port: params.port,
                  baudRate,
                  process: child,
                  buffer: '',
                  connected: true,
                };
                resolve({ success: true, port: params.port, baudRate });
              } else {
                child.kill();
                resolve({ success: false, error: parsed.error || 'Connection failed' });
              }
            } else {
              // Forward printer responses to renderer
              safeSend('printer:data', parsed);
            }
          } catch {
            // Not JSON, ignore
          }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        if (firstLine) {
          firstLine = false;
          resolve({ success: false, error: data.toString() });
        }
      });

      child.on('close', () => {
        if (activeConnection?.process === child) {
          activeConnection = null;
          safeSend('printer:data', { type: 'disconnected' });
        }
      });

      child.on('error', (e: Error) => {
        if (firstLine) {
          firstLine = false;
          resolve({
            success: false,
            error: `Python error: ${e.message}. Install pyserial: pip3 install pyserial`,
          });
        }
      });

      // Timeout if no response in 8 seconds
      setTimeout(() => {
        if (firstLine) {
          firstLine = false;
          child.kill();
          resolve({ success: false, error: 'Connection timeout. Check port and baud rate.' });
        }
      }, 8000);
    });
  });

  // ── Send G-code ───────────────────────────────────────────────────────
  ipcMain.handle('printer:sendGcode', async (_event, command: string) => {
    if (!activeConnection?.connected) {
      return { success: false, error: 'Not connected to a printer.' };
    }
    try {
      const cmd = command.trim().toUpperCase();
      (activeConnection.process.stdin as NodeJS.WritableStream).write(cmd + '\n');
      return { success: true, sent: cmd };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────
  ipcMain.handle('printer:disconnect', async () => {
    if (!activeConnection) {
      return { success: false, error: 'Not connected.' };
    }
    try {
      (activeConnection.process.stdin as NodeJS.WritableStream).write('__QUIT__\n');
      setTimeout(() => activeConnection?.process.kill(), 2000);
      activeConnection = null;
      return { success: true };
    } catch (e: any) {
      activeConnection = null;
      return { success: false, error: e.message };
    }
  });

  // ── Get connection status ─────────────────────────────────────────────
  ipcMain.handle('printer:status', async () => {
    if (!activeConnection?.connected) {
      return { connected: false };
    }
    // Send M115 (firmware info) and M105 (temperature) queries
    try {
      (activeConnection.process.stdin as NodeJS.WritableStream).write('M115\n');
      (activeConnection.process.stdin as NodeJS.WritableStream).write('M105\n');
    } catch {}
    return {
      connected: true,
      port: activeConnection.port,
      baudRate: activeConnection.baudRate,
    };
  });

  // ── Print from G-code string ──────────────────────────────────────────
  ipcMain.handle('printer:printGcode', async (_event, gcode: string) => {
    if (!activeConnection?.connected) {
      return { success: false, error: 'Not connected to a printer.' };
    }
    const lines = gcode.split('\n').filter((l) => {
      const trimmed = l.trim();
      return trimmed && !trimmed.startsWith(';');
    });
    let sent = 0;
    for (const line of lines) {
      try {
        (activeConnection.process.stdin as NodeJS.WritableStream).write(line.trim() + '\n');
        sent++;
        safeSend('printer:data', { type: 'sent', data: line.trim() });
        // Small delay to not overwhelm slow serial connections
        await new Promise((r) => setTimeout(r, 20));
      } catch (e: any) {
        return { success: false, error: e.message, sent };
      }
    }
    return { success: true, sent, total: lines.length };
  });
}
