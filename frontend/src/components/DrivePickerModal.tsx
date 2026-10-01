// ============================================================
// DrivePickerModal — compact Drive video picker for the Create Post
// wizard (step 1). Search + paginated compact grid, supported videos
// only. On selection the parent stores the file in CreatePostContext.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { DriveVideoFile } from "@shared";
import { api } from "../lib/api";
import { extensionOf, formatBytes, formatDuration } from "../lib/videoFormat";
import { Modal } from "./Modal";
import { EmptyState, ErrorState } from "./States";

const PAGE_SIZE = 24;

interface DrivePickerModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (file: DriveVideoFile) => void;
}

export function DrivePickerModal({
  open,
  onClose,
  onSelect,
}: DrivePickerModalProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [files, setFiles] = useState<DriveVideoFile[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 400);
    return () => window.clearTimeout(t);
  }, [query, open]);

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
      } = { pageSize: PAGE_SIZE, filter: "supported" };
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
        setNotConnected(false);
      } else if (
        res.error.code === "GOOGLE_NOT_CONNECTED" ||
        res.error.code === "GOOGLE_REAUTH_REQUIRED"
      ) {
        setNotConnected(true);
        setFiles([]);
      } else {
        setError(res.error.message);
      }
    },
    [debouncedQuery],
  );

  useEffect(() => {
    if (open) void load({ reset: true });
  }, [open, load]);

  return (
    <Modal open={open} title="Pick a Drive video" onClose={onClose} wide>
      {notConnected ? (
        <EmptyState
          icon="🔗"
          title="Google Drive isn't connected"
          hint="Connect your Google account to browse the videos in your Drive."
          action={
            <Link to="/accounts" className="btn btn-primary">
              Connect Google Drive
            </Link>
          }
        />
      ) : (
        <>
          <input
            type="search"
            className="form-input"
            placeholder="Search videos by name…"
            aria-label="Search videos by name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="picker-results">
            {loading ? (
              <p className="muted">Loading videos…</p>
            ) : error ? (
              <div>
                <ErrorState title="Couldn't load Drive videos" hint={error} />
                <div className="center-row">
                  <button
                    type="button"
                    className="btn"
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
                    : "Your Drive has no videos in a supported format (mp4, mov, avi, mkv, webm)."
                }
              />
            ) : (
              <>
                <ul className="picker-grid">
                  {files.map((f) => (
                    <li key={f.id} className="picker-card">
                      <button
                        type="button"
                        className="picker-card-btn"
                        onClick={() => onSelect(f)}
                        title={`Select ${f.name}`}
                      >
                        <span className="picker-thumb" aria-hidden="true">
                          {f.thumbnailLink ? (
                            <img
                              src={f.thumbnailLink}
                              alt=""
                              loading="lazy"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <span className="video-thumb-icon">🎬</span>
                          )}
                        </span>
                        <span className="picker-card-body">
                          <span className="picker-name">{f.name}</span>
                          <span className="picker-meta">
                            {extensionOf(f.name)} · {formatBytes(f.size)}
                            {f.durationMillis !== undefined &&
                              ` · ${formatDuration(f.durationMillis)}`}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {nextPageToken && (
                  <div className="center-row">
                    <button
                      type="button"
                      className="btn"
                      disabled={loadingMore}
                      onClick={() =>
                        load({ reset: false, token: nextPageToken })
                      }
                    >
                      {loadingMore ? "Loading…" : "Load more"}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
