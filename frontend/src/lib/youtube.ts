// ============================================================
// YouTube API client wrapper — Phase 4.
// Typed calls against /api/youtube; auth is handled by lib/api
// (Firebase ID token on every request). No tokens or secrets here.
// ============================================================

import type { ApiResponse, PrivacyStatus, PublishJob } from "@shared";
import { get, post } from "./api";

/** Own channel info (GET /api/youtube/channel). */
export interface YouTubeChannel {
  channelId: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
  subscriberCount?: number;
  videoCount?: number;
}

/** Assignable video category (GET /api/youtube/categories). */
export interface YouTubeVideoCategory {
  id: string;
  title: string;
}

/** POST /api/youtube/upload body. */
export interface YouTubeUploadInput {
  driveFileId: string;
  metadata: {
    title: string;
    description: string;
    tags: string[];
  };
  settings: {
    privacyStatus: PrivacyStatus;
    categoryId: string;
    madeForKids: boolean;
    notifySubscribers: boolean;
  };
}

export const youtubeApi = {
  /** The user's own YouTube channel (403 when YouTube isn't connected). */
  getChannel: (): Promise<ApiResponse<YouTubeChannel>> =>
    get<YouTubeChannel>("/api/youtube/channel"),

  /** Assignable video categories for a region (default US). */
  getCategories: (
    regionCode = "US",
  ): Promise<ApiResponse<YouTubeVideoCategory[]>> =>
    get<YouTubeVideoCategory[]>(
      `/api/youtube/categories?regionCode=${encodeURIComponent(regionCode)}`,
    ),

  /** Start an upload — responds 202 with the PENDING job record. */
  startUpload: (input: YouTubeUploadInput): Promise<ApiResponse<PublishJob>> =>
    post<PublishJob>("/api/youtube/upload", input),

  /** One job for progress polling (fallback for Phase 7 live updates). */
  getJob: (jobId: string): Promise<ApiResponse<PublishJob>> =>
    get<PublishJob>(`/api/youtube/jobs/${encodeURIComponent(jobId)}`),
};
