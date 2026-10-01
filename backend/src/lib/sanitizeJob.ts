import type { PublishJob } from "@drive2social/shared";

// ============================================================
// Job sanitizer (Phase 7) — one shared copy.
//
// Strips every SERVER-ONLY field from a PublishJob before it leaves
// the backend: the YouTube resumable session URI and the Facebook
// resumable session id / video id. Used by the queue, publish, jobs,
// and history routes (and the legacy youtube/facebook upload routes,
// which now funnel through the queue worker).
// ============================================================

/** Remove server-only resumable-session fields from a job doc. */
export function sanitizeJob(job: PublishJob): PublishJob {
  const copy: PublishJob = { ...job };
  delete copy.uploadSessionUri;
  delete copy.facebookUploadSessionId;
  delete copy.facebookVideoId;
  return copy;
}
