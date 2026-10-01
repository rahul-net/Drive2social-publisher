import { Router } from "express";
import { z } from "zod";
import type {
  ApiResponse,
  DriveFileListResponse,
  DrivePreviewToken,
  DriveVideoFile,
} from "@drive2social/shared";
import type { drive_v3 } from "googleapis";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/requireAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireUid } from "../lib/authRequest.js";
import { logger } from "../lib/logger.js";
import {
  createPreviewToken,
  getValidAccessToken,
  googleErrorStatus,
  makeDriveClient,
  mapGoogleError,
  verifyPreviewToken,
} from "../lib/googleOAuth.js";

// ============================================================
// Google Drive integration — mounted at /api/drive.
//
// Token ownership: every call resolves the access token from
// `connectedAccounts/{uid}_google` for req.user.uid — a user can only
// ever touch their own Drive.
//
// Preview: the <video> tag can't send Authorization headers, so
// GET /preview-token/:fileId issues a short-lived HMAC capability
// token and GET /preview/:fileId (PUBLIC — the HMAC is the auth)
// streams bytes with Range support. The HMAC binds (uid, fileId, exp);
// the endpoint re-validates that the file is an accessible video
// before streaming. Bytes are streamed, never buffered.
// ============================================================

export const driveRouter = Router();

// --- video support assessment -------------------------------------------

const SUPPORTED_EXTENSIONS = new Set(["mp4", "mov", "avi", "mkv", "webm"]);
const SUPPORTED_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/webm",
]);

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function isVideoMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("video/");
}

export function assessVideoSupport(
  name: string,
  mimeType: string,
): { supported: boolean; supportReason?: string } {
  const ext = fileExtension(name);
  const mime = mimeType.toLowerCase();
  if (SUPPORTED_EXTENSIONS.has(ext) || SUPPORTED_MIME_TYPES.has(mime)) {
    return { supported: true };
  }
  const detail = ext ? ` (.${ext})` : mimeType ? ` (${mimeType})` : "";
  return {
    supported: false,
    supportReason: `Unsupported format${detail} — supported: mp4, mov, avi, mkv, webm`,
  };
}

function toDriveVideoFile(f: drive_v3.Schema$File): DriveVideoFile {
  const name = f.name ?? "Untitled";
  const mimeType = f.mimeType ?? "";
  const parsedSize = f.size ? Number.parseInt(f.size, 10) : NaN;
  const { supported, supportReason } = assessVideoSupport(name, mimeType);

  const file: DriveVideoFile = {
    id: f.id ?? "",
    name,
    mimeType,
    size: Number.isFinite(parsedSize) ? parsedSize : 0,
    modifiedTime: f.modifiedTime ?? new Date(0).toISOString(),
    supported,
  };
  if (f.thumbnailLink) file.thumbnailLink = f.thumbnailLink;
  if (supportReason !== undefined) file.supportReason = supportReason;

  const meta = f.videoMediaMetadata;
  if (meta?.durationMillis) {
    const d = Number.parseInt(meta.durationMillis, 10);
    if (Number.isFinite(d)) file.durationMillis = d;
  }
  if (typeof meta?.width === "number") file.width = meta.width;
  if (typeof meta?.height === "number") file.height = meta.height;
  return file;
}

// --- Drive call wrapper ---------------------------------------------------

/**
 * Run a Drive call as the user. On a 401 from Google, force one token
 * refresh and retry once; a second 401 becomes GOOGLE_REAUTH_REQUIRED
 * (frontend shows the reconnect CTA — no retry loops).
 *
 * Exported for Phase 6 (routes/gemini.ts) so metadata analysis reuses
 * the same token-ownership + retry semantics.
 */
export async function withDrive<T>(
  uid: string,
  fn: (drive: drive_v3.Drive) => Promise<T>,
): Promise<T> {
  const attempt = async (forceRefresh: boolean): Promise<T> => {
    const token = await getValidAccessToken(uid, { forceRefresh });
    return fn(makeDriveClient(token));
  };
  try {
    return await attempt(false);
  } catch (err) {
    if (googleErrorStatus(err) === 401) {
      try {
        return await attempt(true);
      } catch (retryErr) {
        throw mapGoogleError(retryErr, "Google Drive");
      }
    }
    throw mapGoogleError(err, "Google Drive");
  }
}

export const DRIVE_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{5,256}$/;
const fileIdParamSchema = z.object({
  fileId: z.string().regex(DRIVE_FILE_ID_PATTERN, "Invalid Drive file id"),
});

const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
  pageToken: z.string().max(2000).optional(),
  filter: z.enum(["supported", "all"]).default("supported"),
});

/** Escape a user string for embedding in a Drive search query literal. */
function escapeDriveQueryLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * GET /api/drive/files — list the user's Drive videos.
 * filter=supported (default) drops unsupported containers server-side.
 * Note: filtering happens after Drive's pagination, so a page may be
 * short; nextPageToken is passed through honestly for "load more".
 */
driveRouter.get(
  "/files",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const { q, pageSize, pageToken, filter } = listQuerySchema.parse(
        req.query,
      );

      let driveQ = "mimeType contains 'video/' and trashed = false";
      if (q) {
        driveQ += ` and name contains '${escapeDriveQueryLiteral(q)}'`;
      }

      const params: drive_v3.Params$Resource$Files$List = {
        q: driveQ,
        fields:
          "nextPageToken, files(id,name,mimeType,size,modifiedTime,thumbnailLink,videoMediaMetadata)",
        orderBy: "modifiedTime desc",
        pageSize,
      };
      if (pageToken !== undefined) params.pageToken = pageToken;

      const result = await withDrive(uid, (drive) => drive.files.list(params));
      let files = (result.data.files ?? []).map(toDriveVideoFile);
      if (filter === "supported") {
        files = files.filter((f) => f.supported !== false);
      }

      const payload: DriveFileListResponse = { files };
      if (result.data.nextPageToken) {
        payload.nextPageToken = result.data.nextPageToken;
      }
      const body: ApiResponse<DriveFileListResponse> = { ok: true, data: payload };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/drive/files/:fileId — details for one video.
 * 404 DRIVE_FILE_NOT_FOUND when missing/inaccessible;
 * 400 NOT_A_VIDEO when the file is not a video.
 */
driveRouter.get(
  "/files/:fileId",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const { fileId } = fileIdParamSchema.parse(req.params);

      const result = await withDrive(uid, (drive) =>
        drive.files.get({
          fileId,
          fields:
            "id,name,mimeType,size,modifiedTime,thumbnailLink,videoMediaMetadata",
        }),
      );
      const mimeType = result.data.mimeType ?? "";
      if (!isVideoMimeType(mimeType)) {
        throw new HttpError(400, "NOT_A_VIDEO", "The selected file is not a video.");
      }

      const body: ApiResponse<DriveVideoFile> = {
        ok: true,
        data: toDriveVideoFile(result.data),
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/drive/preview-token/:fileId — requireAuth.
 * Validates the file is an accessible video, then issues the signed
 * preview URL (relative; the frontend prefixes the API base URL).
 */
driveRouter.get(
  "/preview-token/:fileId",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const { fileId } = fileIdParamSchema.parse(req.params);

      const result = await withDrive(uid, (drive) =>
        drive.files.get({ fileId, fields: "id,mimeType" }),
      );
      const mimeType = result.data.mimeType ?? "";
      if (!isVideoMimeType(mimeType)) {
        throw new HttpError(400, "NOT_A_VIDEO", "The selected file is not a video.");
      }

      const { token, exp } = createPreviewToken(uid, fileId);
      const payload: DrivePreviewToken = {
        url:
          `/api/drive/preview/${fileId}` +
          `?uid=${encodeURIComponent(uid)}&exp=${exp}&token=${token}`,
        expiresAt: new Date(exp).toISOString(),
      };
      const body: ApiResponse<DrivePreviewToken> = { ok: true, data: payload };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

const previewQuerySchema = z.object({
  uid: z.string().min(1).max(256),
  exp: z.coerce.number().int().positive(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});

/**
 * GET /api/drive/preview/:fileId?uid&exp&token — PUBLIC.
 * The HMAC preview token IS the auth. Validates the signature and
 * expiry, re-validates (with the uid's own token) that the file is an
 * accessible video, then streams bytes from Drive honoring Range.
 */
driveRouter.get("/preview/:fileId", async (req, res, next) => {
  try {
    const { fileId } = fileIdParamSchema.parse(req.params);
    const { uid, exp, token } = previewQuerySchema.parse(req.query);

    if (!verifyPreviewToken(uid, fileId, exp, token)) {
      throw new HttpError(
        401,
        "INVALID_PREVIEW_TOKEN",
        "The preview link is invalid or has expired.",
      );
    }

    // Token-ownership check: resolve the uid's own token and use it to
    // confirm the file exists and is a video they can access.
    const accessToken = await getValidAccessToken(uid);
    let meta: drive_v3.Schema$File;
    try {
      const result = await makeDriveClient(accessToken).files.get({
        fileId,
        fields: "id,name,mimeType,size",
      });
      meta = result.data;
    } catch (err) {
      throw mapGoogleError(err, "Google Drive");
    }
    const mimeType = meta.mimeType ?? "";
    if (!isVideoMimeType(mimeType)) {
      throw new HttpError(400, "NOT_A_VIDEO", "The selected file is not a video.");
    }

    // Stream from Drive, forwarding the client's Range header so the
    // <video> tag can seek. Never buffer the whole file.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };
    if (typeof req.headers.range === "string") {
      headers["Range"] = req.headers.range;
    }
    let driveRes: Response;
    try {
      driveRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
        { headers },
      );
    } catch (err) {
      throw new HttpError(
        502,
        "GOOGLE_API_ERROR",
        `Drive download failed: ${err instanceof Error ? err.message : "network error"}`,
      );
    }

    if (driveRes.status === 404) {
      throw new HttpError(
        404,
        "DRIVE_FILE_NOT_FOUND",
        "The file was not found in Google Drive.",
      );
    }
    if (driveRes.status === 416) {
      res.status(416).end();
      return;
    }
    const streamBody = driveRes.body;
    if (!driveRes.ok || !streamBody) {
      throw new HttpError(
        502,
        "GOOGLE_API_ERROR",
        `Drive download failed (HTTP ${driveRes.status}).`,
      );
    }

    res.status(driveRes.status);
    for (const name of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
    ]) {
      const value = driveRes.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader("Accept-Ranges", "bytes");

    // Pump the web stream into the Express response chunk by chunk —
    // streamed, never buffered. (Readable.fromWeb is avoided: undici's
    // ReadableStream types clash with the DOM lib under strict tsc.)
    const reader = streamBody.getReader();
    let clientGone = false;
    req.on("close", () => {
      clientGone = true;
      reader.cancel().catch(() => undefined);
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || clientGone) break;
        if (!res.write(value)) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }
    } finally {
      reader.releaseLock();
    }
    res.end();
  } catch (err) {
    // The response may already be streaming; only delegate when safe.
    if (res.headersSent) {
      logger.warn("Preview stream failed after headers were sent; closing");
      res.end();
      return;
    }
    next(err);
  }
});
