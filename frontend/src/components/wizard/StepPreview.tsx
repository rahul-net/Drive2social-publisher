// Wizard step 2 — Preview the selected video + file facts.

import { useEffect, useState } from "react";
import { useCreatePost } from "../../contexts/CreatePostContext";
import { api, apiBaseUrl } from "../../lib/api";
import { extensionOf, formatBytes, formatDuration } from "../../lib/videoFormat";
import { ErrorState, Loading } from "../States";

export function StepPreview({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  const { file } = useCreatePost();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setPreviewUrl(null);
    setPreviewError(null);
    api
      .getDrivePreviewToken(file.id)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setPreviewUrl(apiBaseUrl() + res.data.url);
        else setPreviewError(res.error.message);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPreviewError(
            err instanceof Error ? err.message : "Could not load preview",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  if (!file) {
    return (
      <ErrorState
        title="No video selected"
        hint="Go back to step 1 and pick a video first."
      />
    );
  }

  const facts: Array<[string, string]> = [
    ["File", file.name],
    ["Size", formatBytes(file.size)],
    ["Format", `${extensionOf(file.name) || "—"} (${file.mimeType})`],
    [
      "Duration",
      file.durationMillis !== undefined
        ? formatDuration(file.durationMillis)
        : "Unknown",
    ],
    [
      "Resolution",
      file.width !== undefined && file.height !== undefined
        ? `${file.width}×${file.height}`
        : "Unknown",
    ],
    ["Modified", new Date(file.modifiedTime).toLocaleString()],
  ];

  return (
    <div>
      {previewError ? (
        <ErrorState title="Couldn't load preview" hint={previewError} />
      ) : !previewUrl ? (
        <Loading />
      ) : (
        <video
          className="preview-video"
          controls
          playsInline
          preload="metadata"
          src={previewUrl}
        />
      )}

      <dl className="fact-list">
        {facts.map(([label, value]) => (
          <div className="fact-row" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <div className="wizard-nav">
        <button type="button" className="btn" onClick={onBack}>
          ← Back
        </button>
        <button type="button" className="btn btn-primary" onClick={onNext}>
          Continue to AI generation →
        </button>
      </div>
    </div>
  );
}
