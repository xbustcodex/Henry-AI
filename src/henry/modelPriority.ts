/**
 * Henry's Model Priority Registry
 *
 * These ranked lists define which Ollama models Henry prefers for each brain.
 * Henry auto-selects the best model that's actually installed on your machine.
 *
 * To get a new model: run `ollama pull <model>` — Henry will detect it automatically.
 * To add a new model to the priority list: add it here in priority order.
 */

export interface ModelPriorityEntry {
  id: string;
  label: string;
  vramHint?: string;
}

// ── Companion Brain (Local Brain) priority ────────────────────────────────────
// Best for: streaming, real-time conversation, all 7 modes.
// Henry picks the highest-ranked model that is installed.
export const COMPANION_MODEL_PRIORITY: ModelPriorityEntry[] = [
  { id: 'llama3.3:70b',        label: 'Llama 3.3 70B (newest Meta)',     vramHint: '48GB+' },
  { id: 'llama3.3:latest',     label: 'Llama 3.3 (latest)',              vramHint: '48GB+' },
  { id: 'llama3.3',            label: 'Llama 3.3',                       vramHint: '48GB+' },
  { id: 'qwen2.5:32b',         label: 'Qwen 2.5 32B',                    vramHint: '24GB'  },
  { id: 'qwen2.5:14b',         label: 'Qwen 2.5 14B',                    vramHint: '10GB'  },
  { id: 'phi4:latest',         label: 'Phi-4 (latest)',                   vramHint: '10GB'  },
  { id: 'phi4',                label: 'Phi-4 14B',                        vramHint: '10GB'  },
  { id: 'mistral-nemo:latest', label: 'Mistral Nemo (latest)',            vramHint: '8GB'   },
  { id: 'mistral-nemo',        label: 'Mistral Nemo 12B',                 vramHint: '8GB'   },
  { id: 'qwen2.5:7b',          label: 'Qwen 2.5 7B',                     vramHint: '6GB'   },
  { id: 'llama3.1:8b',         label: 'Llama 3.1 8B',                    vramHint: '6GB'   },
  { id: 'mistral:latest',      label: 'Mistral (latest)',                 vramHint: '5GB'   },
  { id: 'mistral',             label: 'Mistral 7B',                       vramHint: '5GB'   },
  { id: 'llama3.2:3b',         label: 'Llama 3.2 3B (lightweight)',       vramHint: '3GB'   },
  { id: 'llama3.2:latest',     label: 'Llama 3.2 (latest)',               vramHint: '3GB'   },
  { id: 'llama3.2',            label: 'Llama 3.2',                        vramHint: '3GB'   },
  { id: 'llama3:latest',       label: 'Llama 3 (latest)',                 vramHint: '5GB'   },
  { id: 'llama3',              label: 'Llama 3',                          vramHint: '5GB'   },
];

// ── Companion secondary / fallback priority ───────────────────────────────────
// Henry tries these if the primary model fails or isn't found.
// Set companion_model_2 to provide a hot-standby model.
export const COMPANION_FALLBACK_PRIORITY: ModelPriorityEntry[] = [
  { id: 'qwen2.5:32b',         label: 'Qwen 2.5 32B',     vramHint: '24GB' },
  { id: 'qwen2.5:14b',         label: 'Qwen 2.5 14B',     vramHint: '10GB' },
  { id: 'qwen2.5:7b',          label: 'Qwen 2.5 7B',      vramHint: '6GB'  },
  { id: 'phi4',                label: 'Phi-4 14B',         vramHint: '10GB' },
  { id: 'mistral-nemo',        label: 'Mistral Nemo 12B',  vramHint: '8GB'  },
  { id: 'llama3.2:3b',         label: 'Llama 3.2 3B',      vramHint: '3GB'  },
];

// ── Worker Brain priority ─────────────────────────────────────────────────────
// Best for: deep reasoning, code generation, research, background tasks.
export const WORKER_MODEL_PRIORITY: ModelPriorityEntry[] = [
  { id: 'deepseek-r1:32b',     label: 'DeepSeek R1 32B (top reasoner)',  vramHint: '24GB' },
  { id: 'deepseek-r1:14b',     label: 'DeepSeek R1 14B',                 vramHint: '10GB' },
  { id: 'deepseek-r1:latest',  label: 'DeepSeek R1 (latest)',             vramHint: '10GB' },
  { id: 'deepseek-r1',         label: 'DeepSeek R1',                      vramHint: '10GB' },
  { id: 'qwen2.5:72b',         label: 'Qwen 2.5 72B',                    vramHint: '48GB' },
  { id: 'llama3.3:70b',        label: 'Llama 3.3 70B',                   vramHint: '48GB' },
  { id: 'llama3.3',            label: 'Llama 3.3',                        vramHint: '48GB' },
  { id: 'qwen2.5:32b',         label: 'Qwen 2.5 32B',                    vramHint: '24GB' },
  { id: 'deepseek-r1:7b',      label: 'DeepSeek R1 7B',                  vramHint: '6GB'  },
  { id: 'llama3.1:70b',        label: 'Llama 3.1 70B',                   vramHint: '48GB' },
  { id: 'codellama:34b',       label: 'CodeLlama 34B',                   vramHint: '24GB' },
  { id: 'gemma2:27b',          label: 'Gemma 2 27B',                     vramHint: '18GB' },
  { id: 'qwen2.5:14b',         label: 'Qwen 2.5 14B',                    vramHint: '10GB' },
];

/**
 * Given a list of installed Ollama model names (as returned by the API),
 * returns the highest-priority match from the given priority list.
 *
 * Matching is flexible: handles tags, size suffixes, and quantization labels.
 * e.g., "llama3.3:70b-instruct-q4_K_M" will match priority entry "llama3.3:70b"
 */
export function selectBestModel(
  installedModels: string[],
  priority: ModelPriorityEntry[]
): { id: string; label: string } | null {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '');

  for (const entry of priority) {
    const entryBase = normalize(entry.id).replace(/:latest$/, '');

    for (const installed of installedModels) {
      const instNorm = normalize(installed);
      // Exact match
      if (instNorm === normalize(entry.id)) return { id: installed, label: entry.label };
      // Installed starts with entry base (covers quantized variants like llama3.3:70b-q4)
      if (instNorm.startsWith(entryBase + ':') || instNorm === entryBase) {
        return { id: installed, label: entry.label };
      }
    }
  }
  return null;
}

/**
 * Auto-selects the best companion + worker model from what's currently installed in Ollama.
 * Returns null for any brain if nothing matching is found.
 */
export function autoSelectModels(installedModelNames: string[]): {
  companion: { id: string; label: string } | null;
  companionFallback: { id: string; label: string } | null;
  worker: { id: string; label: string } | null;
} {
  const companionBest = selectBestModel(installedModelNames, COMPANION_MODEL_PRIORITY);

  // For fallback, pick the next best that's different from the primary
  const fallbackPriority = COMPANION_FALLBACK_PRIORITY.filter(
    (e) => !companionBest || !e.id.startsWith(companionBest.id.split(':')[0])
  );
  const companionFallback = selectBestModel(installedModelNames, fallbackPriority);

  const workerBest = selectBestModel(installedModelNames, WORKER_MODEL_PRIORITY);

  return { companion: companionBest, companionFallback, worker: workerBest };
}
