import { WIZARD_STEPS } from "./steps";

interface StepperProps {
  current: number;
  maxReachable: number;
  onJump: (n: number) => void;
}

/**
 * Visual wizard stepper. Completed/reachable steps are clickable;
 * unreachable steps are visibly disabled. (Steps 5–7 were "coming
 * soon" placeholders before Phase 7; the `comingSoon` flag is kept
 * for any future phase that needs placeholders again.)
 */
export function Stepper({ current, maxReachable, onJump }: StepperProps) {
  return (
    <ol className="wizard-steps" aria-label="Create post progress">
      {WIZARD_STEPS.map((s) => {
        const reachable = s.n <= maxReachable && !s.comingSoon;
        const isCurrent = s.n === current;
        const isDone = s.n < current || (s.n < maxReachable && !isCurrent);
        const className = [
          "wizard-step",
          isCurrent ? "current" : "",
          isDone ? "done" : "",
          s.comingSoon ? "coming-soon" : "",
          reachable && !isCurrent ? "clickable" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <li key={s.id} className={className}>
            {reachable && !isCurrent ? (
              <button
                type="button"
                className="wizard-step-btn"
                onClick={() => onJump(s.n)}
                aria-label={`Go to step ${s.n}: ${s.label}`}
              >
                <span className="wizard-step-num" aria-hidden="true">
                  {isDone ? "✓" : s.n}
                </span>
                <span className="wizard-step-label">{s.label}</span>
              </button>
            ) : (
              <span className="wizard-step-static" aria-current={isCurrent ? "step" : undefined}>
                <span className="wizard-step-num" aria-hidden="true">
                  {isDone ? "✓" : s.n}
                </span>
                <span className="wizard-step-label">
                  {s.label}
                  {s.comingSoon && (
                    <span className="badge badge-soon">Next update</span>
                  )}
                </span>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
