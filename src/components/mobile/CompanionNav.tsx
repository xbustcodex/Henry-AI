/**
 * Companion Bottom Navigation Bar
 */

import type { CompanionView } from './CompanionApp';

const TABS: {
  id: CompanionView;
  label: string;
  icon: string;
}[] = [
  { id: 'home', label: 'Home', icon: '🏠' },
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'tasks', label: 'Tasks', icon: '📋' },
  { id: 'capture', label: 'Capture', icon: '✦' },
  { id: 'approvals', label: 'Approvals', icon: '⚡' },
];

interface Props {
  current: CompanionView;
  onNavigate: (view: CompanionView) => void;
  approvalCount?: number;
}

export default function CompanionNav({ current, onNavigate, approvalCount = 0 }: Props) {
  return (
    <nav
      className="shrink-0 flex items-stretch bg-henry-surface/95 backdrop-blur-md border-t border-henry-border/40"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {TABS.map((tab) => {
        const isActive = current === tab.id;
        const hasBadge = tab.id === 'approvals' && approvalCount > 0;

        return (
          <button
            key={tab.id}
            onClick={() => onNavigate(tab.id)}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 min-h-[56px] transition-colors relative ${
              isActive ? 'text-henry-accent' : 'text-henry-text-muted active:text-henry-text'
            }`}
          >
            {tab.id === 'capture' ? (
              <div className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                isActive ? 'bg-henry-accent' : 'bg-henry-surface border border-henry-border/40'
              }`}>
                <span className={`text-lg leading-none ${isActive ? 'text-white' : ''}`}>✦</span>
              </div>
            ) : (
              <span className="text-[22px] leading-none relative">
                {tab.icon}
                {hasBadge && (
                  <span className="absolute -top-1 -right-2 min-w-[16px] h-4 bg-henry-error rounded-full text-[9px] text-white font-bold flex items-center justify-center px-1 leading-none">
                    {approvalCount > 9 ? '9+' : approvalCount}
                  </span>
                )}
              </span>
            )}
            <span className="text-[10px] font-medium tracking-wide">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
