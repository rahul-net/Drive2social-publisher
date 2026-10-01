// Wizard step 1 — Select video.

import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import type { DriveVideoFile } from "@shared";
import { useCreatePost } from "../../contexts/CreatePostContext";
import { loadSelectedDriveFile } from "../../lib/driveSelection";
import { extensionOf, formatBytes, formatDuration } from "../../lib/videoFormat";
import { DrivePickerModal } from "../DrivePickerModal";
import { EmptyState } from "../States";

export function StepSelectVideo({ onNext }: { onNext: () => void }) {
  const { file, selectFile } = useCreatePost();
  const [pickerOpen, setPickerOpen] = useState(false);
  const location = useLocation();

  // Inbound handoff from the Drive page ("Use in Create Post" →
  // navigate("/create", { state: { driveFile } })). Router state beats
  // nothing; the context's sessionStorage seed usually already has it.
  useEffect(() => {
    const stateFile = (location.state as { driveFile?: unknown } | null)
      ?.driveFile;
    const fallback = loadSelectedDriveFile();
    const candidate = stateFile ?? fallback;
    if (
      candidate &&
      typeof (candidate as DriveVideoFile).id === "string" &&
      (candidate as DriveVideoFile).id !== file?.id
    ) {
      selectFile(candidate as DriveVideoFile);
    }
    // Run once on mount — the selection seed, not a live sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelect = (f: DriveVideoFile) => {
    selectFile(f);
    setPickerOpen(false);
  };

  return (
    <div>
      {file ? (
        <div className="selected-video-card">
          {file.thumbnailLink ? (
            <img
              className="selected-video-thumb"
              src={file.thumbnailLink}
              alt=""
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="selected-video-thumb-icon" aria-hidden="true">
              🎬
            </span>
          )}
          <div className="selected-video-body">
            <div className="selected-video-name">{file.name}</div>
            <div className="muted">
              {extensionOf(file.name)} · {formatBytes(file.size)}
              {file.durationMillis !== undefined &&
                ` · ${formatDuration(file.durationMillis)}`}
              {file.width !== undefined &&
                file.height !== undefined &&
                ` · ${file.width}×${file.height}`}
            </div>
            <div className="badge-row">
              {file.supported === false ? (
                <span className="badge badge-warn" title={file.supportReason}>
                  Unsupported — {file.supportReason}
                </span>
              ) : (
                <span className="badge badge-ok">Supported</span>
              )}
            </div>
          </div>
          <div className="selected-video-actions">
            <button
              type="button"
              className="btn"
              onClick={() => setPickerOpen(true)}
            >
              Change
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => selectFile(null)}
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <EmptyState
          icon="🎬"
          title="No video selected"
          hint="Pick a video from your Google Drive to start building a post."
          action={
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setPickerOpen(true)}
            >
              Browse Drive
            </button>
          }
        />
      )}

      {file && (
        <div className="center-row">
          <button type="button" className="btn btn-primary" onClick={onNext}>
            Continue to preview →
          </button>
        </div>
      )}

      <DrivePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleSelect}
      />
    </div>
  );
}
