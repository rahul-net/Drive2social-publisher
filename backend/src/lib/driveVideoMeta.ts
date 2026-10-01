import type { drive_v3 } from "googleapis";
import { HttpError } from "../middleware/errorHandler.js";
import {
  getValidAccessToken,
  googleErrorStatus,
  makeDriveClient,
  mapGoogleError,
} from "./googleOAuth.js";
import { assessVideoSupport, isVideoMimeType } from "../routes/drive.js";

// ============================================================
// Drive video metadata probe — moved here (Phase 7) from
// routes/youtube.ts so both the routes AND the queue worker
// (services/uploadQueue.ts) can use it without a route↔service
// import cycle (routes/drive.ts only depends on lib/middleware,
// so this import is cycle-free). routes/youtube.ts re-exports it,
// so existing imports (routes/facebook.ts) keep working unchanged.
// ============================================================

export interface DriveVideoMeta {
  name: string;
  mimeType: string;
  size?: string;
}

/**
 * Read the Drive file's metadata as the user (one 401 → refresh → one
 * retry, like the Drive routes). Validates it is a supported video
 * with a usable byte size — the resumable upload needs Content-Length
 * up front, so a missing/zero size is a hard 400.
 */
export async function getDriveVideoMeta(
  uid: string,
  fileId: string,
): Promise<DriveVideoMeta> {
  const attempt = async (forceRefresh: boolean): Promise<drive_v3.Schema$File> => {
    const token = await getValidAccessToken(uid, "drive", { forceRefresh });
    const result = await makeDriveClient(token).files.get({
      fileId,
      fields: "id,name,mimeType,size",
    });
    return result.data;
  };
  let file: drive_v3.Schema$File;
  try {
    file = await attempt(false);
  } catch (err) {
    if (googleErrorStatus(err) === 401) {
      try {
        file = await attempt(true);
      } catch (retryErr) {
        throw mapGoogleError(retryErr, "Google Drive");
      }
    } else {
      throw mapGoogleError(err, "Google Drive");
    }
  }

  const mimeType = file.mimeType ?? "";
  if (!isVideoMimeType(mimeType)) {
    throw new HttpError(
      400,
      "NOT_A_VIDEO",
      "The selected file is not a video.",
    );
  }
  const name = file.name ?? "Untitled";
  const { supported, supportReason } = assessVideoSupport(name, mimeType);
  if (!supported) {
    throw new HttpError(
      400,
      "UNSUPPORTED_FORMAT",
      supportReason ?? "Unsupported video format.",
    );
  }
  const meta: DriveVideoMeta = { name, mimeType };
  if (file.size !== undefined && file.size !== null) {
    meta.size = file.size;
  }
  return meta;
}
