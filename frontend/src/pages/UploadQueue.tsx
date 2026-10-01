// ============================================================
// Upload Queue (Phase 7) — real.
//
// Live job list via useJobsLive(): Firestore onSnapshot when the
// client SDK + security rules allow it, polling GET /api/jobs every
// 2.5s otherwise (see lib/useJobsLive.ts for the honest details).
// Each job shows its status badge, real progress (bytes from the job
// doc), timing, destination links when published, the error with a
// Retry button when retryable, and a Cancel button while the job can
// still be stopped.
// ============================================================

import { Link } from "react-router-dom";
import { useState } from "react";
import type { JobStatus, PublishJob } from "@shared";
import { api } from "../lib/api";
import { useJobsLive } from "../lib/useJobsLive";
import { useToast } from "../contexts/ToastContext";
import { Layout } from "../components/Layout";
import { EmptyState, ErrorState, Loading } from "../components/States";

const STATUS_BADGE: Record<JobStatus, string> = {
  PENDING: "badge badge-soon",
  PROCESSING: "badge badge-info",
  UPLOADING: "badge",
  PUBLISHED: "badge badge-ok",
  FAILED: "badge badge-error",
  CANCELLED: "badge",
};

const DESTINATION_LABEL: Record<PublishJob["destination"], string> = {
  youtube: "YouTube",
  facebook: "Facebook",
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function JobCard({ job, onChanged }: { job: PublishJob; onChanged: () => void }) {
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  const jobId = job.id ?? "";

  const canRetry = job.status === "FAILED" && job.retryable;
  const canCancel =
    job.status === "PENDING" ||
    job.status === "PROCESSING" ||
    job.status === "UPLOADING";

  const doRetry = async (): Promise<void> => {
    if (!jobId || busy) return;
    setBusy(true);
    try {
      const res = await api.retryJob(jobId);
      if (res.ok) {
        notify("success", "Job queued for retry — it resumes from the saved session.");
      } else {
        notify("error", `Couldn't retry: ${res.error.message}`);
      }
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Retry failed");
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const doCancel = async (): Promise<void> => {
    if (!jobId || busy) return;
    if (!window.confirm("Cancel this upload job?")) return;
    setBusy(true);
    try {
      const res = await api.cancelJob(jobId);
      if (res.ok) {
        notify(
          "info",
          res.data.cancellationRequested
            ? "Cancellation requested — the upload stops at the next chunk."
            : "Job cancelled.",
        );
      } else {
        notify("error", `Couldn't cancel: ${res.error.message}`);
      }
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <div className="card job-card">
      <div className="job-header">
        <div>
          <div className="card-title">{job.fileName}</div>
          <div className="card-meta">
            {DESTINATION_LABEL[job.destination]} → {job.destinationAccountName || job.destinationAccountId}
          </div>
        </div>
        <span className={STATUS_BADGE[job.status]}>{job.status}</span>
      </div>

      {(job.status === "PROCESSING" || job.status === "UPLOADING") && (
        <div className="progress-wrap">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
            />
          </div>
          <div className="card-meta">
            {formatBytes(job.bytesUploaded)} / {formatBytes(job.bytesTotal)} ·{" "}
            {Math.round(job.progress)}%
          </div>
        </div>
      )}

      <div className="card-meta job-times">
        Started {formatTime(job.startedAt)}
        {job.completedAt && <> · completed {formatTime(job.completedAt)}</>}
      </div>

      {job.status === "FAILED" && job.error && (
        <div className="notice notice-error" role="alert">
          <strong>{job.error.code}:</strong> {job.error.message}
        </div>
      )}

      {job.privacyForced && job.privacyForcedMessage && (
        <div className="notice notice-warn" role="note">
          {job.privacyForcedMessage}
        </div>
      )}

      <div className="job-actions">
        {job.destinationUrl && (
          <a
            href={job.destinationUrl}
            target="_blank"
            rel="noreferrer"
            className="link"
          >
            View {DESTINATION_LABEL[job.destination] === "YouTube" ? "video" : "post"} ↗
          </a>
        )}
        {canRetry && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void doRetry()}
          >
            {busy ? "Retrying…" : "Retry"}
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void doCancel()}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export function UploadQueuePage() {
  const { state, jobs, message, live, refresh } = useJobsLive();

  return (
    <Layout title="Upload Queue">
      <div className="page-subhead">
        <span className="muted">
          {live ? "● Live updates" : "⟳ Auto-refreshing every 2.5s"}
        </span>
        {!live && state === "ready" && (
          <button type="button" className="btn btn-ghost" onClick={refresh}>
            Refresh now
          </button>
        )}
      </div>

      {state === "loading" && <Loading />}
      {state === "failed" && (
        <ErrorState title="Couldn't load the queue" hint={message} />
      )}
      {state === "ready" &&
        (jobs.length === 0 ? (
          <EmptyState
            icon="⏳"
            title="Queue is empty"
            hint="Create a post to add a publish job to the queue."
            action={
              <Link to="/create" className="btn btn-primary">
                Create post
              </Link>
            }
          />
        ) : (
          <div className="card-list">
            {jobs.map((job) => (
              <JobCard
                key={job.id ?? `${job.driveFileId}-${job.destination}`}
                job={job}
                onChanged={refresh}
              />
            ))}
          </div>
        ))}
    </Layout>
  );
}
