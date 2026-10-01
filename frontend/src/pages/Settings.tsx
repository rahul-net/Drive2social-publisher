// ============================================================
// Settings — Phase 8.
//
// Four sections:
//   1. Appearance (Phase 1 theme toggle — kept).
//   2. Connected accounts: Google card (scopes, connected date,
//      disconnect w/ confirm — honest note that Drive + YouTube
//      disconnect together), YouTube channel card (honest empty
//      state when not connected), Facebook Pages card (shared with
//      the Accounts page — default-Page radio, publish badges,
//      disconnect w/ honest no-revoke note).
//   3. Publishing defaults: privacy, category, made-for-kids,
//      notify-subscribers, default Facebook Page, default hashtags,
//      description template ({title}/{filename} placeholders).
//   4. Gemini: model picker (shared allowlist) + capability status.
//
// Save → PUT /api/settings; "Reset to defaults" writes the hardcoded
// defaults back to the server (confirm first).
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  DEFAULT_USER_SETTINGS,
  GEMINI_MODEL_ALLOWLIST,
  type ConnectedAccount,
  type MetaPage,
  type UserSettings,
} from "@shared";
import { Layout } from "../components/Layout";
import { Modal } from "../components/Modal";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { FacebookPagesCard } from "../components/FacebookPagesCard";
import { TagInput } from "../components/wizard/TagInput";
import { SCOPE_LABELS } from "./Accounts";
import { useTheme } from "../contexts/ThemeContext";
import { useToast } from "../contexts/ToastContext";
import { api } from "../lib/api";
import { facebookApi } from "../lib/facebook";
import { useApiData } from "../lib/useApiData";
import { useGoogleConnect } from "../lib/useGoogleConnect";
import { youtubeApi, type YouTubeVideoCategory } from "../lib/youtube";
import {
  invalidateUserSettingsCache,
  loadUserSettings,
} from "../lib/settings";

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

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

/** Google account card: identity, scopes, connected date, disconnect. */
function GoogleAccountCard({ account }: { account: ConnectedAccount }) {
  const { notify } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleDisconnect = async () => {
    setBusy(true);
    const res = await api.disconnectGoogle(account.purpose);
    setBusy(false);
    setConfirming(false);
    if (res.ok) {
      notify("success", "Google account disconnected.");
      window.location.reload();
    } else {
      notify("error", `Could not disconnect: ${res.error.message}`);
    }
  };

  const title =
    account.purpose === "youtube"
      ? "YouTube"
      : account.purpose === "drive"
        ? "Google Drive"
        : "Google";
  return (
    <div className="card account-card">
      <div className="card-title">
        {title} · {account.accountName ?? account.accountEmail ?? "connected account"}
      </div>
      {account.accountName && account.accountEmail && (
        <div className="card-meta">{account.accountEmail}</div>
      )}
      <div className="chip-row" aria-label="Granted scopes">
        {account.scopes.map((s) => (
          <span key={s} className="chip" title={s}>
            {scopeLabel(s)}
          </span>
        ))}
      </div>
      <div className="card-meta">
        Connected {new Date(account.createdAt).toLocaleDateString()}
      </div>
      <div>
        <button type="button" className="btn" onClick={() => setConfirming(true)}>
          Disconnect
        </button>
      </div>

      <Modal
        open={confirming}
        title="Disconnect Google?"
        onClose={() => setConfirming(false)}
      >
        <p>
          This revokes Drive2Social's access to{" "}
          <strong>
            {account.accountEmail ?? account.accountName ?? "your Google account"}
          </strong>{" "}
          and removes the stored connection. You can reconnect anytime.
        </p>
        <p className="warning-text">
          ⚠️ Google Drive <em>and</em> YouTube share this one Google
          connection — disconnecting it disconnects both together.
        </p>
        <div className="connect-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void handleDisconnect()}
          >
            {busy ? "Disconnecting…" : "Yes, disconnect"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setConfirming(false)}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </Modal>
    </div>
  );
}

/** YouTube channel card, with an honest empty state when not connected. */
function YouTubeChannelSection() {
  const channel = useApiData(youtubeApi.getChannel);
  const { connecting, connect } = useGoogleConnect();

  if (channel.state === "loading") return <Loading />;
  if (channel.state === "failed") {
    return (
      <div className="card account-card">
        <div className="card-title">📺 YouTube channel</div>
        <EmptyState
          icon="📺"
          title="No YouTube channel connected"
          hint="Connect your Google account with the YouTube scopes to see your channel here and publish to it."
        />
        <div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={connecting}
            onClick={() => void connect("youtube")}
          >
            {connecting ? "Opening Google…" : "Connect YouTube channel"}
          </button>
        </div>
      </div>
    );
  }

  const c = channel.data;
  const stats = [
    c.subscriberCount !== undefined
      ? `${c.subscriberCount.toLocaleString()} subscribers`
      : null,
    c.videoCount !== undefined
      ? `${c.videoCount.toLocaleString()} videos`
      : null,
  ].filter((s): s is string => s !== null);

  return (
    <div className="card account-card">
      <div className="card-title">📺 YouTube channel</div>
      <div className="channel-row">
        {c.thumbnailUrl && (
          <img
            src={c.thumbnailUrl}
            alt=""
            className="channel-thumb"
            referrerPolicy="no-referrer"
          />
        )}
        <div>
          <div className="card-title">{c.title}</div>
          {stats.length > 0 && <div className="card-meta">{stats.join(" · ")}</div>}
        </div>
      </div>
      <p className="warning-text">
        ⚠️ Uploads from unverified OAuth apps are forced to private by
        YouTube — see docs/SETUP.md.
      </p>
    </div>
  );
}

export function SettingsPage() {
  const { theme, toggleTheme } = useTheme();
  const { notify } = useToast();

  // --- settings form state ---
  const [form, setForm] = useState<UserSettings>({ ...DEFAULT_USER_SETTINGS });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // --- supporting data ---
  const accounts = useApiData(api.listAccounts);
  const geminiStatus = useApiData(api.geminiStatus);
  const [categories, setCategories] = useState<YouTubeVideoCategory[] | null>(null);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [pages, setPages] = useState<MetaPage[] | null>(null);
  const [pagesError, setPagesError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    setLoaded(false);
    try {
      invalidateUserSettingsCache();
      const s = await loadUserSettings();
      if (!s) {
        throw new Error(
          "Could not load your settings. Check your connection and that you are signed in.",
        );
      }
      setForm({ ...s });
      setDirty(false);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Could not load settings.",
      );
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // YouTube categories for the default-category picker. On failure
  // (e.g. YouTube not connected) the picker is hidden behind an honest
  // error — the user must connect their channel first.
  useEffect(() => {
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
        if (!cancelled) {
          setCategoriesError(
            err instanceof Error ? err.message : "Request failed",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Granted Pages for the default-Page picker.
  useEffect(() => {
    let cancelled = false;
    facebookApi
      .getPages()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setPages(res.data);
          setPagesError(null);
        } else {
          setPagesError(res.error.message);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPagesError(err instanceof Error ? err.message : "Request failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (patch: Partial<UserSettings>): void => {
    setForm((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };

  /**
   * Set or clear an optional settings key. "" clears it (the key is
   * deleted, never stored as undefined — exactOptionalPropertyTypes).
   */
  const setOptional = (
    key: "defaultPageId" | "geminiModel",
    value: string,
  ): void => {
    setForm((prev) => {
      const next = { ...prev };
      if (value === "") {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    const res = await api.updateUserSettings(form);
    setSaving(false);
    if (res.ok) {
      invalidateUserSettingsCache();
      setForm({ ...res.data.settings });
      setDirty(false);
      notify("success", "Settings saved.");
    } else {
      notify("error", `Could not save settings: ${res.error.message}`);
    }
  };

  const handleReset = async () => {
    setConfirmReset(false);
    setSaving(true);
    const res = await api.updateUserSettings({ ...DEFAULT_USER_SETTINGS });
    setSaving(false);
    if (res.ok) {
      invalidateUserSettingsCache();
      setForm({ ...res.data.settings });
      setDirty(false);
      notify("success", "Settings reset to defaults.");
    } else {
      notify("error", `Could not reset settings: ${res.error.message}`);
    }
  };

  const googleAccounts =
    accounts.state === "ready"
      ? accounts.data.filter((a) => a.provider === "google")
      : [];
  const metaAccount =
    accounts.state === "ready"
      ? accounts.data.find((a) => a.provider === "meta")
      : undefined;

  return (
    <Layout title="Settings">
      {/* --- 1. Appearance (Phase 1, kept) --- */}
      <div className="card">
        <h2 className="card-title">Appearance</h2>
        <label className="setting-row">
          <span>Dark theme</span>
          <input
            type="checkbox"
            checked={theme === "dark"}
            onChange={toggleTheme}
          />
        </label>
      </div>

      {/* --- 2. Connected accounts --- */}
      <div className="card">
        <h2 className="card-title">Connected accounts</h2>
        {accounts.state === "loading" && <Loading />}
        {accounts.state === "failed" && (
          <ErrorState title="Couldn't load accounts" hint={accounts.message} />
        )}
        {accounts.state === "ready" && (
          <>
            {googleAccounts.length > 0 ? (
              googleAccounts.map((acc) => (
                <GoogleAccountCard
                  key={acc.id ?? `${acc.purpose}-${acc.accountEmail}`}
                  account={acc}
                />
              ))
            ) : (
              <EmptyState
                icon="🔗"
                title="Google not connected"
                hint="Connect a Google account on the Accounts page to browse Drive videos and publish to YouTube."
              />
            )}
            <div style={{ marginTop: "1rem" }}>
              <YouTubeChannelSection />
            </div>
            <div style={{ marginTop: "1rem" }}>
              {metaAccount ? (
                <FacebookPagesCard account={metaAccount} />
              ) : (
                <div className="card account-card">
                  <div className="card-title">📘 Facebook</div>
                  <EmptyState
                    icon="📘"
                    title="Facebook not connected"
                    hint="Connect a Facebook account on the Accounts page to publish to your Pages."
                  />
                </div>
              )}
            </div>
            <p className="card-meta" style={{ marginTop: "0.75rem" }}>
              Manage connections in detail on the{" "}
              <Link to="/accounts">Accounts page</Link>.
            </p>
          </>
        )}
      </div>

      {/* --- 3. Publishing defaults --- */}
      <div className="card">
        <h2 className="card-title">Publishing defaults</h2>
        <p className="card-meta">
          These seed the Create Post wizard for every new publish. Changing
          them never touches a draft you already started.
        </p>

        {!loaded && <Loading />}
        {loaded && loadError && (
          <ErrorState title="Couldn't load settings" hint={loadError} />
        )}
        {loaded && !loadError && (
          <>
            <div className="form-field">
              <label htmlFor="pref-privacy">Default privacy</label>
              <select
                id="pref-privacy"
                className="form-select"
                value={form.defaultPrivacy}
                onChange={(e) =>
                  set({
                    defaultPrivacy: e.target.value as UserSettings["defaultPrivacy"],
                  })
                }
              >
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
              </select>
            </div>
            {form.defaultPrivacy !== "private" && (
              <div className="notice notice-warn" role="note">
                <strong>Heads up:</strong> YouTube forces uploads from
                unverified OAuth apps to <strong>private</strong>, no matter
                what you pick here. To publish public/unlisted, verify your
                OAuth consent screen in Google Cloud Console.
              </div>
            )}

            <div className="form-field">
              <label htmlFor="pref-category">Default YouTube category</label>
              {categories === null && !categoriesError && <Loading />}
              {categoriesError && (
                <div className="field-error">
                  Couldn't load categories ({categoriesError}). Connect your
                  YouTube channel to pick a default category.
                </div>
              )}
              {categories && (
                <select
                  id="pref-category"
                  className="form-select"
                  value={form.defaultCategoryId}
                  onChange={(e) => set({ defaultCategoryId: e.target.value })}
                >
                  <option value="">— No default —</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <Toggle
              id="pref-kids"
              label="Made for kids"
              checked={form.defaultMadeForKids}
              onChange={(v) => set({ defaultMadeForKids: v })}
              hint="Limits features like comments and personalized ads on YouTube. Answer honestly — mislabeling can penalize the channel."
            />

            <Toggle
              id="pref-notify"
              label="Notify subscribers"
              checked={form.defaultNotifySubscribers}
              onChange={(v) => set({ defaultNotifySubscribers: v })}
              hint="Subscribers get notified when a public video goes live. Off for quiet uploads."
            />

            <div className="form-field">
              <label htmlFor="pref-page">Default Facebook Page</label>
              {pages === null && !pagesError && <Loading />}
              {pagesError && (
                <div className="field-error">
                  Couldn't load Pages ({pagesError}). Connect Facebook to pick a
                  default Page.
                </div>
              )}
              {pages && (
                <select
                  id="pref-page"
                  className="form-select"
                  value={form.defaultPageId ?? ""}
                  onChange={(e) => setOptional("defaultPageId", e.target.value)}
                >
                  <option value="">Use the account's selected Page</option>
                  {pages.map((p) => (
                    <option
                      key={p.pageId}
                      value={p.pageId}
                      disabled={!p.canPublish}
                    >
                      {p.pageName}
                      {p.canPublish ? "" : " (cannot publish — missing CREATE_CONTENT)"}
                    </option>
                  ))}
                </select>
              )}
              <div className="muted field-hint">
                Used to prefill the Page picker in the wizard. Leave unset to
                use the default Page chosen on the Accounts page.
              </div>
            </div>

            <TagInput
              id="pref-hashtags"
              label="Default hashtags"
              tags={form.defaultHashtags}
              placeholder="Add hashtags with Enter or comma…"
              onChange={(defaultHashtags) => set({ defaultHashtags })}
            />
            <div className="muted field-hint">
              Offered as one-click chips in the wizard's hashtag editor. Stored
              without the leading “#”.
            </div>

            <div className="form-field">
              <label htmlFor="pref-template">Description template</label>
              <textarea
                id="pref-template"
                className="form-textarea"
                rows={5}
                maxLength={5000}
                value={form.defaultDescriptionTemplate}
                placeholder="e.g. New video: {title}&#10;&#10;Filmed on {filename}"
                onChange={(e) =>
                  set({ defaultDescriptionTemplate: e.target.value })
                }
              />
              <div className="muted field-hint">
                Prefills an empty YouTube description in the wizard.
                Placeholders: <code>{"{title}"}</code> (the video title) and{" "}
                <code>{"{filename}"}</code> (the Drive file name).
              </div>
              <div className="char-count">
                {form.defaultDescriptionTemplate.length}/5000
              </div>
            </div>
          </>
        )}
      </div>

      {/* --- 4. Gemini --- */}
      <div className="card">
        <h2 className="card-title">Gemini AI</h2>
        {geminiStatus.state === "loading" && <Loading />}
        {geminiStatus.state === "failed" && (
          <ErrorState title="Couldn't load AI status" hint={geminiStatus.message} />
        )}
        {geminiStatus.state === "ready" && (
          <>
            <div className="form-field">
              <label htmlFor="pref-model">Model for metadata generation</label>
              <select
                id="pref-model"
                className="form-select"
                value={form.geminiModel ?? ""}
                onChange={(e) => setOptional("geminiModel", e.target.value)}
                disabled={!loaded || loadError !== null}
              >
                <option value="">Server default</option>
                {GEMINI_MODEL_ALLOWLIST.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <div className="muted field-hint">
                Your personal override. The API key stays on the server — this
                only picks which model answers.
              </div>
            </div>
            <div className="card-meta">
              Status:{" "}
              {geminiStatus.data.configured ? (
                <span className="badge badge-ok">Configured</span>
              ) : (
                <span className="badge badge-warn">
                  Not configured (set GEMINI_API_KEY on the server)
                </span>
              )}{" "}
              {geminiStatus.data.ffmpegAvailable ? (
                <span className="badge badge-ok">ffmpeg available</span>
              ) : (
                <span className="badge badge-warn">ffmpeg missing</span>
              )}
            </div>
            <p className="card-meta" style={{ marginTop: "0.5rem" }}>
              Effective model: <code>{geminiStatus.data.model}</code>
              {form.geminiModel
                ? dirty
                  ? " (your override — save to apply)"
                  : " (your override)"
                : " (server default)"}
            </p>
            <p className="muted field-hint">
              Analysis mode: when ffmpeg is available, the server extracts
              still frames from your video and Gemini describes what it
              actually sees (“frames” mode). Without ffmpeg it falls back to
              the file name and your topic/transcript only (“metadata” mode).
            </p>
          </>
        )}
      </div>

      {/* --- Save / reset --- */}
      <div className="card">
        <div className="connect-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!dirty || saving || !loaded || loadError !== null}
            onClick={() => void handleSave()}
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={saving || !loaded || loadError !== null}
            onClick={() => setConfirmReset(true)}
          >
            Reset to defaults
          </button>
          {dirty && !saving && (
            <span className="card-meta">Unsaved changes</span>
          )}
        </div>
      </div>

      <Modal
        open={confirmReset}
        title="Reset settings to defaults?"
        onClose={() => setConfirmReset(false)}
      >
        <p>
          This replaces your saved settings with the defaults (private
          privacy, no default category/Page, no template, server-default
          Gemini model). It does not touch an in-progress Create Post draft.
        </p>
        <div className="connect-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => void handleReset()}
          >
            {saving ? "Resetting…" : "Yes, reset"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setConfirmReset(false)}
            disabled={saving}
          >
            Cancel
          </button>
        </div>
      </Modal>
    </Layout>
  );
}
