// ============================================================
// Dashboard (Phase 7) — real numbers.
//
// Connected accounts from GET /api/accounts; published count and the
// 5 most recent entries from GET /api/history; active/failed counts
// from GET /api/jobs. Counts are computed client-side from a bounded
// fetch window (200 rows — documented, not hidden); a future phase
// can replace this with server-side aggregations if the volume ever
// needs it.
// ============================================================

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ConnectedAccount, PublishHistory, PublishJob } from "@shared";
import { api } from "../lib/api";
import { Layout } from "../components/Layout";
import { EmptyState, ErrorState, Loading } from "../components/States";

/** Bounded window the dashboard counts are computed from. */
const DASHBOARD_WINDOW = 100;

interface DashboardData {
  accounts: ConnectedAccount[];
  jobs: PublishJob[];
  history: PublishHistory[];
}

function StatCard({
  label,
  value,
  link,
}: {
  label: string;
  value: string;
  link: string;
}) {
  return (
    <Link to={link} className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </Link>
  );
}

const DESTINATION_LABEL: Record<PublishHistory["destination"], string> = {
  youtube: "YouTube",
  facebook: "Facebook",
};

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listAccounts(),
      api.listJobs({ limit: DASHBOARD_WINDOW }),
      api.listHistory({ limit: DASHBOARD_WINDOW }),
    ])
      .then(([accountsRes, jobsRes, historyRes]) => {
        if (cancelled) return;
        if (!accountsRes.ok || !jobsRes.ok || !historyRes.ok) {
          setFailed(true);
          setMessage(
            (!accountsRes.ok && accountsRes.error.message) ||
              (!jobsRes.ok && jobsRes.error.message) ||
              (!historyRes.ok && historyRes.error.message) ||
              "Request failed",
          );
          return;
        }
        setData({
          accounts: accountsRes.data,
          jobs: jobsRes.data.jobs,
          history: historyRes.data.entries,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFailed(true);
        setMessage(err instanceof Error ? err.message : "Request failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data && !failed) {
    return (
      <Layout title="Dashboard">
        <Loading />
      </Layout>
    );
  }

  if (failed || !data) {
    return (
      <Layout title="Dashboard">
        <ErrorState
          title="Couldn't reach the backend"
          hint={message || "Start the backend server and check VITE_API_URL."}
        />
      </Layout>
    );
  }

  const googleAccounts = data.accounts.filter((a) => a.provider === "google");
  const driveAccount = googleAccounts.find((a) => a.purpose === "drive");
  const youtubeAccount = googleAccounts.find((a) => a.purpose === "youtube");
  const meta = data.accounts.find((a) => a.provider === "meta");
  const published = data.history.filter((h) => h.status === "PUBLISHED").length;
  const active = data.jobs.filter(
    (j) =>
      j.status === "PENDING" ||
      j.status === "PROCESSING" ||
      j.status === "UPLOADING",
  ).length;
  const failedCount = data.jobs.filter((j) => j.status === "FAILED").length;
  const recent = data.history.slice(0, 5);

  return (
    <Layout title="Dashboard">
      <div className="stat-grid">
        <StatCard
          label="Connected accounts"
          value={String(data.accounts.length)}
          link="/accounts"
        />
        <StatCard label="Published" value={String(published)} link="/history" />
        <StatCard label="Active uploads" value={String(active)} link="/queue" />
        <StatCard label="Failed" value={String(failedCount)} link="/queue" />
      </div>

      <div className="card">
        <h3 className="card-title">Connections</h3>
        <div className="card-meta">
          Google Drive{" "}
          {driveAccount
            ? `— ${driveAccount.accountEmail ?? driveAccount.accountName ?? "connected"}`
            : "— not connected"}
        </div>
        <div className="card-meta">
          YouTube{" "}
          {youtubeAccount
            ? `— ${youtubeAccount.accountEmail ?? youtubeAccount.accountName ?? "connected"}`
            : "— not connected"}
        </div>
        <div className="card-meta">
          Facebook {meta ? `— ${meta.accountName ?? "connected"}` : "— not connected"}
        </div>
        {(!driveAccount || !youtubeAccount || !meta) && (
          <Link to="/accounts" className="btn btn-ghost">
            Connect accounts
          </Link>
        )}
      </div>

      {recent.length > 0 ? (
        <div className="card">
          <h3 className="card-title">Recent activity</h3>
          <div className="card-list">
            {recent.map((h) => (
              <div key={h.id ?? `${h.destinationId}-${h.publishedAt}`} className="recent-row">
                <span
                  className={
                    h.status === "PUBLISHED" ? "badge badge-ok" : "badge badge-error"
                  }
                >
                  {h.status}
                </span>
                <span className="recent-title">{h.fileName}</span>
                <span className="muted">
                  {DESTINATION_LABEL[h.destination]} ·{" "}
                  {new Date(h.publishedAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
          <Link to="/history" className="link">
            View all history →
          </Link>
        </div>
      ) : (
        <EmptyState
          icon="👋"
          title="Welcome to Drive2Social"
          hint="Connect a Google account and a Facebook Page, then create your first post."
          action={
            <Link to="/accounts" className="btn btn-primary">
              Connect accounts
            </Link>
          }
        />
      )}
    </Layout>
  );
}
