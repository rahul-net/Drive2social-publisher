// ============================================================
// Typed API client.
// Phase 2 (Firebase Auth): getIdToken() delegates to the AuthContext
// via a module-level getter registered by AuthProvider. Every request
// carries Authorization: Bearer <Firebase ID token> when signed in.
// ID tokens live in memory only (never localStorage), never logged.
// ============================================================

import type {
  ApiResponse,
  CancelJobResponse,
  ConnectedAccount,
  DriveFileListResponse,
  DrivePreviewToken,
  DriveVideoFile,
  DuplicatePublishErrorBody,
  GenerateMetadataInput,
  GeminiMetadataResult,
  GeminiStatus,
  HistoryListResponse,
  JobsListResponse,
  PublishEnqueueResponse,
  PublishInput,
  PublishJob,
  UserSettings,
} from "@shared";

/** Force-refresh aware getter; null when signed out. */
export type IdTokenGetter = (forceRefresh?: boolean) => Promise<string | null>;

let idTokenGetter: IdTokenGetter | null = null;

/** Registered by AuthProvider on mount. */
export function setIdTokenGetter(getter: IdTokenGetter): void {
  idTokenGetter = getter;
}

/**
 * Current user's Firebase ID token, or null when signed out (or when
 * auth isn't initialized/configured). Never throws.
 */
export async function getIdToken(
  forceRefresh = false,
): Promise<string | null> {
  if (!idTokenGetter) return null;
  try {
    return await idTokenGetter(forceRefresh);
  } catch {
    return null;
  }
}

const BASE_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

/** API base URL (e.g. http://localhost:8080) — used to build absolute preview URLs. */
export function apiBaseUrl(): string {
  return BASE_URL;
}

function buildHeaders(token: string | null): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    // Verified server-side by requireAuth (firebase-admin verifyIdToken).
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function request<T>(path: string, init: RequestInit): Promise<ApiResponse<T>> {
  let token: string | null = null;
  try {
    token = await getIdToken();
  } catch {
    token = null;
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...buildHeaders(token), ...(init.headers ?? {}) },
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : "Network request failed",
      },
    };
  }

  try {
    const body = (await res.json()) as ApiResponse<T>;
    return body;
  } catch {
    return {
      ok: false,
      error: { code: "BAD_RESPONSE", message: "Invalid JSON response from server" },
    };
  }
}

export async function get<T>(path: string): Promise<ApiResponse<T>> {
  return request<T>(path, { method: "GET" });
}

export async function post<T>(path: string, body: unknown): Promise<ApiResponse<T>> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export async function put<T>(path: string, body: unknown): Promise<ApiResponse<T>> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

export async function del<T>(path: string): Promise<ApiResponse<T>> {
  return request<T>(path, { method: "DELETE" });
}

// ------------------------------------------------------------
// Typed endpoint functions.
// These hit real backend routes once later phases implement them;
// for now the pages render honest empty states while routes are 404.
// ------------------------------------------------------------

export const api = {
  health: () =>
    get<{ service: string; version: string; time: string }>("/api/health"),

  // --- Connected accounts (Phase 3: Google; Phase 4: Meta) ---
  listAccounts: () => get<ConnectedAccount[]>("/api/accounts"),
  disconnectGoogle: () => del<{ disconnected: boolean }>("/api/accounts/google"),

  /**
   * Google OAuth connect URL for a purpose ("drive" or "youtube" —
   * Phase 4 added youtube for incremental YouTube consent). The
   * backend binds the Firebase uid to the OAuth `state` server-side,
   * so the frontend just navigates to the returned URL.
   */
  googleStartUrl: (purpose: "drive" | "youtube" = "drive") =>
    get<{ url: string }>(
      `/api/auth/google/start-url?purpose=${encodeURIComponent(purpose)}`,
    ),

  // --- Meta / Facebook Pages (Phase 5) ---
  /**
   * Meta (Facebook) OAuth connect URL. The backend binds the Firebase
   * uid to the OAuth `state` server-side, so the frontend just
   * navigates to the returned URL.
   */
  metaStartUrl: () => get<{ url: string }>("/api/auth/meta/start-url"),
  disconnectMeta: () =>
    del<{ disconnected: boolean; note: string }>("/api/accounts/meta"),

  // --- Google Drive (Phase 3) ---
  listDriveFiles: (params: {
    q?: string;
    pageSize?: number;
    pageToken?: string;
    filter?: "supported" | "all";
  }) => {
    const sp = new URLSearchParams();
    if (params.q) sp.set("q", params.q);
    if (params.pageSize !== undefined)
      sp.set("pageSize", String(params.pageSize));
    if (params.pageToken) sp.set("pageToken", params.pageToken);
    if (params.filter) sp.set("filter", params.filter);
    const qs = sp.toString();
    return get<DriveFileListResponse>(`/api/drive/files${qs ? `?${qs}` : ""}`);
  },
  getDriveFile: (id: string) =>
    get<DriveVideoFile>(`/api/drive/files/${encodeURIComponent(id)}`),
  /** Signed preview URL for a <video> tag (relative — prefix with apiBaseUrl()). */
  getDrivePreviewToken: (fileId: string) =>
    get<DrivePreviewToken>(
      `/api/drive/preview-token/${encodeURIComponent(fileId)}`,
    ),

  // --- Gemini AI metadata (Phase 6) ---
  /** Capability state: is the Gemini key configured? is ffmpeg present? */
  geminiStatus: () => get<GeminiStatus>("/api/gemini/status"),
  /**
   * Generate YouTube + Facebook metadata for a Drive video.
   * Frames are extracted server-side; the Gemini key never touches
   * the frontend.
   */
  generateMetadata: (input: GenerateMetadataInput) =>
    post<GeminiMetadataResult>("/api/gemini/generate-metadata", input),

  // --- Publish queue + history (Phase 7) ---

  /**
   * Enqueue a publish for one or more destinations. Responds 202 with
   * the PENDING jobs, or 409 with a DUPLICATE_PUBLISH error (the
   * duplicate record nested inside `error`) when this video was
   * already published to a destination. Use isDuplicatePublishError
   * to detect it.
   */
  publish: (input: PublishInput) =>
    post<PublishEnqueueResponse>("/api/publish", input),

  /** Paginated jobs, newest first. */
  listJobs: (params?: { limit?: number; startAfter?: string }) => {
    const sp = new URLSearchParams();
    if (params?.limit !== undefined) sp.set("limit", String(params.limit));
    if (params?.startAfter) sp.set("startAfter", params.startAfter);
    const qs = sp.toString();
    return get<JobsListResponse>(`/api/jobs${qs ? `?${qs}` : ""}`);
  },
  /** One job by id. */
  getJob: (id: string) =>
    get<PublishJob>(`/api/jobs/${encodeURIComponent(id)}`),
  /** Retry a FAILED+retryable job (resumes from the saved session). */
  retryJob: (id: string) =>
    post<PublishJob>(`/api/jobs/${encodeURIComponent(id)}/retry`, {}),
  /** Cancel a PENDING job immediately, or request best-effort cancellation of an active upload. */
  cancelJob: (id: string) =>
    post<CancelJobResponse>(`/api/jobs/${encodeURIComponent(id)}/cancel`, {}),

  /** Paginated publishing history, newest first. */
  listHistory: (params?: { limit?: number; startAfter?: string }) => {
    const sp = new URLSearchParams();
    if (params?.limit !== undefined) sp.set("limit", String(params.limit));
    if (params?.startAfter) sp.set("startAfter", params.startAfter);
    const qs = sp.toString();
    return get<HistoryListResponse>(`/api/history${qs ? `?${qs}` : ""}`);
  },

  // --- User settings (Phase 8) ---

  /**
   * The user's effective settings: their stored `settings/{uid}` doc
   * merged over server-side defaults. 401 when signed out.
   */
  getUserSettings: () => get<{ settings: UserSettings }>("/api/settings"),

  /**
   * Validate + save the user's settings (hashtags are normalized
   * server-side: leading "#" stripped). Resolves with the saved
   * settings.
   */
  updateUserSettings: (settings: UserSettings) =>
    put<{ settings: UserSettings }>("/api/settings", settings),
};

/**
 * Detect the 409 DUPLICATE_PUBLISH error from POST /api/publish (and
 * the legacy /api/youtube/upload, /api/facebook/upload routes). The
 * `duplicate` record lives inside `error`, per the documented shape.
 */
export function isDuplicatePublishError(
  err: { code: string; message: string },
): err is DuplicatePublishErrorBody {
  if (err.code !== "DUPLICATE_PUBLISH") return false;
  const dup = (err as { duplicate?: unknown }).duplicate;
  return typeof dup === "object" && dup !== null;
}
