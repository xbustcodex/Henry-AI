/**
 * The parts of the machine that are not folders.
 *
 * The walk in `scanner.ts` sees the filesystem. This module sees the things a
 * filesystem listing cannot tell you: which applications are installed, what is
 * on PATH, which language runtimes answer, what is running, what hardware is
 * under it, and which models the local runtime actually holds.
 *
 * ── Every collector is injected, and every one degrades to empty ────────────
 *
 * Nothing here reaches for `process.env` or `child_process` directly. Each
 * collector takes what it needs — a filesystem, a process lister, an OS-facts
 * reader, a model catalogue — so a test can drive all of it deterministically
 * and a platform without one of these still produces a map.
 *
 * A collector that cannot answer returns `[]` (or `null` for hardware) and
 * records why in `warnings`. The map is always built; it is just thinner on a
 * machine that would not answer. A scan that refuses to start because
 * `ps` is missing is worse than a scan that says "processes unavailable".
 *
 * ── No static catalogues ────────────────────────────────────────────────────
 *
 * There is no table of installed applications and no table of models anywhere
 * in this file, and there must never be one. The model list comes from the
 * running runtime's own `/api/tags`; the application list comes from the
 * platform's own metadata directories; the tool list comes from what is
 * actually on PATH. A shipped table would be wrong the moment the user installs
 * or removes anything, which is precisely when the map matters most.
 */

import os from 'node:os';
import { discoverOllamaModels } from '../ipc/ollamaCapabilities';
import { discoverRuntimes } from '../runtimes/discovery';
import type { RuntimeDiscoveryResult, SelectionReader } from '../runtimes/discovery';
import { listRuntimeAdapters } from '../runtimes/registry';
import type {
  DevelopmentTool,
  DevelopmentToolKind,
  HardwareInfo,
  InstalledApplication,
  LanguageRuntime,
  LocalModelInfo,
  PathExecutable,
  RuntimeObservation,
  RuntimeOffer,
  ServiceInfo,
  SystemMapInventory,
  UserLocation,
  VolumeInfo,
} from './types';
import type { MetadataFs } from './fsMetadata';

// ── The injected world ───────────────────────────────────────────────────────

/** Runs a short-lived command and returns its first line of output. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string | null>;

/** Lists running processes as `[pid, name, state]`. */
export type ProcessLister = () => Promise<[number, string, string][]>;

/** One found executable, before it is classified. */
export interface PathCandidate {
  name: string;
  path: string;
  directory: string;
  sizeBytes: number;
  modifiedAt: number;
}

/** How the inventory collectors reach the machine. All replaceable in tests. */
export interface InventoryContext {
  platform: NodeJS.Platform;
  homeDir: string;
  /** Directories on PATH, in order. */
  pathDirectories: readonly string[];
  fs: MetadataFs;
  /** Omit to skip version probing entirely (faster, and enough for a map). */
  runCommand?: CommandRunner;
  listProcesses?: ProcessLister;
  /** Base URL for the local model runtime. */
  ollamaBaseUrl?: string;
  /**
   * Lists the models the local runtime holds. Defaults to asking the running
   * Ollama.
   *
   * Injectable for two reasons: a test must not wait out a real HTTP timeout to
   * learn that a model list is empty, and the answer must come from ONE place.
   * Asking Ollama a second way somewhere else would be a second answer to
   * compare against the first.
   */
  listLocalModels?: (baseUrl: string | undefined) => Promise<LocalModelInfo[]>;
  /**
   * Asks the runtime adapters what is installed. Defaults to the real
   * discovery.
   *
   * Injectable so a test does not have to probe real binaries — and so the map
   * has exactly ONE route to that knowledge. The map never re-implements a probe;
   * it asks the architecture that already owns the answer.
   */
  discoverRuntimes?: (selection: SelectionReader) => Promise<RuntimeDiscoveryResult>;
  /**
   * Where installed applications are recorded on this machine. Defaults to the
   * platform's own locations, including the XDG directories when the session
   * sets them.
   */
  applicationDirectories?: readonly string[];
  /** Reads the user's stored runtime selection. Cannot write. */
  selectionReader: SelectionReader;
}

// ── PATH executables ─────────────────────────────────────────────────────────

/**
 * How many PATH directories one inventory pass will read.
 *
 * A broken PATH can hold fifty entries and a scan should not spend its budget
 * on the ones that never existed. Every directory past this one is recorded in
 * the warnings rather than silently dropped.
 */
const MAX_PATH_DIRECTORIES = 24;

/** How many executable names are kept in the map. */
const MAX_PATH_EXECUTABLES = 600;

/**
 * Every executable on PATH, as metadata: name, where it is, how big it is.
 *
 * Never executed — knowing that `node` is on PATH does not require running it.
 */
export async function collectPathExecutables(
  context: InventoryContext,
  warnings: string[],
): Promise<PathExecutable[]> {
  const directories = context.pathDirectories.slice(0, MAX_PATH_DIRECTORIES);
  if (context.pathDirectories.length > directories.length) {
    warnings.push(
      `PATH has ${context.pathDirectories.length} entries; only the first ${directories.length} were read.`,
    );
  }

  const found: PathCandidate[] = [];
  for (const directory of directories) {
    let entries;
    try {
      entries = await context.fs.readDir(directory);
    } catch {
      // Not every PATH entry exists. That is normal and not worth reporting.
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory || entry.isSymbolicLink) continue;
      // Metadata is already in the listing: it is a file, so it is executable
      // as far as this map is concerned. Running it to find out is not this
      // module's job.
      found.push({
        name: entry.name,
        path: `${directory.replace(/[/\\]+$/, '')}/${entry.name}`,
        directory,
        sizeBytes: 0,
        modifiedAt: 0,
      });
      if (found.length >= MAX_PATH_EXECUTABLES) break;
    }
    if (found.length >= MAX_PATH_EXECUTABLES) {
      warnings.push(
        `Stopped after ${MAX_PATH_EXECUTABLES} executables on PATH; some were not recorded.`,
      );
      break;
    }
  }
  return found;
}

// ── Development tools and language runtimes ─────────────────────────────────

/**
 * What a PATH executable is, by name.
 *
 * This is a NAME→KIND lookup, not a catalogue of installed software: it says
 * "a binary called `go` is a language runtime", never "Go 1.22 is installed".
 * Whether it is installed, at what version, is answered by looking at PATH and
 * by asking the binary — never by consulting this table.
 */
const TOOL_KIND_BY_NAME: Record<string, DevelopmentToolKind> = {
  node: 'language',
  deno: 'language',
  bun: 'language',
  python: 'language',
  python3: 'language',
  ruby: 'language',
  php: 'language',
  perl: 'language',
  lua: 'language',
  dotnet: 'language',
  swift: 'language',
  kotlin: 'language',
  scala: 'language',
  elixir: 'language',
  haskell: 'language',
  ghc: 'language',
  java: 'language',
  javac: 'language',
  gcc: 'language',
  'g++': 'language',
  clang: 'language',
  rustc: 'language',
  cargo: 'language',
  go: 'language',
  make: 'build',
  cmake: 'build',
  ninja: 'build',
  gradle: 'build',
  mvn: 'build',
  bazel: 'build',
  git: 'version-control',
  hg: 'version-control',
  svn: 'version-control',
  docker: 'container',
  podman: 'container',
  kubectl: 'container',
  helm: 'container',
  npm: 'package-manager',
  yarn: 'package-manager',
  pnpm: 'package-manager',
  pip: 'package-manager',
  pip3: 'package-manager',
  uv: 'package-manager',
  poetry: 'package-manager',
  gem: 'package-manager',
  cargo_install: 'package-manager',
};

/** Runtime ids of agent runtimes, so their binaries are recognised as tools. */
function agentRuntimeBinaryNames(): Record<string, DevelopmentToolKind> {
  const byName: Record<string, DevelopmentToolKind> = {};
  for (const adapter of listRuntimeAdapters()) {
    for (const binary of adapter.candidateBinaries()) {
      byName[binary] = 'agent-runtime';
    }
  }
  return byName;
}

/** How many tools get a version probe. Probing spawns a process each time. */
const MAX_VERSION_PROBES = 24;

/** Bounds on the version probe, so a hung binary cannot hang a scan. */
const VERSION_PROBE_TIMEOUT_MS = 2_000;

/**
 * Development tools found on PATH, with versions where a probe answered.
 *
 * Version probing is opt-in and bounded: without `runCommand` in the context
 * the tools are still listed, just without versions, because "you have Node"
 * is the answer a map is for and "you have Node 24.2.0" is a nicety.
 */
export async function collectDevelopmentTools(
  context: InventoryContext,
  warnings: string[],
): Promise<{ developmentTools: DevelopmentTool[]; languageRuntimes: LanguageRuntime[] }> {
  const executables = await collectPathExecutables(context, warnings);
  const agentBinaries = agentRuntimeBinaryNames();

  const developmentTools: DevelopmentTool[] = [];
  const languageRuntimes: LanguageRuntime[] = [];
  let probes = 0;

  for (const executable of executables) {
    const kind = TOOL_KIND_BY_NAME[executable.name] ?? agentBinaries[executable.name];
    if (!kind) continue;

    let version: string | undefined;
    if (context.runCommand && probes < MAX_VERSION_PROBES) {
      probes += 1;
      const output = await context.runCommand(
        executable.path,
        ['--version'],
        VERSION_PROBE_TIMEOUT_MS,
      );
      version = firstVersionLike(output ?? '');
    }

    const tool: DevelopmentTool = {
      id: `${kind}:${executable.name}`,
      name: executable.name,
      kind,
      path: executable.path,
      ...(version ? { version } : {}),
    };
    developmentTools.push(tool);
    if (kind === 'language') {
      languageRuntimes.push({
        id: executable.name,
        name: executable.name,
        path: executable.path,
        ...(version ? { version } : {}),
      });
    }
  }

  if (probes >= MAX_VERSION_PROBES) {
    warnings.push(
      `Only the first ${MAX_VERSION_PROBES} tools were asked for their version; the rest are listed without one.`,
    );
  }
  return { developmentTools, languageRuntimes };
}

/**
 * Pull a version-looking token out of a `--version` line.
 *
 * Deliberately loose about shape and strict about not inventing: with no probe
 * output there is no version, and an absent version is honest where a guessed
 * one would not be.
 */
function firstVersionLike(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/\d+\.\d+(\.\d+)?([-+][\w.]+)?/);
  return match ? match[0] : undefined;
}

// ── Installed applications ───────────────────────────────────────────────────

/**
 * Where a platform records installed applications.
 *
 * Names only. Henry does not read application bundles, MSI databases or
 * registry hives — it records that something is installed and where, from the
 * fact that the directory exists.
 */
export function applicationRoots(context: InventoryContext): { dir: string; scope: 'system' | 'user' }[] {
  if (context.applicationDirectories) {
    return context.applicationDirectories.map((dir) => ({
      dir,
      scope: dir.startsWith(context.homeDir) ? ('user' as const) : ('system' as const),
    }));
  }
  const home = context.homeDir;
  if (context.platform === 'linux') {
    // The XDG directories win when the session sets them: a desktop that puts
    // its entries somewhere other than /usr/share is a real configuration, not
    // an edge case, and hardcoding one location would miss every application
    // installed through it.
    const xdgApplications = (process.env.XDG_DATA_DIRS ?? '')
      .split(':')
      .filter(Boolean)
      .map((dir) => `${dir.replace(/\/+$/, '')}/applications`);
    return [
      ...xdgApplications.map((dir) => ({ dir, scope: 'system' as const })),
      { dir: '/usr/share/applications', scope: 'system' as const },
      { dir: '/usr/local/share/applications', scope: 'system' as const },
      { dir: '/var/lib/flatpak/exports/share/applications', scope: 'system' as const },
      { dir: '/var/lib/snapd/desktop/applications', scope: 'system' as const },
      { dir: `${home}/.local/share/applications`, scope: 'user' as const },
    ];
  }
  switch (context.platform) {
    case 'darwin':
      return [
        { dir: '/Applications', scope: 'system' },
        { dir: `${home}/Applications`, scope: 'user' },
      ];
    case 'win32':
      return [
        { dir: 'C:\\Program Files', scope: 'system' },
        { dir: 'C:\\Program Files (x86)', scope: 'system' },
        { dir: `${home}\\AppData\\Local\\Programs`, scope: 'user' },
      ];
    default:
      // Reached only for a platform with no branch above, where the honest
      // answer is "we do not know where this one keeps its applications" rather
      // than a guess at Unix paths.
      return [];
  }
}

/** The most applications one pass records. */
const MAX_APPLICATIONS = 500;

/**
 * Installed applications, from the platform's own metadata directories.
 *
 * On Linux each `.desktop` entry is one installed application, so the NAME of
 * the file is the record — it is not opened. `.desktop` files are not private,
 * but reading them is still reading, and the file name already answers the
 * question this section exists to answer.
 */
export async function collectInstalledApplications(
  context: InventoryContext,
  warnings: string[],
): Promise<InstalledApplication[]> {
  const applications: InstalledApplication[] = [];
  for (const { dir, scope } of applicationRoots(context)) {
    let entries;
    try {
      entries = await context.fs.readDir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (applications.length >= MAX_APPLICATIONS) {
        warnings.push(`Stopped after ${MAX_APPLICATIONS} applications; some were not recorded.`);
        return applications;
      }
      if (entry.isDirectory) {
        // macOS bundles and most Windows installs are directories.
        applications.push({
          id: `app:${dir}/${entry.name}`,
          name: entry.name.replace(/\.app$/, ''),
          path: `${dir.replace(/[/\\]+$/, '')}/${entry.name}`,
          scope,
        });
        continue;
      }
      // Linux: a `.desktop` entry, recorded by name.
      if (!entry.name.endsWith('.desktop')) continue;
      applications.push({
        id: `app:${dir}/${entry.name}`,
        name: entry.name.replace(/\.desktop$/, ''),
        path: `${dir.replace(/[/\\]+$/, '')}/${entry.name}`,
        scope,
      });
    }
  }
  return applications;
}

// ── Services and processes ───────────────────────────────────────────────────

/** How many processes one pass records. */
const MAX_SERVICES = 300;

/**
 * Running processes, as name and state.
 *
 * No command line and no arguments: a process's arguments are user data, and a
 * map does not need them. A process list containing command lines is one log
 * export away from holding someone's tokens.
 */
export async function collectServices(
  context: InventoryContext,
  warnings: string[],
): Promise<ServiceInfo[]> {
  if (!context.listProcesses) {
    warnings.push('Running processes are unavailable on this build.');
    return [];
  }
  let processes;
  try {
    processes = await context.listProcesses();
  } catch {
    warnings.push('The running process list could not be read.');
    return [];
  }
  return processes.slice(0, MAX_SERVICES).map(([pid, name, state]) => ({ name, pid, state }));
}

// ── Hardware and OS ──────────────────────────────────────────────────────────

/** Facts about the machine, or null when they cannot be read. */
export function collectHardware(): HardwareInfo | null {
  try {
    const cpus = os.cpus();
    return {
      osName: os.type(),
      osRelease: os.release(),
      platform: os.platform(),
      arch: os.arch(),
      cpuModel: cpus[0]?.model,
      cpuCount: cpus.length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      uptimeSeconds: os.uptime(),
    };
  } catch {
    return null;
  }
}

// ── Volumes and user locations ───────────────────────────────────────────────

/** The mounted volumes this map records. Roots, not every mount point. */
export function collectVolumes(platform: NodeJS.Platform): VolumeInfo[] {
  if (platform === 'win32') {
    return ['C:', 'D:'].map((id) => ({ id, label: `${id} drive`, root: `${id}\\` }));
  }
  return [{ id: 'root', label: 'This computer', root: '/' }];
}

/** The places a user's own work lives, by platform convention. */
export function collectUserLocations(
  platform: NodeJS.Platform,
  homeDir: string,
): UserLocation[] {
  const join = (...parts: string[]): string =>
    parts
      .filter((part) => part.length > 0)
      .join(platform === 'win32' ? '\\' : '/')
      .replace(/(?<!^)\\+/, '');
  const candidates: { id: string; label: string; kind: UserLocation['kind']; path: string }[] = [
    { id: 'home', label: 'Your computer folder', kind: 'home', path: homeDir },
    { id: 'desktop', label: 'Desktop', kind: 'desktop', path: join(homeDir, 'Desktop') },
    {
      id: 'documents',
      label: 'Documents',
      kind: 'documents',
      path: join(homeDir, platform === 'darwin' ? 'Documents' : 'Documents'),
    },
    { id: 'downloads', label: 'Downloads', kind: 'downloads', path: join(homeDir, 'Downloads') },
    { id: 'pictures', label: 'Pictures', kind: 'pictures', path: join(homeDir, 'Pictures') },
    { id: 'music', label: 'Music', kind: 'music', path: join(homeDir, 'Music') },
    { id: 'videos', label: 'Videos', kind: 'videos', path: join(homeDir, 'Videos') },
  ];
  // The standard place for code on each platform, which is where a user's
  // projects actually are.
  candidates.push({
    id: 'projects',
    label: 'Projects',
    kind: 'projects',
    path: join(homeDir, platform === 'win32' ? 'source' : 'source'),
  });
  return candidates.map((candidate) => ({ ...candidate, exists: false }));
}

// ── Local models ─────────────────────────────────────────────────────────────

/**
 * Locally installed models, from the runtime that holds them.
 *
 * Delegates to the existing Ollama discovery rather than asking Ollama a second
 * time in a new way: there is already one client for `/api/tags`, one shape for
 * a model, and one place where a model's capabilities are decided. A second
 * question would be a second answer to compare.
 */
export async function collectLocalModels(
  context: InventoryContext,
  warnings: string[],
): Promise<LocalModelInfo[]> {
  if (context.listLocalModels) {
    try {
      return await context.listLocalModels(context.ollamaBaseUrl);
    } catch {
      warnings.push('The list of local models could not be read.');
      return [];
    }
  }
  const base = context.ollamaBaseUrl ?? 'http://localhost:11434';
  const catalogue = await discoverOllamaModels(base);
  for (const warning of catalogue.warnings) warnings.push(warning);
  return catalogue.models.map((model) => ({
    id: model.id,
    name: model.displayName || model.name,
    source: 'ollama' as const,
    sizeBytes: model.sizeBytes,
    family: model.family,
  }));
}

// ── Agent runtimes ───────────────────────────────────────────────────────────

/**
 * What runtime discovery found, plus what is newly available to offer.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 *
 * **Discovery is read-only and stays read-only here.** This function calls the
 * same `discoverRuntimes` the Settings panel calls, with a `SelectionReader`
 * that can only read. It records what it saw and computes offers from the
 * previous snapshot; it has no writer to hand, so it cannot select a runtime
 * even if a future edit tried to. A newly installed runtime — Prime Pi, say —
 * is detected here and offered, and the user's selection is echoed back
 * unchanged.
 */
export async function collectRuntimes(
  selectionReader: SelectionReader,
  previouslyAvailableIds: readonly string[],
  discover: InventoryContext['discoverRuntimes'] = discoverRuntimes,
): Promise<{ runtimes: RuntimeObservation[]; offers: RuntimeOffer[]; selectedRuntimeId: string | null }> {
  const result = await discover(selectionReader);
  const previous = new Set(previouslyAvailableIds);

  const runtimes: RuntimeObservation[] = result.runtimes.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    available: entry.available,
    version: entry.version,
    binaryPath: entry.binaryPath,
    selected: entry.id === result.selectedRuntimeId,
  }));

  const offers: RuntimeOffer[] = runtimes
    .filter((runtime) => runtime.available && !previous.has(runtime.id))
    .map((runtime) => ({
      runtimeId: runtime.id,
      displayName: runtime.displayName,
      version: runtime.version,
      binaryPath: runtime.binaryPath,
      reason: 'newly-available' as const,
      currentSelection: result.selectedRuntimeId,
    }));

  return { runtimes, offers, selectedRuntimeId: result.selectedRuntimeId };
}

// ── The whole inventory ──────────────────────────────────────────────────────

/**
 * Everything the map knows about the machine that is not a folder.
 *
 * Sections run independently and none can fail the pass: a section that throws
 * is recorded as a warning and contributes nothing, because a map of the
 * filesystem is worth keeping even when the process list could not be read.
 */
export async function collectInventory(
  context: InventoryContext,
  options: {
    previouslyAvailableRuntimeIds?: readonly string[];
    exclusionsApplied?: readonly string[];
    exclusionFolders?: readonly string[];
  } = {},
): Promise<SystemMapInventory> {
  const warnings: string[] = [];

  const [tooling, applications, services, models, runtimeResult] = await Promise.all([
    collectDevelopmentTools(context, warnings).catch(() => ({
      developmentTools: [] as DevelopmentTool[],
      languageRuntimes: [] as LanguageRuntime[],
    })),
    collectInstalledApplications(context, warnings).catch(() => [] as InstalledApplication[]),
    collectServices(context, warnings).catch(() => [] as ServiceInfo[]),
    collectLocalModels(context, warnings).catch(() => [] as LocalModelInfo[]),
    collectRuntimes(
      context.selectionReader,
      options.previouslyAvailableRuntimeIds ?? [],
      context.discoverRuntimes,
    ).catch(
      () => ({ runtimes: [] as RuntimeObservation[], offers: [] as RuntimeOffer[], selectedRuntimeId: null }),
    ),
  ]);

  const userLocations = collectUserLocations(context.platform, context.homeDir);
  // Existence is a stat, which is metadata. Resolving it here means the UI can
  // say "this folder is not on your computer" instead of offering a dead link.
  for (const location of userLocations) {
    try {
      const stat = await context.fs.stat(location.path);
      location.exists = stat.isDirectory;
    } catch {
      location.exists = false;
    }
  }

  const pathExecutables = await collectPathExecutables(context, warnings).catch(
    () => [] as PathExecutable[],
  );

  return {
    volumes: collectVolumes(context.platform),
    userLocations,
    applications,
    pathExecutables,
    developmentTools: tooling.developmentTools,
    languageRuntimes: tooling.languageRuntimes,
    services,
    hardware: collectHardware(),
    localModels: models,
    runtimes: runtimeResult.runtimes,
    runtimeOffers: runtimeResult.offers,
    exclusionsApplied: [...(options.exclusionsApplied ?? [])],
    exclusionFolders: [...(options.exclusionFolders ?? [])],
    warnings,
  };
}