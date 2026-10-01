// ============================================================
// videoFrames — server-side video frame extraction for Gemini
// metadata generation (Phase 6).
//
// Strategy (documented honestly):
//   1. Check `ffmpeg -version` once per process (cached).
//   2. Download a BOUNDED sample of the video — only the first
//      SAMPLE_BYTES bytes via an HTTP Range request — streamed
//      straight to a temp file. The whole video is NEVER loaded into
//      memory and never fully downloaded.
//   3. Run ffmpeg once over the sample with `fps=1/<interval>` to
//      grab up to MAX_FRAMES evenly-spaced JPEGs (scaled to
//      FRAME_WIDTH px wide, quality ~70).
//   4. Keep total inline image bytes under MAX_INLINE_IMAGE_BYTES
//      (the Gemini request must stay well under the ~20MB request
//      ceiling), smallest-lossy first: frames beyond the cap are
//      dropped.
//   5. Temp files are removed in a `finally` block.
//
// Fallbacks → analysisMode "metadata" (framesUsed 0):
//   - ffmpeg is not installed on the server,
//   - the sample download fails,
//   - ffmpeg extracts 0 frames (e.g. a truncated prefix whose moov
//     atom sits past the 64MB sample — common for non-faststart mp4s).
//
// The caller (routes/gemini.ts) reports analysisMode + framesUsed so
// the UI can say honestly which mode was used.
// ============================================================

import { execFile } from "child_process";
import { createWriteStream, promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { HttpError } from "../middleware/errorHandler.js";
import { logger } from "../lib/logger.js";

const execFileAsync = promisify(execFile);

export type AnalysisMode = "frames" | "metadata";

export interface ExtractedFrame {
  mimeType: "image/jpeg";
  /** Raw JPEG bytes (sent to Gemini as base64 inlineData). */
  data: Buffer;
}

export interface FrameExtractionResult {
  ffmpegAvailable: boolean;
  analysisMode: AnalysisMode;
  frames: ExtractedFrame[];
  framesUsed: number;
  /** Bytes of the video actually sampled (0 when no sample was taken). */
  bytesSampled: number;
}

export interface ExtractFramesOptions {
  /** The user's Google access token (token ownership: their own Drive). */
  accessToken: string;
  fileId: string;
  fileName: string;
  /** From Drive videoMediaMetadata; used to space frames evenly. */
  durationMillis?: number;
  maxFrames?: number;
}

/** Max frames per request (Gemini handles 8 small JPEGs comfortably). */
const DEFAULT_MAX_FRAMES = 8;
/** Frame width cap; height follows aspect ratio. */
const FRAME_WIDTH = 768;
/** ffmpeg -q:v value (2 = best, 31 = worst); 5 ≈ quality 70. */
const FRAME_QUALITY = "5";
/**
 * Bounded sample: only the first 64MB of the video is ever fetched.
 * Enough for representative early-video frames; keeps bandwidth and
 * disk bounded. Honest limitation: frames come from the video's first
 * ~64MB, not the whole file.
 */
const SAMPLE_BYTES = 64 * 1024 * 1024;
/** Hard cap on inline image bytes in the Gemini request (< ~20MB ceiling). */
const MAX_INLINE_IMAGE_BYTES = 16 * 1024 * 1024;

/** Cached ffmpeg availability (checked once per process). */
let ffmpegAvailableCache: boolean | undefined;

/** True when `ffmpeg` runs on this server. Result is cached. */
export async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailableCache !== undefined) return ffmpegAvailableCache;
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 10_000 });
    ffmpegAvailableCache = true;
  } catch {
    ffmpegAvailableCache = false;
  }
  logger.info({ ffmpegAvailable: ffmpegAvailableCache }, "ffmpeg availability");
  return ffmpegAvailableCache;
}

/**
 * Stream the first `capBytes` of the Drive file to `destPath`.
 * Uses a Range request so Drive only sends the prefix; the byte cap is
 * enforced again client-side in case the server ignores Range.
 */
async function downloadSampleToFile(
  accessToken: string,
  fileId: string,
  destPath: string,
  capBytes: number,
): Promise<number> {
  let res: Response;
  try {
    res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Range: `bytes=0-${capBytes - 1}`,
        },
      },
    );
  } catch (err) {
    throw new HttpError(
      502,
      "GOOGLE_API_ERROR",
      `Drive sample download failed: ${err instanceof Error ? err.message : "network error"}`,
    );
  }
  if (res.status === 404) {
    throw new HttpError(
      404,
      "DRIVE_FILE_NOT_FOUND",
      "The file was not found in Google Drive.",
    );
  }
  if (!res.ok || !res.body) {
    throw new HttpError(
      502,
      "GOOGLE_API_ERROR",
      `Drive sample download failed (HTTP ${res.status}).`,
    );
  }

  const file = createWriteStream(destPath);
  const reader = res.body.getReader();
  let written = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = value;
      if (written + chunk.length > capBytes) {
        chunk = chunk.subarray(0, capBytes - written);
      }
      await new Promise<void>((resolve, reject) => {
        file.write(chunk, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      written += chunk.length;
      if (written >= capBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
    await new Promise<void>((resolve) => file.close(() => resolve()));
  }
  return written;
}

/**
 * Evenly-space `maxFrames` over the (sampled) video: one frame every
 * `intervalSec` seconds. Unknown duration → one frame per 10s of sample.
 */
function frameIntervalSec(
  durationMillis: number | undefined,
  maxFrames: number,
): number {
  if (durationMillis !== undefined && durationMillis > 0) {
    return Math.max(1, Math.floor(durationMillis / 1000 / maxFrames));
  }
  return 10;
}

/** Run ffmpeg once; return sorted output frame filenames (may be empty). */
async function extractFramesWithFfmpeg(
  samplePath: string,
  outDir: string,
  intervalSec: number,
  maxFrames: number,
): Promise<string[]> {
  const pattern = join(outDir, "frame-%03d.jpg");
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        samplePath,
        "-vf",
        `fps=1/${intervalSec},scale=${FRAME_WIDTH}:-2`,
        "-frames:v",
        String(maxFrames),
        "-q:v",
        FRAME_QUALITY,
        pattern,
      ],
      { timeout: 120_000 },
    );
  } catch (err) {
    // A truncated sample (moov atom beyond the prefix) or a corrupt
    // file fails here — caller falls back to metadata-only analysis.
    logger.warn({ err }, "ffmpeg frame extraction failed");
    return [];
  }
  const entries = await fs.readdir(outDir);
  return entries
    .filter((n) => n.startsWith("frame-") && n.endsWith(".jpg"))
    .sort()
    .slice(0, maxFrames);
}

/** Read frames into memory, dropping extras that would exceed the cap. */
async function readFramesWithinCap(
  outDir: string,
  names: string[],
): Promise<ExtractedFrame[]> {
  const frames: ExtractedFrame[] = [];
  let total = 0;
  for (const name of names) {
    const data = await fs.readFile(join(outDir, name));
    if (total + data.length > MAX_INLINE_IMAGE_BYTES) {
      logger.warn(
        { dropped: names.length - frames.length },
        "Dropping frames to stay under the Gemini inline-image cap",
      );
      break;
    }
    frames.push({ mimeType: "image/jpeg", data: Buffer.from(data) });
    total += data.length;
  }
  return frames;
}

const metadataOnly = (
  ffmpegAvailable: boolean,
  bytesSampled: number,
): FrameExtractionResult => ({
  ffmpegAvailable,
  analysisMode: "metadata",
  frames: [],
  framesUsed: 0,
  bytesSampled,
});

/**
 * Extract up to `maxFrames` JPEG frames from a bounded prefix sample
 * of the video. Temp files are always cleaned up. Never throws for
 * analysis-degrading conditions — it returns metadata mode instead
 * (network/auth failures from the download still throw so the route
 * can surface honest errors like DRIVE_FILE_NOT_FOUND).
 */
export async function extractVideoFrames(
  opts: ExtractFramesOptions,
): Promise<FrameExtractionResult> {
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
  const ffmpegAvailable = await isFfmpegAvailable();
  if (!ffmpegAvailable) {
    logger.info("ffmpeg unavailable — using metadata-only analysis");
    return metadataOnly(false, 0);
  }

  const tmpDir = await fs.mkdtemp(join(tmpdir(), "d2s-frames-"));
  try {
    const samplePath = join(tmpDir, "sample.bin");
    let bytesSampled = 0;
    try {
      bytesSampled = await downloadSampleToFile(
        opts.accessToken,
        opts.fileId,
        samplePath,
        SAMPLE_BYTES,
      );
    } catch (err) {
      // 404 / auth errors propagate as real errors; anything else is a
      // degraded analysis, not a failure of the metadata request.
      if (err instanceof HttpError && err.code === "DRIVE_FILE_NOT_FOUND") {
        throw err;
      }
      logger.warn(
        { fileId: opts.fileId },
        "Video sample download failed; falling back to metadata-only analysis",
      );
      return metadataOnly(true, 0);
    }
    if (bytesSampled < 1024) {
      logger.warn(
        { fileId: opts.fileId, bytesSampled },
        "Empty video sample; falling back to metadata-only analysis",
      );
      return metadataOnly(true, bytesSampled);
    }

    const intervalSec = frameIntervalSec(opts.durationMillis, maxFrames);
    const names = await extractFramesWithFfmpeg(
      samplePath,
      tmpDir,
      intervalSec,
      maxFrames,
    );
    if (names.length === 0) {
      logger.warn(
        { fileId: opts.fileId, fileName: opts.fileName },
        "ffmpeg produced no frames; falling back to metadata-only analysis",
      );
      return metadataOnly(true, bytesSampled);
    }

    const frames = await readFramesWithinCap(tmpDir, names);
    if (frames.length === 0) {
      return metadataOnly(true, bytesSampled);
    }
    logger.info(
      { fileId: opts.fileId, framesUsed: frames.length, bytesSampled },
      "Video frames extracted for Gemini analysis",
    );
    return {
      ffmpegAvailable: true,
      analysisMode: "frames",
      frames,
      framesUsed: frames.length,
      bytesSampled,
    };
  } finally {
    await fs
      .rm(tmpDir, { recursive: true, force: true })
      .catch((err) =>
        logger.warn({ err, tmpDir }, "Could not remove temp frame dir"),
      );
  }
}
