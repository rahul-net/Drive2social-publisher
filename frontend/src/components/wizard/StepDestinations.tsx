// Wizard step 5 — Destinations (Phase 7).
//
// YouTube and Facebook Page checkboxes. Each destination is enabled
// only when it is ACTUALLY connected, verified live against the
// backend:
//   - YouTube: GET /api/youtube/channel succeeds (channel exists and
//     the YouTube scopes were granted).
//   - Facebook: GET /api/meta/pages returns at least one
//     publish-capable Page.
// Not-connected destinations show their status honestly with a
// one-click "Connect" shortcut (and a link to the Accounts page).
// At least one destination must be selected to continue.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Destination } from "@shared";
import { useCreatePost } from "../../contexts/CreatePostContext";
import { useGoogleConnect } from "../../lib/useGoogleConnect";
import { useMetaConnect } from "../../lib/useMetaConnect";
import { youtubeApi, type YouTubeChannel } from "../../lib/youtube";
import { facebookApi } from "../../lib/facebook";
import type { MetaPage } from "@shared";
import { ErrorState, Loading } from "../States";

type ConnState<T> =
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "failed"; message: string };

function DestinationCard({
  icon,
  title,
  connected,
  statusLine,
  checked,
  onToggle,
  connectLabel,
  onConnect,
  connecting,
}: {
  icon: string;
  title: string;
  connected: boolean;
  statusLine: string;
  checked: boolean;
  onToggle: () => void;
  connectLabel: string;
  onConnect: () => void;
  connecting: boolean;
}) {
  return (
    <div className={`dest-card${checked ? " dest-card-selected" : ""}`}>
      <label className="dest-check">
        <input
          type="checkbox"
          checked={checked}
          disabled={!connected}
          onChange={onToggle}
          aria-label={`Publish to ${title}`}
        />
        <span className="dest-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="dest-title">{title}</span>
      </label>
      <div className="dest-status">
        {connected ? (
          <span className="badge badge-ok">Connected</span>
        ) : (
          <span className="badge badge-warn">Not connected</span>
        )}
        <span className="muted">{statusLine}</span>
      </div>
      {!connected && (
        <div className="dest-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={connecting}
            onClick={onConnect}
          >
            {connecting ? "Connecting…" : connectLabel}
          </button>
          <Link to="/accounts" className="link">
            Manage accounts
          </Link>
        </div>
      )}
    </div>
  );
}

export function StepDestinations({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  const { destinations, setDestinations } = useCreatePost();
  const googleConnect = useGoogleConnect();
  const metaConnect = useMetaConnect();

  const [channel, setChannel] = useState<ConnState<YouTubeChannel>>({
    state: "loading",
  });
  const [pages, setPages] = useState<ConnState<MetaPage[]>>({
    state: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    youtubeApi
      .getChannel()
      .then((res) => {
        if (cancelled) return;
        setChannel(
          res.ok
            ? { state: "ready", data: res.data }
            : { state: "failed", message: res.error.message },
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setChannel({
          state: "failed",
          message: err instanceof Error ? err.message : "Request failed",
        });
      });
    facebookApi
      .getPages()
      .then((res) => {
        if (cancelled) return;
        setPages(
          res.ok
            ? { state: "ready", data: res.data }
            : { state: "failed", message: res.error.message },
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPages({
          state: "failed",
          message: err instanceof Error ? err.message : "Request failed",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loading = channel.state === "loading" || pages.state === "loading";

  const youtubeConnected =
    channel.state === "ready" && !!channel.data.channelId;
  const publishablePages =
    pages.state === "ready" ? pages.data.filter((p) => p.canPublish) : [];
  const facebookConnected = publishablePages.length > 0;

  const youtubeStatus =
    channel.state === "ready"
      ? channel.data.title
      : channel.state === "failed"
        ? channel.message
        : "Checking…";
  const facebookStatus =
    pages.state === "ready"
      ? publishablePages.length > 0
        ? publishablePages.map((p) => p.pageName).join(", ")
        : "No publish-capable Page granted yet"
      : pages.state === "failed"
        ? pages.message
        : "Checking…";

  const toggle = (d: Destination) => {
    setDestinations(
      destinations.includes(d)
        ? destinations.filter((x) => x !== d)
        : [...destinations, d],
    );
  };

  // If a destination disconnects while selected, drop it honestly.
  useEffect(() => {
    if (channel.state === "failed" && destinations.includes("youtube")) {
      setDestinations(destinations.filter((d) => d !== "youtube"));
    }
    if (pages.state === "failed" && destinations.includes("facebook")) {
      setDestinations(destinations.filter((d) => d !== "facebook"));
    }
    // Only re-run when the connection states settle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.state, pages.state]);

  return (
    <div>
      <h3 className="step-title">Where should this post go?</h3>
      <p className="muted">
        A destination is selectable only when it is connected right now —
        the status below is checked live, not assumed.
      </p>

      {loading && <Loading />}

      {!loading && (
        <div className="dest-list">
          <DestinationCard
            icon="▶️"
            title="YouTube"
            connected={youtubeConnected}
            statusLine={youtubeStatus}
            checked={destinations.includes("youtube")}
            onToggle={() => toggle("youtube")}
            connectLabel="Connect YouTube"
            onConnect={() => googleConnect.connect("youtube")}
            connecting={googleConnect.connecting}
          />
          <DestinationCard
            icon="📘"
            title="Facebook Page"
            connected={facebookConnected}
            statusLine={facebookStatus}
            checked={destinations.includes("facebook")}
            onToggle={() => toggle("facebook")}
            connectLabel="Connect Facebook"
            onConnect={() => metaConnect.connect()}
            connecting={metaConnect.connecting}
          />
        </div>
      )}

      {channel.state === "failed" && pages.state === "failed" && (
        <ErrorState
          title="Couldn't check connections"
          hint="The backend couldn't verify your YouTube channel or Facebook Pages. Check that the backend is running and your accounts are connected."
        />
      )}

      <div className="wizard-nav">
        <button type="button" className="btn" onClick={onBack}>
          ← Edit metadata
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={destinations.length === 0}
          title={
            destinations.length === 0
              ? "Select at least one connected destination"
              : undefined
          }
          onClick={onNext}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
