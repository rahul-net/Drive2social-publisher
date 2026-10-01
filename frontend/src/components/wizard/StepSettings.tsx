// Wizard step 6 — Settings (Phase 7).
//
// YouTube: privacy select (with the unverified-OAuth-app warning when
// anything but private is chosen), category dropdown loaded live from
// GET /api/youtube/categories, made-for-kids checkbox, subscriber
// notification toggle. Facebook: Page selector (defaults to the
// account's selected Page). Live title/caption character counts ride
// along so the metadata limits from step 4 stay visible.

import { useEffect, useState } from "react";
import type { ConnectedAccount, MetaPage } from "@shared";
import { useCreatePost } from "../../contexts/CreatePostContext";
import { api } from "../../lib/api";
import { youtubeApi, type YouTubeVideoCategory } from "../../lib/youtube";
import { facebookApi } from "../../lib/facebook";
import { Loading } from "../States";

const TITLE_LIMIT = 100;
const CAPTION_LIMIT = 63206;

function Toggle({
  id,
  label,
  checked,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="form-field">
      <label className="check-row" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      {hint && <div className="muted field-hint">{hint}</div>}
    </div>
  );
}

export function StepSettings({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  const { destinations, publishSettings, setPublishSettings, metadata } =
    useCreatePost();
  const wantsYoutube = destinations.includes("youtube");
  const wantsFacebook = destinations.includes("facebook");

  const [categories, setCategories] = useState<YouTubeVideoCategory[] | null>(
    null,
  );
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [pages, setPages] = useState<MetaPage[] | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);

  // Load YouTube categories only when YouTube is a destination.
  useEffect(() => {
    if (!wantsYoutube) return;
    let cancelled = false;
    youtubeApi
      .getCategories()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setCategories(res.data);
          setCategoriesError(null);
        } else {
          setCategoriesError(res.error.message);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCategoriesError(
          err instanceof Error ? err.message : "Request failed",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [wantsYoutube]);

  // Load Pages + the account's default selection when Facebook is a
  // destination.
  useEffect(() => {
    if (!wantsFacebook) return;
    let cancelled = false;
    Promise.all([facebookApi.getPages(), api.listAccounts()])
      .then(([pagesRes, accountsRes]) => {
        if (cancelled) return;
        if (pagesRes.ok) {
          setPages(pagesRes.data.filter((p) => p.canPublish));
        }
        if (accountsRes.ok) {
          const meta = accountsRes.data.find(
            (a: ConnectedAccount) => a.provider === "meta",
          );
          setSelectedPageId(meta?.selectedPageId ?? null);
        }
      })
      .catch(() => {
        // Non-fatal: the selector falls back to "default page".
        if (!cancelled) setPages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [wantsFacebook]);

  const set = (
    patch: Partial<typeof publishSettings>,
  ): void => {
    setPublishSettings({ ...publishSettings, ...patch });
  };

  const categoryMissing = wantsYoutube && !publishSettings.categoryId;
  const loadingCategories = wantsYoutube && categories === null && !categoriesError;

  const titleLen = metadata?.youtube_title.length ?? 0;
  const captionLen = metadata?.facebook_caption.length ?? 0;

  return (
    <div>
      <h3 className="step-title">Publish settings</h3>

      {wantsYoutube && (
        <section aria-label="YouTube settings">
          <h4 className="section-title">YouTube</h4>

          <div className="form-field">
            <label htmlFor="set-privacy">Privacy</label>
            <select
              id="set-privacy"
              className="form-select"
              value={publishSettings.privacyStatus}
              onChange={(e) =>
                set({
                  privacyStatus: e.target.value as typeof publishSettings.privacyStatus,
                })
              }
            >
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>
            <div className="char-count">
              Title: {titleLen}/{TITLE_LIMIT}
            </div>
          </div>

          {publishSettings.privacyStatus !== "private" && (
            <div className="notice notice-warn" role="note">
              <strong>Heads up:</strong> YouTube forces uploads from
              unverified OAuth apps to <strong>private</strong>, no matter
              what you pick here. The queue will tell you if that happened
              (look for the privacy notice on the finished job). To publish
              public/unlisted, verify your OAuth consent screen in Google
              Cloud Console.
            </div>
          )}

          <div className="form-field">
            <label htmlFor="set-category">Category</label>
            {loadingCategories && <Loading />}
            {categoriesError && (
              <div className="field-error">
                Couldn't load categories: {categoriesError}
              </div>
            )}
            {categories && (
              <select
                id="set-category"
                className="form-select"
                value={publishSettings.categoryId}
                onChange={(e) => set({ categoryId: e.target.value })}
              >
                <option value="">— Choose a category —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            )}
            {categoryMissing && (
              <div className="field-error">
                YouTube requires a category before publishing.
              </div>
            )}
          </div>

          <Toggle
            id="set-kids"
            label="Made for kids"
            checked={publishSettings.madeForKids}
            onChange={(v) => set({ madeForKids: v })}
            hint="Limits features like comments and personalized ads on YouTube. Answer honestly — mislabeling can penalize the channel."
          />

          <Toggle
            id="set-notify"
            label="Notify subscribers"
            checked={publishSettings.notifySubscribers}
            onChange={(v) => set({ notifySubscribers: v })}
            hint="Subscribers get notified when a public video goes live. Off for quiet uploads."
          />
        </section>
      )}

      {wantsFacebook && (
        <section aria-label="Facebook settings">
          <h4 className="section-title">Facebook Page</h4>
          <div className="form-field">
            <label htmlFor="set-page">Page</label>
            <select
              id="set-page"
              className="form-select"
              value={publishSettings.pageId}
              onChange={(e) => set({ pageId: e.target.value })}
            >
              <option value="">
                {selectedPageId
                  ? `Default page (${pages?.find((p) => p.pageId === selectedPageId)?.pageName ?? selectedPageId})`
                  : "Default page"}
              </option>
              {(pages ?? []).map((p) => (
                <option key={p.pageId} value={p.pageId}>
                  {p.pageName}
                </option>
              ))}
            </select>
            <div className="char-count">
              Caption: {captionLen.toLocaleString()}/
              {CAPTION_LIMIT.toLocaleString()}
            </div>
          </div>
        </section>
      )}

      <div className="wizard-nav">
        <button type="button" className="btn" onClick={onBack}>
          ← Destinations
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={categoryMissing || loadingCategories}
          title={
            categoryMissing
              ? "Choose a YouTube category first"
              : undefined
          }
          onClick={onNext}
        >
          Review & publish
        </button>
      </div>
    </div>
  );
}
