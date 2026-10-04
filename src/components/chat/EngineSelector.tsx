import { useStore } from '../../store';

interface EngineSelectorProps {
  selectedEngine: 'companion' | 'worker';
  onSelect: (engine: 'companion' | 'worker') => void;
}

export default function EngineSelector({
  selectedEngine,
  onSelect,
}: EngineSelectorProps) {
  const { settings } = useStore();

  const localIsCloud = settings.companion_provider !== 'ollama' && !!settings.companion_provider;
  const cloudIsLocal = settings.worker_provider === 'ollama';

  return (
    <div className="shrink-0 flex items-center gap-0.5 p-0.5 rounded-lg bg-henry-surface/50 border border-henry-border/30">
      <button
        onClick={() => onSelect('companion')}
        title="Local Brain — primary, always-on. Automatically hands heavy tasks to Worker while staying in the conversation."
        className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
          selectedEngine === 'companion'
            ? 'bg-henry-companion/15 text-henry-companion'
            : 'text-henry-text-muted hover:text-henry-text'
        }`}
      >
        <span>{localIsCloud ? '☁️' : '🧠'}</span>
        <span>Local</span>
      </button>
      <button
        onClick={() => onSelect('worker')}
        title="Worker Brain — background execution. Auto-activates for code and research tasks; result appears in the thread. Or route a message here manually."
        className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
          selectedEngine === 'worker'
            ? 'bg-henry-worker/15 text-henry-worker'
            : 'text-henry-text-muted hover:text-henry-text'
        }`}
      >
        <span>{cloudIsLocal ? '🧠' : '⚡'}</span>
        <span>Worker</span>
      </button>
    </div>
  );
}
