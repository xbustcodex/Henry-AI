/**
 * Connections — live machine connectivity inside the Machines panel.
 *
 * Talks to the unified machine layer (electron/machines/) over the
 * machines:* IPC: add/edit connections for the 5 supported protocols
 * (Bambu LAN, Klipper/Moonraker, OctoPrint, Marlin serial, GRBL serial),
 * connect/disconnect, live status cards (state, temps, progress, job, XYZ
 * for CNC), job controls (pause/resume/stop-with-confirm), and an opt-in
 * ~5 s discovery scan.
 */
import { useCallback, useEffect, useState } from 'react';

const PROTOCOLS: Array<{ id: HenryMachineProtocol; label: string; kind: HenryMachineKind; hint: string }> = [
  { id: 'bambu',         label: 'Bambu Lab (LAN mode)',    kind: 'printer', hint: 'IP + serial number + LAN access code (printer screen → Settings → WLAN)' },
  { id: 'moonraker',     label: 'Klipper / Moonraker',     kind: 'printer', hint: 'Just the host/IP — Moonraker is open on port 7125 by default' },
  { id: 'octoprint',     label: 'OctoPrint',               kind: 'printer', hint: 'Host/IP + API key (OctoPrint → Settings → API)' },
  { id: 'marlin-serial', label: 'Marlin (USB serial)',     kind: 'printer', hint: 'USB device path + baud rate (usually 115200)' },
  { id: 'grbl-serial',   label: 'GRBL CNC (USB serial)',   kind: 'cnc',     hint: 'USB device path + baud rate (usually 115200)' },
];

const STATE_META: Record<HenryMachineState, { label: string; color: string }> = {
  idle:     { label: 'Idle',     color: 'text-emerald-400 bg-emerald-400/10' },
  printing: { label: 'Printing', color: 'text-sky-400 bg-sky-400/10' },
  running:  { label: 'Running',  color: 'text-sky-400 bg-sky-400/10' },
  paused:   { label: 'Paused',   color: 'text-amber-400 bg-amber-400/10' },
  error:    { label: 'Error',    color: 'text-rose-400 bg-rose-400/10' },
  offline:  { label: 'Offline',  color: 'text-henry-text-muted bg-henry-surface' },
};

const inputCls = 'w-full bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50 transition-all';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}

interface DraftMachine {
  id?: string;
  name: string;
  protocol: HenryMachineProtocol;
  kind: HenryMachineKind;
  config: HenryMachineConfig;
}

function newDraft(protocol: HenryMachineProtocol = 'bambu'): DraftMachine {
  const meta = PROTOCOLS.find((p) => p.id === protocol)!;
  return { name: '', protocol, kind: meta.kind, config: {} };
}

function fmtTime(sec?: number): string | null {
  if (sec === undefined || sec <= 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

export default function ConnectionsSection() {
  const [machines, setMachines] = useState<HenryMachineConnection[]>([]);
  const [statuses, setStatuses] = useState<Record<string, HenryMachineStatus>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<DraftMachine | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<HenryDiscoveredMachine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const api = window.henryAPI;
  const available = Boolean(api?.machinesList);

  const reload = useCallback(async () => {
    if (!api?.machinesList) return;
    const r = await api.machinesList();
    if (r.ok) {
      setMachines(r.result);
      setStatuses((prev) => {
        const next = { ...prev };
        for (const m of r.result) if (m.status) next[m.id] = m.status;
        return next;
      });
    }
  }, [api]);

  useEffect(() => { void reload(); }, [reload]);

  // Live updates from the main-process poll loop.
  useEffect(() => {
    if (!api?.onMachinesEvent) return;
    return api.onMachinesEvent((event) => {
      if (event.type === 'status' || event.type === 'connected') {
        if (event.status) setStatuses((prev) => ({ ...prev, [event.machineId]: event.status! }));
        if (event.type === 'connected') void reload();
      } else if (event.type === 'disconnected') {
        setStatuses((prev) => ({ ...prev, [event.machineId]: { state: 'offline' } }));
        void reload();
      }
    });
  }, [api, reload]);

  function setBusyFor(id: string, value: boolean) {
    setBusy((prev) => ({ ...prev, [id]: value }));
  }

  async function connect(id: string) {
    if (!api?.machinesConnect) return;
    setError(null);
    setBusyFor(id, true);
    const r = await api.machinesConnect(id);
    setBusyFor(id, false);
    if (!r.ok) { setError(r.error); return; }
    setStatuses((prev) => ({ ...prev, [id]: r.result.status }));
    void reload();
  }

  async function disconnect(id: string) {
    if (!api?.machinesDisconnect) return;
    setBusyFor(id, true);
    await api.machinesDisconnect(id);
    setBusyFor(id, false);
    void reload();
  }

  async function jobAction(m: HenryMachineConnection, action: 'pause' | 'resume' | 'stop' | 'home') {
    if (!api?.machinesJob) return;
    if (action === 'stop' && !confirm(`Stop the current job on "${m.name}"? This cancels it — it can't be resumed.`)) return;
    if (action === 'home' && !confirm(`Run the homing cycle on "${m.name}"? Make sure the work area is clear — the machine will move to its limit switches.`)) return;
    setError(null);
    const r = await api.machinesJob(m.id, action);
    if (!r.ok) setError(r.error);
  }

  async function remove(m: HenryMachineConnection) {
    if (!api?.machinesRemove) return;
    if (!confirm(`Remove the connection for "${m.name}"?`)) return;
    await api.machinesRemove(m.id);
    void reload();
  }

  async function saveDraft() {
    if (!editing || !editing.name.trim()) return;
    setError(null);
    const r = editing.id
      ? await api?.machinesUpdate?.(editing.id, { name: editing.name, kind: editing.kind, protocol: editing.protocol, config: editing.config })
      : await api?.machinesAdd?.({ name: editing.name, kind: editing.kind, protocol: editing.protocol, config: editing.config });
    if (r && !r.ok) { setError(r.error); return; }
    setEditing(null);
    void reload();
  }

  async function discover() {
    if (!api?.machinesDiscover) return;
    setDiscovering(true);
    setDiscovered(null);
    const r = await api.machinesDiscover();
    setDiscovering(false);
    if (r.ok) setDiscovered(r.result);
    else setError(r.error);
  }

  function addFromDiscovery(d: HenryDiscoveredMachine) {
    const protocol: HenryMachineProtocol = d.protocolGuess === 'unknown' ? 'marlin-serial' : d.protocolGuess;
    const meta = PROTOCOLS.find((p) => p.id === protocol)!;
    setEditing({
      name: '',
      protocol,
      kind: meta.kind,
      config: d.devicePath ? { devicePath: d.devicePath, baudRate: 115200 } : { host: d.host, port: d.port },
    });
  }

  if (!available) return null; // web/browser mode — no machine layer

  const protoMeta = editing ? PROTOCOLS.find((p) => p.id === editing.protocol)! : null;

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-henry-text">Connections</h2>
          <p className="text-[11px] text-henry-text-muted">Live links to your printers and CNCs — status, temps, and job control</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void discover()} disabled={discovering}
            className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-surface/60 text-henry-text-muted border border-henry-border/20 hover:text-henry-text transition-all disabled:opacity-50">
            {discovering ? 'Scanning… (~5s)' : '⌕ Discover'}
          </button>
          <button onClick={() => setEditing(newDraft())}
            className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all">
            + Connect a machine
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 text-[11px] text-rose-400 bg-rose-400/10 border border-rose-400/20 rounded-xl px-3 py-2 flex items-start justify-between gap-2">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 hover:text-rose-300">✕</button>
        </div>
      )}

      {discovered !== null && (
        <div className="mb-3 bg-henry-surface/40 border border-henry-border/20 rounded-2xl p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] font-semibold text-henry-text">
              {discovered.length === 0 ? 'No machines found on this network or USB.' : `Found ${discovered.length} candidate${discovered.length === 1 ? '' : 's'}:`}
            </p>
            <button onClick={() => setDiscovered(null)} className="text-[11px] text-henry-text-muted hover:text-henry-text">✕</button>
          </div>
          <div className="space-y-1.5">
            {discovered.map((d, i) => (
              <div key={i} className="flex items-center justify-between gap-2 text-[11px] text-henry-text-muted">
                <span className="truncate font-mono">{d.label}</span>
                <button onClick={() => addFromDiscovery(d)}
                  className="shrink-0 px-2 py-1 rounded-lg bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all">
                  Set up
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {machines.length === 0 ? (
        <div className="bg-henry-surface/30 border border-dashed border-henry-border/30 rounded-2xl p-4 text-center">
          <p className="text-[12px] text-henry-text-muted">
            No live connections yet. Henry can talk to Bambu Lab (LAN), Klipper/Moonraker,
            OctoPrint, Marlin, and GRBL machines. Hit <span className="text-henry-accent">Discover</span> or add one manually.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {machines.map((m) => {
            const st = statuses[m.id] ?? m.status ?? { state: 'offline' as const };
            const sm = STATE_META[st.state] ?? STATE_META.offline;
            const isBusy = Boolean(busy[m.id]);
            const proto = PROTOCOLS.find((p) => p.id === m.protocol);
            const timeLeft = fmtTime(st.timeRemainingSec);
            const active = st.state === 'printing' || st.state === 'running' || st.state === 'paused';
            return (
              <div key={m.id} className="bg-henry-surface/40 border border-henry-border/20 rounded-2xl p-4 hover:border-henry-border/50 transition-all">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="text-sm font-semibold text-henry-text">{m.name}</p>
                    <p className="text-[11px] text-henry-text-muted">{proto?.label ?? m.protocol}{m.kind === 'cnc' ? ' · CNC' : ''}</p>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${sm.color}`}>{sm.label}</span>
                </div>

                {m.connected && (
                  <div className="space-y-1.5 mb-2">
                    {st.jobName && (
                      <p className="text-[11px] text-henry-text truncate" title={st.jobName}>▸ {st.jobName}</p>
                    )}
                    {st.progressPct !== undefined && (
                      <div>
                        <div className="h-1.5 bg-henry-surface rounded-full overflow-hidden">
                          <div className="h-full bg-henry-accent rounded-full transition-all" style={{ width: `${Math.min(100, Math.max(0, st.progressPct))}%` }} />
                        </div>
                        <p className="text-[10px] text-henry-text-muted mt-1">
                          {st.progressPct}%{timeLeft ? ` · ${timeLeft}` : ''}
                        </p>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-henry-text-muted">
                      {st.tempNozzle !== undefined && (
                        <span>Nozzle {Math.round(st.tempNozzle)}°{st.tempNozzleTarget ? `/${Math.round(st.tempNozzleTarget)}°` : ''}</span>
                      )}
                      {st.tempBed !== undefined && (
                        <span>Bed {Math.round(st.tempBed)}°{st.tempBedTarget ? `/${Math.round(st.tempBedTarget)}°` : ''}</span>
                      )}
                      {st.positionXYZ && (
                        <span className="font-mono">
                          X{st.positionXYZ.x.toFixed(1)} Y{st.positionXYZ.y.toFixed(1)} Z{st.positionXYZ.z.toFixed(1)}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {m.connected && active && (
                  <div className="flex gap-1.5 mb-2">
                    {st.state === 'paused' ? (
                      <button onClick={() => void jobAction(m, 'resume')}
                        className="flex-1 text-[11px] py-1.5 rounded-lg bg-emerald-400/10 text-emerald-400 hover:bg-emerald-400/20 transition-all">
                        ▶ Resume
                      </button>
                    ) : (
                      <button onClick={() => void jobAction(m, 'pause')}
                        className="flex-1 text-[11px] py-1.5 rounded-lg bg-amber-400/10 text-amber-400 hover:bg-amber-400/20 transition-all">
                        ⏸ Pause
                      </button>
                    )}
                    <button onClick={() => void jobAction(m, 'stop')}
                      className="flex-1 text-[11px] py-1.5 rounded-lg bg-rose-400/10 text-rose-400 hover:bg-rose-400/20 transition-all">
                      ■ Stop
                    </button>
                  </div>
                )}

                <div className="flex gap-1.5 pt-2 border-t border-henry-border/15">
                  {m.connected && m.kind === 'cnc' && (
                    <button onClick={() => void jobAction(m, 'home')} disabled={active}
                      title={active ? 'Stop or finish the current job before homing' : 'Run the homing cycle ($H)'}
                      className="text-[11px] px-3 py-1.5 rounded-lg bg-indigo-400/10 text-indigo-400 hover:bg-indigo-400/20 transition-all disabled:opacity-40">
                      ⌂ Home
                    </button>
                  )}
                  {m.connected ? (
                    <button onClick={() => void disconnect(m.id)} disabled={isBusy}
                      className="flex-1 text-[11px] py-1.5 rounded-lg bg-henry-surface text-henry-text hover:bg-henry-surface/80 transition-all disabled:opacity-50">
                      Disconnect
                    </button>
                  ) : (
                    <button onClick={() => void connect(m.id)} disabled={isBusy}
                      className="flex-1 text-[11px] py-1.5 rounded-lg bg-henry-accent text-white hover:bg-henry-accent/80 transition-all disabled:opacity-50">
                      {isBusy ? 'Connecting…' : 'Connect'}
                    </button>
                  )}
                  <button
                    onClick={() => setEditing({ id: m.id, name: m.name, protocol: m.protocol, kind: m.kind, config: { ...m.config } })}
                    disabled={m.connected}
                    title={m.connected ? 'Disconnect before editing' : undefined}
                    className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-surface text-henry-text-muted hover:text-henry-text transition-all disabled:opacity-40">
                    Edit
                  </button>
                  <button onClick={() => void remove(m)}
                    className="text-[11px] px-2 py-1.5 rounded-lg text-henry-text-muted hover:text-rose-400 hover:bg-rose-400/10 transition-all">
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && protoMeta && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="bg-henry-bg border border-henry-border/40 rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-henry-text mb-1">
              {editing.id ? 'Edit connection' : 'Connect a machine'}
            </h2>
            <p className="text-[11px] text-henry-text-muted mb-4">{protoMeta.hint}</p>

            <div className="space-y-3">
              <Field label="Name (required)">
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder='e.g., "X1 Carbon", "Voron 2.4", "Shapeoko"' className={inputCls} />
              </Field>

              <Field label="Protocol">
                <select value={editing.protocol}
                  onChange={(e) => {
                    const protocol = e.target.value as HenryMachineProtocol;
                    const meta = PROTOCOLS.find((p) => p.id === protocol)!;
                    setEditing({ ...editing, protocol, kind: meta.kind });
                  }}
                  className={inputCls}>
                  {PROTOCOLS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </Field>

              {(editing.protocol === 'bambu' || editing.protocol === 'moonraker' || editing.protocol === 'octoprint') && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Host / IP">
                    <input value={editing.config.host || ''} onChange={(e) => setEditing({ ...editing, config: { ...editing.config, host: e.target.value } })}
                      placeholder="192.168.1.50" className={inputCls + ' font-mono text-xs'} />
                  </Field>
                  <Field label={`Port (default ${editing.protocol === 'bambu' ? 8883 : editing.protocol === 'moonraker' ? 7125 : 80})`}>
                    <input type="number" value={editing.config.port ?? ''}
                      onChange={(e) => setEditing({ ...editing, config: { ...editing.config, port: e.target.value === '' ? undefined : Number(e.target.value) } })}
                      placeholder="auto" className={inputCls} />
                  </Field>
                </div>
              )}

              {editing.protocol === 'bambu' && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Serial number">
                    <input value={editing.config.serialNumber || ''} onChange={(e) => setEditing({ ...editing, config: { ...editing.config, serialNumber: e.target.value } })}
                      placeholder="01S00A000000000" className={inputCls + ' font-mono text-xs'} />
                  </Field>
                  <Field label="LAN access code">
                    <input value={editing.config.accessCode || ''} onChange={(e) => setEditing({ ...editing, config: { ...editing.config, accessCode: e.target.value } })}
                      placeholder="from the printer screen" className={inputCls + ' font-mono text-xs'} />
                  </Field>
                </div>
              )}

              {editing.protocol === 'octoprint' && (
                <Field label="API key">
                  <input value={editing.config.apiKey || ''} onChange={(e) => setEditing({ ...editing, config: { ...editing.config, apiKey: e.target.value } })}
                    placeholder="OctoPrint → Settings → API" className={inputCls + ' font-mono text-xs'} />
                </Field>
              )}

              {(editing.protocol === 'marlin-serial' || editing.protocol === 'grbl-serial') && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Device path">
                    <input value={editing.config.devicePath || ''} onChange={(e) => setEditing({ ...editing, config: { ...editing.config, devicePath: e.target.value } })}
                      placeholder="/dev/tty.usbmodem1101" className={inputCls + ' font-mono text-xs'} />
                  </Field>
                  <Field label="Baud rate">
                    <input type="number" value={editing.config.baudRate ?? 115200}
                      onChange={(e) => setEditing({ ...editing, config: { ...editing.config, baudRate: Number(e.target.value) || 115200 } })}
                      className={inputCls} />
                  </Field>
                </div>
              )}
            </div>

            <div className="flex gap-2 mt-5 pt-4 border-t border-henry-border/20">
              <button onClick={() => setEditing(null)}
                className="flex-1 py-2.5 rounded-xl bg-henry-surface text-henry-text-muted hover:text-henry-text transition-all">
                Cancel
              </button>
              <button onClick={() => void saveDraft()} disabled={!editing.name.trim()}
                className="flex-1 py-2.5 rounded-xl bg-henry-accent text-white font-semibold disabled:opacity-40 hover:bg-henry-accent/80 transition-all">
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
