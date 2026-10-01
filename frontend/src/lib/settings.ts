// ============================================================
// User settings helpers — Phase 8.
//
// loadUserSettings(): cached GET /api/settings so the wizard (seed
// publish settings), Step 4 (description template + default hashtag
// chips), and the Settings page don't each fire their own request.
// Call invalidateUserSettingsCache() after a successful PUT so the
// next read sees the saved values.
//
// applyDescriptionTemplate(): substitutes the {title} and {filename}
// placeholders supported by the description template.
// ============================================================

import { DEFAULT_USER_SETTINGS, type UserSettings } from "@shared";
import { api } from "./api";

/** Re-exported for form resets and seeding fallbacks. */
export { DEFAULT_USER_SETTINGS };

const CACHE_TTL_MS = 60_000;

let cache: { value: UserSettings | null; at: number } | null = null;

/** Drop the cached settings (call after a successful PUT /api/settings). */
export function invalidateUserSettingsCache(): void {
  cache = null;
}

/** Defensively normalize a server settings payload (field-by-field). */
function normalizeSettings(raw: unknown): UserSettings {
  const base: UserSettings = { ...DEFAULT_USER_SETTINGS };
  if (typeof raw !== "object" || raw === null) return base;
  const s = raw as Partial<UserSettings>;
  if (
    s.defaultPrivacy === "public" ||
    s.defaultPrivacy === "unlisted" ||
    s.defaultPrivacy === "private"
  ) {
    base.defaultPrivacy = s.defaultPrivacy;
  }
  if (typeof s.defaultCategoryId === "string") {
    base.defaultCategoryId = s.defaultCategoryId;
  }
  if (typeof s.defaultMadeForKids === "boolean") {
    base.defaultMadeForKids = s.defaultMadeForKids;
  }
  if (typeof s.defaultNotifySubscribers === "boolean") {
    base.defaultNotifySubscribers = s.defaultNotifySubscribers;
  }
  if (typeof s.defaultPageId === "string" && s.defaultPageId.length > 0) {
    base.defaultPageId = s.defaultPageId;
  }
  if (Array.isArray(s.defaultHashtags)) {
    base.defaultHashtags = s.defaultHashtags.filter(
      (h): h is string => typeof h === "string",
    );
  }
  if (typeof s.defaultDescriptionTemplate === "string") {
    base.defaultDescriptionTemplate = s.defaultDescriptionTemplate;
  }
  if (typeof s.geminiModel === "string" && s.geminiModel.length > 0) {
    base.geminiModel = s.geminiModel;
  }
  return base;
}

/**
 * GET /api/settings (cached 60s). Resolves null when the request
 * fails — e.g. signed out (401) or the server is unreachable — so
 * callers fall back to local defaults instead of crashing.
 */
export async function loadUserSettings(): Promise<UserSettings | null> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  const res = await api.getUserSettings();
  const value = res.ok ? normalizeSettings(res.data.settings) : null;
  cache = { value, at: now };
  return value;
}

/**
 * Substitute the description-template placeholders.
 * Supported: {title} (the video's YouTube title, may be empty),
 * {filename} (the Drive file name). Unknown {…} tokens are left as-is.
 */
export function applyDescriptionTemplate(
  template: string,
  values: { title: string; filename: string },
): string {
  return template
    .replaceAll("{title}", values.title)
    .replaceAll("{filename}", values.filename);
}
