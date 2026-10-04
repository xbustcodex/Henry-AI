/**
 * Henry AI — reusable empty state and skeleton loader components
 */

interface HenryEmptyProps {
  icon: string;
  title: string;
  subtitle?: string;
  action?: { label: string; onClick: () => void };
}

export function HenryEmpty({ icon, title, subtitle, action }: HenryEmptyProps) {
  return (
    <div className="henry-empty animate-fade-in">
      <span className="text-4xl">{icon}</span>
      <div>
        <p className="text-sm font-medium text-henry-text-dim">{title}</p>
        {subtitle && <p className="text-xs text-henry-text-muted mt-1">{subtitle}</p>}
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="henry-btn mt-1 text-xs px-3 py-1.5 rounded-lg bg-henry-accent/10 text-henry-accent border border-henry-accent/20 hover:bg-henry-accent/20 transition-all"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export function HenrySkeleton({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  const widths = ['w-3/4', 'w-full', 'w-5/6', 'w-2/3', 'w-4/5'];
  return (
    <div className={`space-y-2 p-4 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className={`henry-skeleton h-3 ${widths[i % widths.length]}`} />
      ))}
    </div>
  );
}

export function HenryErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-3 mx-4 my-2 px-3 py-2.5 rounded-xl bg-henry-error/10 border border-henry-error/20 animate-fade-in">
      <svg className="w-4 h-4 text-henry-error shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <p className="text-xs text-henry-error flex-1">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="henry-btn text-[10px] px-2 py-1 rounded-lg bg-henry-error/10 text-henry-error border border-henry-error/20 hover:bg-henry-error/20 transition-all"
        >
          Retry
        </button>
      )}
    </div>
  );
}
