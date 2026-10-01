export function Loading() {
  return (
    <div className="state-block" role="status" aria-label="Loading">
      <div className="spinner" aria-hidden="true" />
      <p>Loading…</p>
    </div>
  );
}

interface MessageStateProps {
  icon: string;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, hint, action }: MessageStateProps) {
  return (
    <div className="state-block">
      <div className="state-icon" aria-hidden="true">
        {icon}
      </div>
      <h2 className="state-title">{title}</h2>
      {hint && <p className="state-hint">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ title, hint }: Omit<MessageStateProps, "icon" | "action">) {
  return (
    <div className="state-block">
      <div className="state-icon" aria-hidden="true">
        ⚠️
      </div>
      <h2 className="state-title">{title}</h2>
      {hint && <p className="state-hint">{hint}</p>}
    </div>
  );
}
