import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ConnectedAccount } from "@shared";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import { useGoogleConnect } from "../lib/useGoogleConnect";
import { useMetaConnect } from "../lib/useMetaConnect";
import { youtubeApi, type YouTubeChannel } from "../lib/youtube";
import { useToast } from "../contexts/ToastContext";
import { Layout } from "../components/Layout";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { Modal } from "../components/Modal";
import { FacebookPagesCard } from "../components/FacebookPagesCard";

/** Friendly labels for granted OAuth scopes (unknown scopes pass through). */
export const SCOPE_LABELS: Record<string, string> = {
  openid: "Sign-in",
  email: "Email",
  profile: "Profile",
  "https://www.googleapis.com/auth/drive.readonly": "Drive · read videos",
  "https://www.googleapis.com/auth/youtube.upload": "YouTube · upload",
  "https://www.googleapis.com/auth/youtube.readonly": "YouTube · read channel",
  // Phase 5: Meta (Facebook Pages) permissions.
  pages_show_list: "Facebook Pages · list",
  pages_read_engagement: "Pages · read engagement",
  pages_manage_posts: "Pages · manage posts",
};

const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

/** Human messages for the ?meta=error&reason=… callback param. */
const META_CALLBACK_REASON_MESSAGES: Record<string, string> = {
  access_denied: "Facebook connection was cancelled.",
  invalid_state: "The sign-in session expired or was already used. Please try again.",
  expired_state: "The sign-in session expired. Please try again.",
  token_exchange_failed: "Could not complete the Facebook connection. Please try again.",
  userinfo_failed: "Could not read your Facebook profile. Please try again.",
  pages_failed: "Connected, but your Facebook Pages could not be read. Please try again.",
  server_not_configured: "The server is not configured for Meta OAuth yet.",
  oauth_error: "Facebook returned an error. Please try again.",
  missing_code: "Facebook did not return an authorization code.",
  invalid_request: "The connection request was invalid. Please try again.",
  callback_failed: "Facebook connection failed unexpectedly. Please try again.",
};
/** Human messages for the ?google=error&reason=… callback param. */
const CALLBACK_REASON_MESSAGES: Record<string, string> = {
  access_denied: "Google connection was cancelled.",
  invalid_state: "The sign-in session expired or was already used. Please try again.",
  expired_state: "The sign-in session expired. Please try again.",
  code_expired: "The authorization code expired. Please try again.",
  token_exchange_failed: "Could not complete the Google connection. Please try again.",
  userinfo_failed: "Could not read your Google profile. Please try again.",
  server_not_configured: "The server is not configured for Google OAuth yet.",
  oauth_error: "Google returned an error. Please try again.",
  missing_code: "Google did not return an authorization code.",
  invalid_request: "The connection request was invalid. Please try again.",
  callback_failed: "Google connection failed unexpectedly. Please try again.",
};

/**
 * Phase 4: YouTube channel card. Rendered only when the Google account
 * has the YouTube scopes; otherwise the "Connect YouTube channel"
 * button (incremental consent) is shown instead.
 */
function YouTubeChannelCard() {
  const channel = useApiData(youtubeApi.getChannel);

  if (channel.state === "loading") return <Loading />;
  if (channel.state === "failed") {
    return (
      <ErrorState
        title="Couldn't load your YouTube channel"
        hint={channel.message}
      />
    );
  }
  return <YouTubeChannelDetails channel={channel.data} />;
}

function formatCount(n: number | undefined, unit: string): string | null {
  if (n === undefined) return null;
  return `${n.toLocaleString()} ${unit}`;
}

function YouTubeChannelDetails({ channel }: { channel: YouTubeChannel }) {
  const stats = [
    formatCount(channel.subscriberCount, "subscribers"),
    formatCount(channel.videoCount, "videos"),
  ].filter((s): s is string => s !== null);
  return (
    <div className="card account-card">
      <div className="card-title">📺 YouTube channel</div>
      <div className="channel-row">
        {channel.thumbnailUrl && (
          <img
            src={channel.thumbnailUrl}
            alt=""
            className="channel-thumb"
            referrerPolicy="no-referrer"
          />
        )}
        <div>
          <div className="card-title">{channel.title}</div>
          {stats.length > 0 && (
            <div className="card-meta">{stats.join(" · ")}</div>
          )}
        </div>
      </div>
      <p className="warning-text">
        ⚠️ Uploads from unverified OAuth apps are forced to private by
        YouTube — see docs/SETUP.md.
      </p>
      <div className="card-meta">
        Disconnecting Google (above) disconnects Drive and YouTube together —
        they share one Google connection.
      </div>
    </div>
  );
}
/**
 * Phase 3: real Google OAuth connect/disconnect.
 * Phase 5: Meta (Facebook Page) OAuth connect/disconnect mirrors the
 * Google flow (useMetaConnect + ?meta=connected toasts).
 */
export function AccountsPage() {
  const { notify } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const { connecting, connect: connectGoogle } = useGoogleConnect();
  const {
    connecting: connectingYouTube,
    connect: connectYouTube,
  } = useGoogleConnect();
  const { connecting: connectingMeta, connect: connectMeta } = useMetaConnect();
  const [disconnecting, setDisconnecting] = useState<ConnectedAccount | null>(null);
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const accounts = useApiData(api.listAccounts);

  // Handle the OAuth callback landings:
  // ?google=connected | ?google=error&reason=… and the ?meta=… equivalents.
  useEffect(() => {
    const googleStatus = searchParams.get("google");
    const metaStatus = searchParams.get("meta");
    if (!googleStatus && !metaStatus) return;
    if (googleStatus === "connected") {
      notify("success", "Google account connected.");
    } else if (googleStatus === "error") {
      const reason = searchParams.get("reason") ?? "callback_failed";
      notify(
        "error",
        CALLBACK_REASON_MESSAGES[reason] ??
          CALLBACK_REASON_MESSAGES["callback_failed"]!,
      );
    }
    if (metaStatus === "connected") {
      notify("success", "Facebook account connected.");
    } else if (metaStatus === "error") {
      const reason = searchParams.get("reason") ?? "callback_failed";
      notify(
        "error",
        META_CALLBACK_REASON_MESSAGES[reason] ??
          META_CALLBACK_REASON_MESSAGES["callback_failed"]!,
      );
    }
    // Clean the URL so a refresh doesn't re-toast.
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDisconnectGoogle = async (purpose?: "drive" | "youtube") => {
    setDisconnectBusy(true);
    const res = await api.disconnectGoogle(purpose);
    setDisconnectBusy(false);
    setDisconnecting(null);
    if (res.ok) {
      notify("success", "Google account disconnected.");
      window.location.reload();
    } else {
      notify("error", `Could not disconnect: ${res.error.message}`);
    }
  };

  const driveAccount =
    accounts.state === "ready"
      ? accounts.data.find(
          (a) => a.provider === "google" && a.purpose === "drive",
        )
      : undefined;
  const youtubeAccount =
    accounts.state === "ready"
      ? accounts.data.find(
          (a) => a.provider === "google" && a.purpose === "youtube",
        )
      : undefined;
  // Backward compat: a legacy single Google account without purpose.
  const legacyGoogleAccount =
    accounts.state === "ready"
      ? accounts.data.find(
          (a) => a.provider === "google" && a.purpose === undefined,
        )
      : undefined;
  const googleAccount = driveAccount ?? youtubeAccount ?? legacyGoogleAccount;
  const hasYouTube =
    youtubeAccount?.scopes.includes(YOUTUBE_UPLOAD_SCOPE) ??
    (googleAccount?.scopes.includes(YOUTUBE_UPLOAD_SCOPE) ?? false);
  const metaAccount =
    accounts.state === "ready"
      ? accounts.data.find((a) => a.provider === "meta")
      : undefined;

  return (
    <Layout title="Connected Accounts">
      <div className="connect-row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => connectGoogle("drive")}
          disabled={connecting}
        >
          {connecting
            ? "Opening Google…"
            : driveAccount
              ? "Reconnect Google Drive"
              : "Connect Google Drive"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => connectYouTube("youtube")}
          disabled={connectingYouTube}
        >
          {connectingYouTube
            ? "Opening Google…"
            : youtubeAccount
              ? "Reconnect YouTube channel"
              : "Connect YouTube channel"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void connectMeta()}
          disabled={connectingMeta}
        >
          {connectingMeta
            ? "Opening Facebook…"
            : metaAccount
              ? "Reconnect Facebook"
              : "Connect Facebook Page"}
        </button>
      </div>

      {hasYouTube && (
        <div className="card-list" style={{ marginTop: "1rem" }}>
          <YouTubeChannelCard />
        </div>
      )}

      {metaAccount && (
        <div className="card-list" style={{ marginTop: "1rem" }}>
          <FacebookPagesCard account={metaAccount} />
        </div>
      )}

      {accounts.state === "loading" && <Loading />}
      {accounts.state === "failed" && (
        <ErrorState title="Couldn't load accounts" hint={accounts.message} />
      )}
      {accounts.state === "ready" &&
        (accounts.data.length === 0 ? (
          <EmptyState
            icon="🔗"
            title="No accounts connected"
            hint="Connect a Google account to browse your Drive videos and YouTube channel, or connect a Facebook Page to publish there."
          />
        ) : (
          <div className="card-list">
            {accounts.data.map((acc) => (
              <div
                key={acc.id ?? `${acc.provider}-${acc.accountEmail}`}
                className="card account-card"
              >
                <div className="card-title">
                  {acc.provider === "google"
                    ? acc.purpose === "youtube"
                      ? "YouTube"
                      : acc.purpose === "drive"
                        ? "Google Drive"
                        : "Google"
                    : "Meta"}{" "}
                  · {acc.accountName ?? acc.accountEmail ?? acc.provider}
                </div>
                {acc.accountName && acc.accountEmail && (
                  <div className="card-meta">{acc.accountEmail}</div>
                )}
                <div className="card-meta">
                  {acc.channelTitle ?? acc.pageName ?? "—"}
                </div>
                <div className="chip-row" aria-label="Granted scopes">
                  {acc.scopes.map((s) => (
                    <span key={s} className="chip" title={s}>
                      {scopeLabel(s)}
                    </span>
                  ))}
                </div>
                <div className="card-meta">
                  Connected {new Date(acc.createdAt).toLocaleDateString()}
                </div>
                {acc.provider === "google" && (
                  <div>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setDisconnecting(acc)}
                    >
                      Disconnect
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}

      <Modal
        open={disconnecting !== null}
        title={
          disconnecting?.purpose === "youtube"
            ? "Disconnect YouTube?"
            : disconnecting?.purpose === "drive"
              ? "Disconnect Google Drive?"
              : "Disconnect Google?"
        }
        onClose={() => setDisconnecting(null)}
      >
        <p>
          This revokes Drive2Social's access to{" "}
          <strong>
            {disconnecting?.accountEmail ?? disconnecting?.accountName ?? "your Google account"}
          </strong>{" "}
          {disconnecting?.purpose === "youtube"
            ? "for YouTube"
            : disconnecting?.purpose === "drive"
              ? "for Google Drive"
              : ""}
          {" "}and removes the stored connection. Your other Google
          connection (if any) is not affected. You can reconnect anytime.
        </p>
        <div className="connect-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={disconnectBusy}
            onClick={() =>
              disconnecting && handleDisconnectGoogle(disconnecting.purpose)
            }
          >
            {disconnectBusy ? "Disconnecting…" : "Yes, disconnect"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setDisconnecting(null)}
            disabled={disconnectBusy}
          >
            Cancel
          </button>
        </div>
      </Modal>
    </Layout>
  );
}
