// Wizard step 3 — AI metadata generation via Gemini.
//
// Shows honest capability state from GET /api/gemini/status: when the
// server has no Gemini key the CTA is disabled with an explanation.
// Progress messaging stages ("Extracting video frames…", "Asking
// Gemini…") reflect the two real phases of the backend call.

import { useEffect, useRef, useState } from "react";
import type { GeminiStatus } from "@shared";
import { useCreatePost } from "../../contexts/CreatePostContext";
import { api } from "../../lib/api";
import { useToast } from "../../contexts/ToastContext";
import { ErrorState, Loading } from "../States";

const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "bn", label: "বাংলা (Bengali)" },
  { code: "hi", label: "हिन्दी (Hindi)" },
  { code: "es", label: "Español (Spanish)" },
  { code: "ar", label: "العربية (Arabic)" },
  { code: "fr", label: "Français (French)" },
  { code: "de", label: "Deutsch (German)" },
  { code: "pt", label: "Português (Portuguese)" },
];

type Phase = "idle" | "frames" | "gemini";

const PHASE_MESSAGES: Record<Exclude<Phase, "idle">, string> = {
  frames: "Extracting video frames…",
  gemini: "Asking Gemini to write your metadata…",
};

export function StepGenerate({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  const { file, generateInputs, setGenerateInputs, applyGenerated, startManual } =
    useCreatePost();
  const { notify } = useToast();

  const [status, setStatus] = useState<GeminiStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const phaseTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setStatusLoading(true);
    api
      .geminiStatus()
      .then((res) => {
        if (cancelled) return;
        setStatusLoading(false);
        if (res.ok) setStatus(res.data);
        else setStatusError(res.error.message);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStatusLoading(false);
          setStatusError(
            err instanceof Error ? err.message : "Could not check AI status",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      window.clearTimeout(phaseTimer.current);
    };
  }, []);

  if (!file) {
    return (
      <ErrorState
        title="No video selected"
        hint="Go back to step 1 and pick a video first."
      />
    );
  }

  const generating = phase !== "idle";
  const canGenerate =
    status !== null && status.configured && !generating && !statusLoading;

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setError(null);
    setPhase("frames");
    // Staged messaging: frame extraction happens first on the server,
    // then the Gemini call. The second message is timing-based — the
    // actual call is a single request.
    phaseTimer.current = window.setTimeout(() => setPhase("gemini"), 9000);

    const input: {
      driveFileId: string;
      topic?: string;
      transcript?: string;
      language: string;
    } = { driveFileId: file.id, language: generateInputs.language };
    if (generateInputs.topic.trim()) input.topic = generateInputs.topic.trim();
    if (generateInputs.transcript.trim())
      input.transcript = generateInputs.transcript.trim();

    const res = await api.generateMetadata(input);
    window.clearTimeout(phaseTimer.current);
    setPhase("idle");

    if (res.ok) {
      applyGenerated(res.data);
      notify(
        "success",
        res.data.analysisMode === "frames"
          ? `Metadata generated from ${res.data.framesUsed} video frames.`
          : "Metadata generated from file info (no video frames available).",
      );
      onNext();
    } else {
      setError(res.error.message);
    }
  };

  const handleManual = () => {
    startManual();
    onNext();
  };

  return (
    <div>
      {statusLoading ? (
        <Loading />
      ) : statusError ? (
        <ErrorState title="Couldn't check AI status" hint={statusError} />
      ) : status && !status.configured ? (
        <div className="notice notice-warn" role="alert">
          <strong>AI metadata unavailable.</strong> The Gemini API key is not
          configured on this server, so automatic generation is disabled.
          You can still{" "}
          <button type="button" className="link" onClick={handleManual}>
            write the metadata manually
          </button>
          .
        </div>
      ) : (
        status && (
          <div className="notice notice-ok" role="status">
            <strong>AI ready.</strong> Gemini ({status.model}) will analyze{" "}
            {status.ffmpegAvailable
              ? "frames from your video"
              : "your video's file info (frame extraction unavailable on this server)"}{" "}
            and suggest a title, description, tags, caption, and hashtags.
          </div>
        )
      )}

      <div className="form-field">
        <label htmlFor="gen-topic">
          What is this video about? <span className="muted">(optional)</span>
        </label>
        <input
          id="gen-topic"
          type="text"
          className="form-input"
          placeholder="e.g. A street-food tour of Dhaka at night"
          value={generateInputs.topic}
          maxLength={2000}
          disabled={generating}
          onChange={(e) =>
            setGenerateInputs({ ...generateInputs, topic: e.target.value })
          }
        />
        <div className="char-count">{generateInputs.topic.length}/2000</div>
      </div>

      <div className="form-field">
        <label htmlFor="gen-transcript">
          Transcript or subtitles <span className="muted">(optional)</span>
        </label>
        <textarea
          id="gen-transcript"
          className="form-textarea"
          rows={5}
          placeholder="Paste what is said in the video — it helps Gemini avoid inventing facts."
          value={generateInputs.transcript}
          maxLength={20000}
          disabled={generating}
          onChange={(e) =>
            setGenerateInputs({ ...generateInputs, transcript: e.target.value })
          }
        />
        <div className="char-count">
          {generateInputs.transcript.length}/20000
        </div>
      </div>

      <div className="form-field">
        <label htmlFor="gen-language">Language</label>
        <select
          id="gen-language"
          className="form-select"
          value={generateInputs.language}
          disabled={generating}
          onChange={(e) =>
            setGenerateInputs({ ...generateInputs, language: e.target.value })
          }
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      {generating && (
        <div className="generate-progress" role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <div>
            <div>{PHASE_MESSAGES[phase]}</div>
            <div className="muted">
              This can take a minute or two for longer videos.
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="notice notice-error" role="alert">
          <strong>Generation failed.</strong> {error}{" "}
          <button type="button" className="link" onClick={handleGenerate}>
            Retry
          </button>
        </div>
      )}

      <div className="wizard-nav">
        <button type="button" className="btn" onClick={onBack} disabled={generating}>
          ← Back
        </button>
        <div className="wizard-nav-right">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleManual}
            disabled={generating}
          >
            Write manually instead
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={!canGenerate}
            title={
              status && !status.configured
                ? "Gemini is not configured on the server"
                : undefined
            }
          >
            {generating ? "Generating…" : "✨ Generate with Gemini"}
          </button>
        </div>
      </div>
    </div>
  );
}
