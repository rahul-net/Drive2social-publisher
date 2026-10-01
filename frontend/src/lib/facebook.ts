// ============================================================
// Facebook (Meta Pages) API client wrapper — Phase 5.
// Typed calls against /api/meta and /api/facebook; auth is handled
// by lib/api (Firebase ID token on every request). No tokens or
// secrets here — page tokens never leave the backend.
// ============================================================

import type {
  ApiResponse,
  FacebookUploadInput,
  MetaPage,
  PublishJob,
} from "@shared";
import { get, post } from "./api";

export const facebookApi = {
  /** The user's granted Facebook Pages (redacted; 403 when not connected). */
  getPages: (): Promise<ApiResponse<MetaPage[]>> =>
    get<MetaPage[]>("/api/meta/pages"),

  /** Set the default Page for publishing. */
  selectPage: (
    pageId: string,
  ): Promise<ApiResponse<{ selectedPageId: string }>> =>
    post<{ selectedPageId: string }>("/api/meta/pages/select", { pageId }),

  /** Start an upload — responds 202 with the PENDING job record. */
  startUpload: (input: FacebookUploadInput): Promise<ApiResponse<PublishJob>> =>
    post<PublishJob>("/api/facebook/upload", input),

  /** One job for progress polling (fallback for Phase 7 live updates). */
  getJob: (jobId: string): Promise<ApiResponse<PublishJob>> =>
    get<PublishJob>(`/api/facebook/jobs/${encodeURIComponent(jobId)}`),
};
