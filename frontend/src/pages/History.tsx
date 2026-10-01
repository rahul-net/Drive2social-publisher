// ============================================================
// Publishing History (Phase 7) — real.
//
// GET /api/history, newest first, with "load more" pagination. Rows
// are written by the upload engines on success (PUBLISHED) and by the
// queue worker on every FAILED terminal state, so this is the full
// record of every publish attempt — not just the wins.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import type { PublishHistory } from "@shared";
import { api } from "../lib/api";
import { Layout } from "../components/Layout";
import { EmptyState, ErrorState, Loading } from "../components/States";

const PAGE_SIZE = 20;

const DESTINATION_LABEL: Record<PublishHistory["destination"], string> = {
  youtube: "YouTube",
  facebook: "Facebook",
};

export function HistoryPage() {
  const [entries, setEntries] = useState<PublishHistory[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [message, setMessage] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  const loadPage = useCallback(async (cursor: string | null, append: boolean) => {
    if (append) setLoadingMore(true);
    else setState("loading");
    const res = await api.listHistory({
      limit: PAGE_SIZE,
      ...(cursor ? { startAfter: cursor } : {}),
    });
    if (res.ok) {
      setEntries((prev) => (append ? [...prev, ...res.data.entries] : res.data.entries));
      setNextCursor(res.data.nextCursor);
      setState("ready");
      setMessage("");
    } else {
      if (!append) setState("failed");
      setMessage(res.error.message);
    }
    if (append) setLoadingMore(false);
  }, []);

  useEffect(() => {
    void loadPage(null, false);
  }, [loadPage]);

  return (
    <Layout title="Publishing History">
      {state === "loading" && <Loading />}
      {state === "failed" && (
        <ErrorState title="Couldn't load history" hint={message} />
      )}
      {state === "ready" &&
        (entries.length === 0 ? (
          <EmptyState
            icon="🕘"
            title="No published posts yet"
            hint="Finished publish jobs — successes and failures — will appear here."
          />
        ) : (
          <>
            <div className="card-list">
              {entries.map((entry) => (
                <div
                  key={entry.id ?? `${entry.destinationId}-${entry.publishedAt}`}
                  className="card"
                >
                  <div className="job-header">
                    <div>
                      <div className="card-title">{entry.fileName}</div>
                      <div className="card-meta">
                        {DESTINATION_LABEL[entry.destination]} →{" "}
                        {entry.destinationAccountName} ·{" "}
                        {new Date(entry.publishedAt).toLocaleString()}
                      </div>
                    </div>
                    <span
                      className={
                        entry.status === "PUBLISHED"
                          ? "badge badge-ok"
                          : "badge badge-error"
                      }
                    >
                      {entry.status}
                    </span>
                  </div>
                  {entry.status === "FAILED" && entry.error && (
                    <div className="notice notice-error" role="alert">
                      <strong>{entry.error.code}:</strong> {entry.error.message}
                    </div>
                  )}
                  {entry.destinationUrl && (
                    <a
                      href={entry.destinationUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="link"
                    >
                      View {entry.destination === "youtube" ? "video" : "post"} ↗
                    </a>
                  )}
                </div>
              ))}
            </div>
            {nextCursor && (
              <div className="load-more">
                <button
                  type="button"
                  className="btn"
                  disabled={loadingMore}
                  onClick={() => void loadPage(nextCursor, true)}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </>
        ))}
    </Layout>
  );
}
