import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WelcomeStep from './WelcomeStep';
import ProviderStep from './ProviderStep';
import CompleteStep from './CompleteStep';
import HowItWorksStage from '../onboarding/stages/HowItWorksStage';
import PermissionsStage from '../onboarding/stages/PermissionsStage';
import CompanionStage from '../onboarding/stages/CompanionStage';
import PanelsStage from '../onboarding/stages/PanelsStage';
import MemoryStage from '../onboarding/stages/MemoryStage';
import { discoverMachine } from '../onboarding/discoverMachine';
import {
  StageScreen,
  StageNote,
  STAGE_PROSE_WIDTH,
  STAGE_PROSE_LEADING,
} from '../onboarding/layout';
import {
  buildStagePlan,
  availableStages,
  firstStageId,
  nextStageId,
  previousStageId,
  blockingReason,
  EMPTY_DISCOVERY,
  type StageId,
  type StagePlanEntry,
  type MachineDiscovery,
} from '../onboarding/stages';
import { markFirstRunComplete } from '../../firstRun';
import { useStore } from '../../store';

export type { StageId } from '../onboarding/stages';

interface Props {

  /** Called once the user reaches the end of the flow. */
  onComplete?: () => void;
}

/**
 * The first-launch flow.
 *
 * One machine, one stage list (`../onboarding/stages`), shared with the
 * onboarding overlay — the two wizards used to be separate machines with
 * separate lists, which is why a fresh install and a relaunch showed the user
 * different things.
 *
 * It never completes itself. Nothing here picks a provider, fills in a model, or
 * advances past the one stage that the product cannot work without; the user
 * makes every decision and takes every skip.
 */
export default function SetupWizard({ onComplete }: Props) {
  const { settings, providers } = useStore();
  const [discovery, setDiscovery] = useState<MachineDiscovery | null>(null);
  const [stageId, setStageId] = useState<StageId | null>(null);
  const [skipped, setSkipped] = useState<StageId[]>([]);

  // Completing must happen once. Two paths into `done` — a double click, or a
  // re-render while the finish write is in flight — used to run the whole
  // completion sequence twice.
  const finished = useRef(false);

  // The plan is built from real discovery, never from the empty placeholder:
  // `EMPTY_DISCOVERY` claims the platform is `web`, and latching a stage onto
  // it is how a macOS user got the Linux stage list.
  const plan = useMemo(() => buildStagePlan(discovery ?? EMPTY_DISCOVERY), [discovery]);
  const walkable = useMemo(() => availableStages(plan), [plan]);
  const currentEntry: StagePlanEntry | undefined = plan.find((entry) => entry.id === stageId);

  useEffect(() => {
    let cancelled = false;
    void discoverMachine().then((found) => { if (!cancelled) setDiscovery(found); });
    return () => { cancelled = true; };
  }, []);

  // The first stage is chosen once discovery has been read, so a macOS user is
  // never flashed the Linux stage list first.
  useEffect(() => {
    if (stageId || !discovery) return;
    setStageId(firstStageId(plan) ?? 'welcome');
  }, [plan, stageId, discovery]);

  const aiChoice = useMemo(() => {
    const providerId = settings.companion_provider?.trim() ?? '';
    const modelId = settings.companion_model?.trim() ?? '';
    const row = providers.find((p) => p.id === providerId);
    const hasCredential = Boolean(row?.apiKey?.trim());
    // Local Ollama answers without a credential, and so do free Zen models —
    // those are the only two that may satisfy this stage without a key.
    const credentialRequired = Boolean(providerId) && providerId !== 'ollama' && providerId !== 'opencode-zen' && !hasCredential;
    return { providerId, modelId, credentialRequired, hasCredential };
  }, [settings.companion_provider, settings.companion_model, providers]);

  const blocked = stageId ? blockingReason(plan, stageId, aiChoice) : null;

  const advance = useCallback(() => {
    setStageId((current) => (current ? nextStageId(plan, current) : null));
  }, [plan]);

  const retreat = useCallback(() => {
    setStageId((current) => (current ? previousStageId(plan, current) : null));
  }, [plan]);

  const skip = useCallback((id: StageId) => {
    setSkipped((prev) => (prev.includes(id) ? prev : [...prev, id]));
    advance();
  }, [advance]);

  function finish() {
    if (finished.current) return;
    finished.current = true;
    markFirstRunComplete();
    onComplete?.();
  }

  if (!stageId) {
    // Discovery is still in flight. Showing anything before it resolves would
    // mean offering a provider this machine does not have.
    return <div className="h-screen w-screen bg-henry-bg" />;
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-henry-bg">
      <div className="titlebar-drag h-12 shrink-0" />

      {/* The one place that scrolls. A stage is never given a viewport height of
          its own: at 125% display scaling or a short window the content simply
          grows and this frame — not the cards — takes the overflow. `min-h-0`
          is what lets the flex child shrink and scroll instead of pushing the
          titlebar off the window. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="w-full max-w-2xl mx-auto px-6 py-12">
          <StageProgress
            stages={walkable.filter((stage) => stage.id !== 'done')}
            current={stageId}
            skipped={skipped}
          />

          <div className="animate-fade-in">
            {stageId === 'welcome' && (
              <WelcomeStep onNext={advance} />
            )}
            {stageId === 'howItWorks' && (
              <HowItWorksStage onNext={advance} onSkip={() => skip('howItWorks')} />
            )}
            {stageId === 'accessibility' && (
              <PermissionsStage kind="accessibility" onNext={advance} onSkip={() => skip('accessibility')} />
            )}
            {stageId === 'screen' && (
              <PermissionsStage kind="screen" onNext={advance} onSkip={() => skip('screen')} />
            )}
            {stageId === 'ai' && (
              <StageScreen>
                {currentEntry?.requiredBecause && (
                  <p
                    className={`text-center text-sm text-henry-text-muted ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH} mx-auto`}
                  >
                    {currentEntry.requiredBecause}
                  </p>
                )}
                <ProviderStep
                  onNext={advance}
                  onBack={retreat}
                  note={
                    blocked ? <StageNote tone="warning">{blocked}</StageNote> : undefined
                  }
                />
              </StageScreen>
            )}
            {stageId === 'companion' && (
              <CompanionStage onNext={advance} onSkip={() => skip('companion')} />
            )}
            {stageId === 'panels' && (
              <PanelsStage onNext={advance} onSkip={() => skip('panels')} />
            )}
            {stageId === 'memory' && (
              <MemoryStage onNext={advance} onSkip={() => skip('memory')} />
            )}
            {stageId === 'done' && (
              <CompleteStep
                onBack={retreat}
                onDone={finish}
                outcome={{
                  provider: aiChoice.providerId,
                  model: aiChoice.modelId,
                  hasCredential: aiChoice.hasCredential,
                  localModels: discovery?.localModelIds.length ?? 0,
                  opencodeInstalled: discovery?.opencodeInstalled ?? false,
                  skipped,
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StageProgress({
  stages,
  current,
  skipped,
}: {
  stages: StagePlanEntry[];
  current: StageId;
  skipped: StageId[];
}) {
  const index = stages.findIndex((stage) => stage.id === current);
  if (index < 0) return null;
  return (
    <div className="flex items-center justify-center gap-3 mb-14" aria-label="Setup progress">
      {stages.map((stage, i) => (
        <div
          key={stage.id}
          title={stage.title}
          className={`transition-all rounded-full ${
            i === index
              ? 'w-6 h-2 bg-henry-accent'
              : stage.required
              ? 'w-2 h-2 bg-henry-error/70'
              : i < index && skipped.includes(stage.id)
              ? 'w-2 h-2 bg-henry-border'
              : 'w-2 h-2 bg-henry-success/50'
          }`}
        />
      ))}
    </div>
  );
}