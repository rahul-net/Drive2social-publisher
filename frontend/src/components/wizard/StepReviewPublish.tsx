// Wizard step 7 — Review & Publish (Phase 7).
//
// Summary card (video, destinations, key settings), a final
// confirmation checkbox, and the PUBLISH button → POST /api/publish.
//
// Duplicate protection: a 409 DUPLICATE_PUBLISH shows exactly what
// already exists ("This video has already been published to
// YouTube/Facebook") with a link to the existing post and a
// "Publish anyway" checkbox — resending with confirmDuplicate: true.
// Success navigates to /queue.

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type {
  Destination,
  DuplicateInfo,
  MetaPage,
  PublishInput,
} from "@shared";
import { useCreatePost } from "../../contexts/CreatePostContext";
import { api, isDuplicatePublishError } from "../../lib/api";
import { facebookApi } from "../../lib/facebook";
import { useToast } from "../../contexts/ToastContext";
import { useOnlineStatus } from "../../lib/useOnlineStatus";

const DESTINATION_LABEL: Record<Destination, string> = {
  youtube: "YouTube",
  facebook: "Facebook Page",
};

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary-row">
      <span className="summary-label">{label}</span>
      <span className="summary-value">{value}</span>
    </div>
  );
}

export function StepReviewPublish({ onBack }: { onBack: () => void }) {
  const { file, metadata, destinations, publishSettings } = useCreatePost();
  const online = useOnlineStatus();
  const { notify } = useToast();
  const navigate = useNavigate();

  const [confirmed, setConfirmed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateInfo | null>(null);
  const [publishAnyway, setPublishAnyway] = useState(false);
  const [pages, setPages] = useState<MetaPage[] | null>(null);

  useEffect(() => {
    if (!destinations.includes("facebook")) return;
    let cancelled = false;
    facebookApi.getPages().then((res) => {
      if (!cancelled && res.ok) setPages(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [destinations]);

  if (!file || !metadata) {
    return (
      <div className="notice notice-warn" role="note">
        The video or metadata is missing — go back and complete the
        earlier steps.
      </div>
    );
  }

  const pageName =
    pages?.find((p) => p.pageId === publishSettings.pageId)?.pageName ??
    (publishSettings.pageId ? publishSettings.pageId : "Default page");

  const buildInput = (confirmDuplicate: boolean): PublishInput => {
    const input: PublishInput = {
      driveFileId: file.id,
      destinations: [...destinations],
      metadata: {
        title: metadata.youtube_title,
        description: metadata.youtube_description,
        tags: [...metadata.youtube_tags],
        caption: metadata.facebook_caption,
        hashtags: [...metadata.hashtags],
      },
      settings: {
        privacyStatus: publishSettings.privacyStatus,
        categoryId: publishSettings.categoryId,
        madeForKids: publishSettings.madeForKids,
        notifySubscribers: publishSettings.notifySubscribers,
      },
      confirmDuplicate,
    };
    // exactOptionalPropertyTypes: only include pageId when set.
    if (publishSettings.pageId) {
      input.settings = { ...input.settings, pageId: publishSettings.pageId };
    }
    return input;
  };

  const handlePublish = async (): Promise<void> => {
    setPublishing(true);
    setError(null);
    try {
      const res = await api.publish(buildInput(publishAnyway));
      if (res.ok) {
        notify(
          "success",
          `Enqueued ${res.data.jobs.length} publish job${res.data.jobs.length === 1 ? "" : "s"}.`,
        );
        navigate("/queue");
        return;
      }
      if (isDuplicatePublishError(res.error)) {
        // Not a failure of the request — the user decides.
        setDuplicate(res.error.duplicate);
        setPublishAnyway(false);
        return;
      }
      setError(res.error.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish request failed");
    } finally {
      setPublishing(false);
    }
  };

  const duplicateLabel =
    duplicate &&
    (duplicate.destination === "youtube" ? "YouTube" : "Facebook");

  return (
    <div>
      <h3 className="step-title">Review & publish</h3>

      <div className="card summary-card">
        <div className="summary-video">
          {file.thumbnailLink ? (
            <img
              src={file.thumbnailLink}
              alt=""
              className="summary-thumb"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="summary-thumb summary-thumb-icon" aria-hidden="true">
              🎬
            </div>
          )}
          <div>
            <div className="card-title">{file.name}</div>
            <div className="card-meta">
              {(file.size / (1024 * 1024)).toFixed(1)} MB ·{" "}
              {metadata.youtube_title || "Untitled"}
            </div>
          </div>
        </div>

        <SummaryRow
          label="Destinations"
          value={destinations.map((d) => DESTINATION_LABEL[d]).join(" + ")}
        />
        {destinations.includes("youtube") && (
          <>
            <SummaryRow
              label="YouTube privacy"
              value={publishSettings.privacyStatus}
            />
            <SummaryRow
              label="YouTube category"
              value={publishSettings.categoryId || "—"}
            />
            <SummaryRow
              label="Made for kids"
              value={publishSettings.madeForKids ? "Yes" : "No"}
            />
            <SummaryRow
              label="Notify subscribers"
              value={publishSettings.notifySubscribers ? "Yes" : "No"}
            />
          </>
        )}
        {destinations.includes("facebook") && (
          <SummaryRow label="Facebook Page" value={pageName} />
        )}
        <SummaryRow
          label="Title"
          value={`${metadata.youtube_title} (${metadata.youtube_title.length}/100)`}
        />
        <SummaryRow
          label="Tags"
          value={
            metadata.youtube_tags.length > 0
              ? metadata.youtube_tags.join(", ")
              : "—"
          }
        />
      </div>

      {duplicate && duplicateLabel && (
        <div className="notice notice-warn" role="alert">
          <strong>
            This video has already been published to {duplicateLabel}.
          </strong>
          <div className="duplicate-actions">
            <a
              href={duplicate.destinationUrl}
              target="_blank"
              rel="noreferrer"
              className="link"
            >
              View the existing {duplicateLabel === "YouTube" ? "video" : "post"} ↗
            </a>
            <span className="muted">
              Published{" "}
              {new Date(duplicate.publishedAt).toLocaleString()} to{" "}
              {duplicate.destinationAccountName}.
            </span>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={publishAnyway}
              onChange={(e) => setPublishAnyway(e.target.checked)}
            />
            Publish anyway — I understand this will create a second copy.
          </label>
        </div>
      )}

      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}

      <div className="form-field">
        <label className="check-row" htmlFor="confirm-publish">
          <input
            id="confirm-publish"
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I confirm I want to publish this video
          {destinations.length > 0 &&
            ` to ${destinations.map((d) => DESTINATION_LABEL[d]).join(" and ")}`}
          .
        </label>
      </div>

      <div className="wizard-nav">
        <button type="button" className="btn" onClick={onBack} disabled={publishing}>
          ← Settings
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            publishing ||
            !online ||
            !confirmed ||
            (duplicate !== null && !publishAnyway)
          }
          title={
            !online
              ? "You are offline — publishing requires an internet connection"
              : !confirmed
                ? "Confirm above before publishing"
                : duplicate && !publishAnyway
                  ? "Check “Publish anyway” to publish a second copy"
                  : undefined
          }
          onClick={() => void handlePublish()}
        >
          {publishing
            ? "Publishing…"
            : duplicate
              ? "Publish anyway"
              : "Publish"}
        </button>
      </div>

      <p className="muted">
        Uploads run in the background — you can watch progress on the{" "}
        <Link to="/queue" className="link">
          Upload Queue
        </Link>{" "}
        page.
      </p>
    </div>
  );
}
