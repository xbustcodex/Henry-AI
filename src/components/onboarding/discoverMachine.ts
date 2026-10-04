import { isLinux, isMacOS, isWindows } from '../../utils/platform';
import { opencodeProviderIdForModel, OPENCODE_ZEN_PROVIDER_ID } from '../../../electron/providers/classification';
import type { OpencodeModelInfo } from '../../types';
import type { OllamaModelCatalogue } from '../../../electron/ipc/ollamaCapabilities';
import type { MachineDiscovery, Platform } from './stages';

interface DiscoveryBridge {
  ollamaModels?: (baseUrl?: string) => Promise<OllamaModelCatalogue>;
  ollamaIsInstalled?: () => Promise<{ installed: boolean; running: boolean }>;
  opencodeStatus?: () => Promise<{ available: boolean }>;
  opencodeModels?: () => Promise<{ ok: boolean; models: OpencodeModelInfo[] }>;
}

function bridge(): DiscoveryBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.henryAPI as unknown as DiscoveryBridge | undefined;
}

function currentPlatform(): Platform {
  if (isMacOS()) return 'macos';
  if (isLinux()) return 'linux';
  if (isWindows()) return 'windows';
  return 'web';
}

/**
 * What is actually on this machine, asked of the things that are actually
 * running.
 *
 * Every field here is a fact somebody can disagree with — Ollama is or is not
 * listening, opencode is or is not installed, and the model ids are whatever
 * the runtime reported this second. Nothing is inferred from a name, and
 * nothing is assumed to be present because the platform usually has it: an
 * install that finds no Ollama and no opencode offers neither, and says why.
 */
export async function discoverMachine(): Promise<MachineDiscovery> {
  const api = bridge();
  const discovery: MachineDiscovery = {
    platform: currentPlatform(),
    ollamaInstalled: false,
    localModelIds: [],
    opencodeInstalled: false,
    zenModelIds: [],
  };

  if (!api) return discovery;

  const [ollama, opencode] = await Promise.all([
    api.ollamaModels?.().catch(() => undefined) ?? Promise.resolve(undefined),
    api.opencodeStatus?.().catch(() => undefined) ?? Promise.resolve(undefined),
  ]);

  if (ollama?.models?.length) {
    discovery.ollamaInstalled = true;
    discovery.localModelIds = ollama.models.map((model) => model.id);
  } else {
    // Ollama can be installed but not running; that still counts as present,
    // because the stage that starts it is different from the stage that picks
    // a model out of what it holds.
    const installed = await api.ollamaIsInstalled?.().catch(() => undefined);
    discovery.ollamaInstalled = installed?.installed === true;
  }

  if (opencode?.available) {
    discovery.opencodeInstalled = true;
    const models = await api.opencodeModels?.().catch(() => undefined);
    if (models?.ok) {
      discovery.zenModelIds = models.models
        .filter((model) => opencodeProviderIdForModel(model) === OPENCODE_ZEN_PROVIDER_ID)
        .map((model) => model.id);
    }
  }

  return discovery;
}