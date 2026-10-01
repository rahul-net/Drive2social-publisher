// ============================================================
// Create Post wizard (Phase 7) — all 7 steps live.
//
// Steps 1–4: select video → preview → Gemini metadata generation →
// edit metadata. Steps 5–7 (Phase 7): destinations → settings →
// review & publish.
//
// Guards: step 3 needs a video; step 4 needs generated or manually
// written metadata; step 5 needs metadata; steps 6–7 need at least
// one destination. State lives in CreatePostContext and persists to
// sessionStorage (see contexts/CreatePostContext.tsx).
// ============================================================

import { useEffect } from "react";
import { Layout } from "../components/Layout";
import {
  CreatePostProvider,
  useCreatePost,
} from "../contexts/CreatePostContext";
import { Stepper } from "../components/wizard/Stepper";
import { StepSelectVideo } from "../components/wizard/StepSelectVideo";
import { StepPreview } from "../components/wizard/StepPreview";
import { StepGenerate } from "../components/wizard/StepGenerate";
import { StepEditMetadata } from "../components/wizard/StepEditMetadata";
import { StepDestinations } from "../components/wizard/StepDestinations";
import { StepSettings } from "../components/wizard/StepSettings";
import { StepReviewPublish } from "../components/wizard/StepReviewPublish";

function Wizard() {
  const { step, goToStep, maxReachableStep, resetAll, file } = useCreatePost();

  // Keep a persisted step honest after reloads (e.g. the video was
  // removed while the step said 4).
  useEffect(() => {
    if (step > maxReachableStep) goToStep(maxReachableStep);
  }, [step, maxReachableStep, goToStep]);

  const next = () => goToStep(step + 1);
  const back = () => goToStep(step - 1);

  return (
    <div className="card">
      <div className="wizard-header">
        <h2 className="card-title">New post</h2>
        {file && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (
                window.confirm(
                  "Start over? This clears the selected video, metadata, destinations, and settings.",
                )
              ) {
                resetAll();
              }
            }}
          >
            Start over
          </button>
        )}
      </div>

      <Stepper current={step} maxReachable={maxReachableStep} onJump={goToStep} />

      <div className="wizard-body">
        {step === 1 && <StepSelectVideo onNext={next} />}
        {step === 2 && <StepPreview onNext={next} onBack={back} />}
        {step === 3 && <StepGenerate onNext={next} onBack={back} />}
        {step === 4 && (
          <StepEditMetadata onNext={next} onBack={() => goToStep(3)} />
        )}
        {step === 5 && <StepDestinations onNext={next} onBack={back} />}
        {step === 6 && <StepSettings onNext={next} onBack={back} />}
        {step === 7 && <StepReviewPublish onBack={back} />}
      </div>
    </div>
  );
}

export function CreatePostPage() {
  return (
    <Layout title="Create Post">
      <CreatePostProvider>
        <Wizard />
      </CreatePostProvider>
    </Layout>
  );
}
