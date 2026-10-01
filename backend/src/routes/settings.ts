// ============================================================
// User settings — mounted at /api/settings (Phase 8).
//
// Per-user publishing defaults + AI preferences, stored in
// Firestore `settings/{uid}`. Every read/write is ownership-checked
// via requireAuth: the doc id is always req.user.uid, so a user can
// only ever touch their own settings.
//
//   GET /api/settings — merged settings over hardcoded defaults
//   PUT /api/settings — zod-validated upsert (normalizes hashtags)
//
// Cross-validation:
//   - defaultPageId (when set) must belong to the user's Meta Pages
//     (their connectedAccounts/{uid}_meta doc) — else 400 UNKNOWN_PAGE.
//   - defaultCategoryId (when set) is checked against the YouTube
//     categories API when the user has YouTube connected — an API
//     failure accepts the value with a warning, never hard-fails.
//   - geminiModel is constrained to GEMINI_MODEL_ALLOWLIST (shared).
// ============================================================

import { Router } from "express";
import { z } from "zod";
import {
  GEMINI_MODEL_ALLOWLIST,
  DEFAULT_USER_SETTINGS,
  type ApiResponse,
  type UserSettings,
} from "@drive2social/shared";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/requireAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireUid } from "../lib/authRequest.js";
import { getDb } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { getMetaTokenDoc } from "../lib/metaOAuth.js";
import { listVideoCategories } from "../services/youtube.js";

export const settingsRouter = Router();

// --- zod input -----------------------------------------------------

const MAX_HASHTAGS = 20;
const MAX_HASHTAG_LENGTH = 50;
const MAX_DESCRIPTION_TEMPLATE_LENGTH = 5000;

const userSettingsSchema = z.object({
  defaultPrivacy: z.enum(["public", "unlisted", "private"]),
  defaultCategoryId: z.string().trim().max(16),
  defaultMadeForKids: z.boolean(),
  defaultNotifySubscribers: z.boolean(),
  defaultPageId: z.string().trim().min(1).max(256).optional(),
  defaultHashtags: z.array(z.string().max(64)).max(MAX_HASHTAGS),
  defaultDescriptionTemplate: z
    .string()
    .max(MAX_DESCRIPTION_TEMPLATE_LENGTH),
  geminiModel: z.enum(GEMINI_MODEL_ALLOWLIST).optional(),
});

type ParsedUserSettings = z.infer<typeof userSettingsSchema>;

/**
 * Normalize one hashtag for storage: strip leading "#", trim,
 * collapse inner whitespace away (hashtags are single words).
 */
function normalizeHashtag(raw: string): string {
  return raw.trim().replace(/^#+/, "").replace(/\s+/g, "");
}

/**
 * Normalize the hashtag list: per-tag normalization, drop empties,
 * enforce ≤ 50 chars each and ≤ 20 items, dedupe case-insensitively.
 * Throws HttpError(400, INVALID_HASHTAGS) on violations.
 */
function normalizeHashtags(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const tag = normalizeHashtag(item);
    if (!tag) continue; // stripped to nothing — drop, don't 400
    if (tag.length > MAX_HASHTAG_LENGTH) {
      throw new HttpError(
        400,
        "INVALID_HASHTAGS",
        `Hashtag "${tag.slice(0, 30)}…" is longer than ${MAX_HASHTAG_LENGTH} characters.`,
      );
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  if (out.length > MAX_HASHTAGS) {
    throw new HttpError(
      400,
      "INVALID_HASHTAGS",
      `At most ${MAX_HASHTAGS} default hashtags are allowed.`,
    );
  }
  return out;
}

// --- stored-doc access -----------------------------------------------

function settingsDocId(uid: string): string {
  return uid;
}

/**
 * Best-effort read of the user's stored settings. Never throws:
 * returns null when the doc is missing, malformed, or unreadable
 * (e.g. Firestore unconfigured — the caller falls back to defaults).
 */
export async function getStoredSettings(
  uid: string,
): Promise<Partial<UserSettings> | null> {
  try {
    const snap = await getDb().doc(`settings/${settingsDocId(uid)}`).get();
    if (!snap.exists) return null;
    return snap.data() as Partial<UserSettings>;
  } catch (err) {
    logger.debug(
      { uid, err: err instanceof Error ? err.message : String(err) },
      "settings: best-effort read failed; falling back to defaults",
    );
    return null;
  }
}

/**
 * Merge a stored (possibly partial/malformed) doc over the hardcoded
 * defaults, sanitizing field-by-field. Never throws: garbage falls
 * back to defaults with a warning.
 */
export function mergeSettings(
  stored: Partial<UserSettings> | null,
): UserSettings {
  if (!stored) return { ...DEFAULT_USER_SETTINGS };
  const merged: UserSettings = { ...DEFAULT_USER_SETTINGS };
  if (
    stored.defaultPrivacy === "public" ||
    stored.defaultPrivacy === "unlisted" ||
    stored.defaultPrivacy === "private"
  ) {
    merged.defaultPrivacy = stored.defaultPrivacy;
  }
  if (
    typeof stored.defaultCategoryId === "string" &&
    stored.defaultCategoryId.length <= 16
  ) {
    merged.defaultCategoryId = stored.defaultCategoryId;
  }
  if (typeof stored.defaultMadeForKids === "boolean") {
    merged.defaultMadeForKids = stored.defaultMadeForKids;
  }
  if (typeof stored.defaultNotifySubscribers === "boolean") {
    merged.defaultNotifySubscribers = stored.defaultNotifySubscribers;
  }
  if (
    typeof stored.defaultPageId === "string" &&
    stored.defaultPageId.length > 0
  ) {
    merged.defaultPageId = stored.defaultPageId;
  }
  if (Array.isArray(stored.defaultHashtags)) {
    merged.defaultHashtags = stored.defaultHashtags.filter(
      (h): h is string => typeof h === "string",
    );
  }
  if (typeof stored.defaultDescriptionTemplate === "string") {
    merged.defaultDescriptionTemplate = stored.defaultDescriptionTemplate.slice(
      0,
      MAX_DESCRIPTION_TEMPLATE_LENGTH,
    );
  }
  if (
    typeof stored.geminiModel === "string" &&
    (GEMINI_MODEL_ALLOWLIST as readonly string[]).includes(stored.geminiModel)
  ) {
    merged.geminiModel = stored.geminiModel;
  }
  return merged;
}

// --- cross-validation --------------------------------------------------

/**
 * defaultPageId must belong to the user's Meta Pages. Rejects with
 * 400 UNKNOWN_PAGE when the user has no Meta connection or the Page
 * wasn't granted to them.
 */
async function validateDefaultPageId(
  uid: string,
  pageId: string | undefined,
): Promise<void> {
  if (!pageId) return;
  const doc = await getMetaTokenDoc(uid);
  const known = doc?.pages.some((p) => p.pageId === pageId) ?? false;
  if (!known) {
    throw new HttpError(
      400,
      "UNKNOWN_PAGE",
      "This Facebook Page is not connected to your account. Choose one of your granted Pages, or leave the default Page unset.",
    );
  }
}

/**
 * defaultCategoryId (when set) is validated against the YouTube
 * categories API when the user has YouTube connected. An API failure
 * (not connected, network, ...) accepts the value with a warning —
 * never hard-fails.
 */
async function validateDefaultCategoryId(
  uid: string,
  categoryId: string,
): Promise<void> {
  if (!categoryId) return; // "" = unset
  try {
    const categories = await listVideoCategories(uid, "US");
    if (
      categories.length > 0 &&
      !categories.some((c) => c.id === categoryId)
    ) {
      throw new HttpError(
        400,
        "INVALID_CATEGORY",
        `Unknown YouTube category "${categoryId}". Pick one from the category list.`,
      );
    }
  } catch (err) {
    if (err instanceof HttpError && err.code === "INVALID_CATEGORY") throw err;
    // Don't hard-fail: accept the value, warn server-side.
    logger.warn(
      { uid, err: err instanceof Error ? err.message : String(err) },
      "settings: could not validate YouTube category against the API; accepting value",
    );
  }
}

// --- routes --------------------------------------------------------------

/**
 * GET /api/settings — the user's effective settings: their stored
 * `settings/{uid}` doc merged over hardcoded defaults.
 */
settingsRouter.get(
  "/",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const settings = mergeSettings(await getStoredSettings(uid));
      const body: ApiResponse<{ settings: UserSettings }> = {
        ok: true,
        data: { settings },
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * PUT /api/settings — validate + upsert `settings/{uid}`.
 * Hashtags are normalized (leading "#" stripped) before storage.
 */
settingsRouter.put(
  "/",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const parsed: ParsedUserSettings = userSettingsSchema.parse(req.body);

      // Cross-validation before any write.
      await validateDefaultPageId(uid, parsed.defaultPageId);
      await validateDefaultCategoryId(uid, parsed.defaultCategoryId);

      const settings: UserSettings = {
        defaultPrivacy: parsed.defaultPrivacy,
        defaultCategoryId: parsed.defaultCategoryId,
        defaultMadeForKids: parsed.defaultMadeForKids,
        defaultNotifySubscribers: parsed.defaultNotifySubscribers,
        defaultHashtags: normalizeHashtags(parsed.defaultHashtags),
        defaultDescriptionTemplate: parsed.defaultDescriptionTemplate,
      };
      // exactOptionalPropertyTypes: only set optional fields when present.
      if (parsed.defaultPageId !== undefined) {
        settings.defaultPageId = parsed.defaultPageId;
      }
      if (parsed.geminiModel !== undefined) {
        settings.geminiModel = parsed.geminiModel;
      }

      await getDb()
        .doc(`settings/${settingsDocId(uid)}`)
        .set({ ...settings, updatedAt: new Date().toISOString() });
      logger.info({ uid }, "User settings saved");

      const body: ApiResponse<{ settings: UserSettings }> = {
        ok: true,
        data: { settings },
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);
