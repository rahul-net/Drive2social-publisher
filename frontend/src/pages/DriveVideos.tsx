import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { DriveVideoFile } from "@shared";
import { api, apiBaseUrl } from "../lib/api";
import { formatBytes, formatDuration, extensionOf } from "../lib/videoFormat";
import { useGoogleConnect } from "../lib/useGoogleConnect";
import { saveSelectedDriveFile } from "../lib/driveSelection";
import { useToast } from "../contexts/ToastContext";
import { Layout } from "../components/Layout";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { Modal } from "../components/Modal";

// ============================================================
// Drive Videos — Phase 3 file browser.
//
// Search (debounced), Supported/All filter, paginated grid, and a
// detail/preview modal whose <video> plays through the signed
// preview URL (the video tag can't send Authorization headers).
// "Use in Create Post" persists the selection for the Phase 6 wizard
// via sessionStorage + router state.
// ============================================================

type Filter = "supported" | "all";
type AuthIssue = "not_connected" | "reauth" | null;

const PAGE_SIZE = 24;

function SkeletonGrid() {
  return (
    <div className="video-grid" aria-label="Loading videos">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="video-card" aria-hidden="true">
          <div className="skeleton skeleton-thumb" />
          <div className="video-card-body">
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line short" />
          </div>
        </div>
      ))}
    </div>
  );
}

function VideoCard({
  file,
  onSelect,
}: {
  file: DriveVideoFile;
  onSelect: (file: DriveVideoFile) => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const ext = extensionOf(file.name);
  return (
    <button
      type="button"
      className="video-card"
      onClick={() => onSelect(file)}
      title={file.supportReason ?? file.name}
    >
      <div className="video-thumb">
        {file.thumbnailLink && !thumbFailed ? (
          <img
            src={file.thumbnailLink}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <span className="video-thumb-icon" aria-hidden="true">
            🎬
          </span>
        )}
      </div>
      <div className="video-card-body">
        <div className="video-name">{file.name}</div>
        <div className="video-meta">
          {formatBytes(file.size)} ·{" "}
          {new Date(file.modifiedTime).toLocaleDateString()}
          {file.durationMillis !== undefined &&
            ` · ${formatDuration(file.durationMillis)}`}
        </div>
        <div className="badge-row">
          {ext && <span className="badge">{ext}</span>}
          {file.supported === false ? (
            <span className="badge badge-warn" title={file.supportReason}>
              Unsupported
            </span>
          ) : (
            <span className="badge badge-ok">Supported</span>
          )}
        </div>
      </div>
    </button>
  );
}

export function DriveVideosPage() {
  const { notify } = useToast();
  const navigate = useNavigate();
  const { connecting, connect } = useGoogleConnect();

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("supported");

  const [files, setFiles] = useState<DriveVideoFile[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authIssue, setAuthIssue] = useState<AuthIssue>(null);
  const requestId = useRef(0);

  const [selected, setSelected] = useState<DriveVideoFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 400);
    return () => window.clearTimeout(t);
  }, [query]);

  const load = useCallback(
    async (opts: { reset: boolean; token?: string }) => {
      const id = ++requestId.current;
      if (opts.reset) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }
      // exactOptionalPropertyTypes: only set optional params when present.
      const params: {
        q?: string;
        pageSize?: number;
        pageToken?: string;
        filter?: "supported" | "all";
      } = { pageSize: PAGE_SIZE, filter };
      if (debouncedQuery) params.q = debouncedQuery;
      if (opts.token) params.pageToken = opts.token;
      const res = await api.listDriveFiles(params);
      if (id !== requestId.current) return; // stale response
      if (opts.reset) setLoading(false);
      else setLoadingMore(false);

      if (res.ok) {
        setFiles((prev) =>
          opts.reset ? res.data.files : [...prev, ...res.data.files],
        );
        setNextPageToken(res.data.nextPageToken);
        setError(null);
        setAuthIssue(null);
      } else if (res.error.code === "GOOGLE_NOT_CONNECTED") {
        setAuthIssue("not_connected");
        setFiles([]);
      } else if (res.error.code === "GOOGLE_REAUTH_REQUIRED") {
        setAuthIssue("reauth");
        setFiles([]);
      } else {
        setError(res.error.message);
      }
    },
    [debouncedQuery, filter],
  );

  useEffect(() => {
    void load({ reset: true });
  }, [load]);

  // Fetch a short-lived signed preview URL when the modal opens.
  useEffect(() => {
    if (!selected) {
      setPreviewUrl(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    setPreviewUrl(null);
    setPreviewError(null);
    api
      .getDrivePreviewToken(selected.id)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setPreviewUrl(apiBaseUrl() + res.data.url);
        } else {
          setPreviewError(res.error.message);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPreviewError(
            err instanceof Error ? err.message : "Could not load preview",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const handleUseInCreatePost = (file: DriveVideoFile) => {
    saveSelectedDriveFile(file);
    setSelected(null);
    navigate("/create", { state: { driveFile: file } });
    notify("success", `Selected “${file.name}” for your post.`);
  };

  return (
    <Layout title="Drive Videos">
      {authIssue ? (
        <EmptyState
          icon="🔗"
          title={
            authIssue === "not_connected"
              ? "Google Drive isn't connected"
              : "Google connection expired"
          }
          hint={
            authIssue === "not_connected"
              ? "Connect your Google account to browse the videos in your Drive."
              : "Google revoked or expired our access. Reconnect to keep browsing your Drive videos."
          }
          action={
            authIssue === "not_connected" ? (
              <Link to="/accounts" className="btn btn-primary">
                Connect Google Drive
              </Link>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => connect("drive")}
                disabled={connecting}
              >
                {connecting ? "Opening Google…" : "Reconnect Google Drive"}
              </button>
            )
          }
        />
      ) : (
        <>
          <div className="drive-toolbar">
            <input
              type="search"
              className="drive-search"
              placeholder="Search videos by name…"
              aria-label="Search videos by name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="filter-toggle" role="group" aria-label="Video filter">
              <button
                type="button"
                className={filter === "supported" ? "btn btn-primary" : "btn"}
                onClick={() => setFilter("supported")}
              >
                Supported videos
              </button>
              <button
                type="button"
                className={filter === "all" ? "btn btn-primary" : "btn"}
                onClick={() => setFilter("all")}
              >
                All videos
              </button>
            </div>
          </div>

          {loading ? (
            <SkeletonGrid />
          ) : error ? (
            <div>
              <ErrorState title="Couldn't load Drive videos" hint={error} />
              <div className="center-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => load({ reset: true })}
                >
                  Retry
                </button>
              </div>
            </div>
          ) : files.length === 0 ? (
            <EmptyState
              icon="🎬"
              title="No videos found"
              hint={
                debouncedQuery
                  ? `Nothing in your Drive matched “${debouncedQuery}”.`
                  : filter === "supported"
                    ? "Your Drive has no videos in a supported format (mp4, mov, avi, mkv, webm)."
                    : "Your Drive has no videos yet."
              }
            />
          ) : (
            <>
              <div className="video-grid">
                {files.map((f) => (
                  <VideoCard key={f.id} file={f} onSelect={setSelected} />
                ))}
              </div>
              {nextPageToken && (
                <div className="center-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={loadingMore}
                    onClick={() => load({ reset: false, token: nextPageToken })}
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      <Modal
        open={selected !== null}
        title={selected?.name ?? "Preview"}
        onClose={() => setSelected(null)}
        wide
      >
        {selected && (
          <>
            {previewError ? (
              <ErrorState title="Couldn't load preview" hint={previewError} />
            ) : !previewUrl ? (
              <Loading />
            ) : (
              <video
                className="preview-video"
                controls
                playsInline
                preload="metadata"
                src={previewUrl}
              />
            )}
            <div className="preview-meta">
              <span>
                {formatBytes(selected.size)} · {selected.mimeType}
                {selected.durationMillis !== undefined &&
                  ` · ${formatDuration(selected.durationMillis)}`}
                {selected.width !== undefined &&
                  selected.height !== undefined &&
                  ` · ${selected.width}×${selected.height}`}
              </span>
              {selected.supported === false ? (
                <span className="badge badge-warn" title={selected.supportReason}>
                  Unsupported — {selected.supportReason}
                </span>
              ) : (
                <span className="badge badge-ok">Supported</span>
              )}
            </div>
            <div className="connect-row preview-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleUseInCreatePost(selected)}
              >
                Use in Create Post
              </button>
            </div>
          </>
        )}
      </Modal>
    </Layout>
  );
}
