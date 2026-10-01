// ============================================================
// FacebookPagesCard — shared by the Accounts and Settings pages
// (extracted from Accounts.tsx in Phase 8).
//
// Lists the granted Pages with a radio picker for the default
// publishing Page, per-Page publish-capability badges, and
// disconnect. Honest notices about app review and Pages-only
// publishing are always visible.
//
// Disconnect limitation (honest, not faked): Meta provides no
// token-revoke endpoint for this login flow, so disconnecting only
// deletes Drive2Social's stored copy of the Page tokens — the user
// must also remove the app at facebook.com → Settings → Apps.
// ============================================================

import { useState } from "react";
import type { ConnectedAccount } from "@shared";
import { api } from "../lib/api";
import { facebookApi } from "../lib/facebook";
import { useApiData } from "../lib/useApiData";
import { useToast } from "../contexts/ToastContext";
import { EmptyState, ErrorState, Loading } from "./States";
import { Modal } from "./Modal";

export function FacebookPagesCard({
  account,
}: {
  account: ConnectedAccount;
}) {
  const { notify } = useToast();
  const pages = useApiData(facebookApi.getPages);
  const [selected, setSelected] = useState<string | undefined>(
    account.selectedPageId,
  );
  const [selecting, setSelecting] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnectBusy, setDisconnectBusy] = useState(false);

  const handleSelect = async (pageId: string) => {
    setSelecting(pageId);
    const res = await facebookApi.selectPage(pageId);
    setSelecting(null);
    if (res.ok) {
      setSelected(res.data.selectedPageId);
      notify("success", "Default Facebook Page updated.");
    } else {
      notify("error", `Could not select Page: ${res.error.message}`);
    }
  };

  const handleDisconnect = async () => {
    setDisconnectBusy(true);
    const res = await api.disconnectMeta();
    setDisconnectBusy(false);
    setConfirmingDisconnect(false);
    if (res.ok) {
      notify("success", "Facebook account disconnected.");
      window.location.reload();
    } else {
      notify("error", `Could not disconnect: ${res.error.message}`);
    }
  };

  return (
    <div className="card account-card">
      <div className="card-title">
        📘 Facebook · {account.accountName ?? "connected account"}
      </div>

      {pages.state === "loading" && <Loading />}
      {pages.state === "failed" && (
        <ErrorState title="Couldn't load your Pages" hint={pages.message} />
      )}
      {pages.state === "ready" &&
        (pages.data.length === 0 ? (
          <EmptyState
            icon="📄"
            title="No Pages granted"
            hint="Reconnect Facebook and make sure at least one Page is selected in the Facebook permission dialog."
          />
        ) : (
          <div role="radiogroup" aria-label="Default Facebook Page">
            <div className="card-meta" style={{ marginBottom: "0.5rem" }}>
              Choose the default Page for publishing:
            </div>
            {pages.data.map((p) => (
              <label
                key={p.pageId}
                className={
                  p.canPublish ? "page-row" : "page-row page-row-disabled"
                }
                title={
                  p.canPublish
                    ? p.pageName
                    : `${p.pageName} — the connected Facebook user lacks the CREATE_CONTENT task on this Page`
                }
              >
                <input
                  type="radio"
                  name="fb-default-page"
                  checked={selected === p.pageId}
                  disabled={selecting !== null || !p.canPublish}
                  onChange={() => void handleSelect(p.pageId)}
                />
                <span className="page-name">{p.pageName}</span>
                {selecting === p.pageId ? (
                  <span className="card-meta">Saving…</span>
                ) : p.canPublish ? (
                  <span className="badge badge-ok">Can publish</span>
                ) : (
                  <span className="badge badge-warn">
                    Missing CREATE_CONTENT task
                  </span>
                )}
              </label>
            ))}
          </div>
        ))}

      <p className="warning-text">
        ⚠️ Meta requires app review for production use — in development mode
        only app admins/developers/testers can publish.
      </p>
      <div className="card-meta">
        Publishing to Pages only; personal profiles are not supported by the
        API.
      </div>
      <div>
        <button
          type="button"
          className="btn"
          onClick={() => setConfirmingDisconnect(true)}
        >
          Disconnect
        </button>
      </div>

      <Modal
        open={confirmingDisconnect}
        title="Disconnect Facebook?"
        onClose={() => setConfirmingDisconnect(false)}
      >
        <p>
          This removes the stored Facebook connection (including the encrypted
          Page tokens) for{" "}
          <strong>{account.accountName ?? "your Facebook account"}</strong>. You
          can reconnect anytime.
        </p>
        <p className="card-meta">
          Note: Meta provides no token-revoke API for this login flow, so this
          only deletes Drive2Social's stored copy of your Page tokens. To fully
          revoke access, also remove the app at{" "}
          <a
            href="https://www.facebook.com/settings?tab=applications"
            target="_blank"
            rel="noreferrer"
          >
            facebook.com → Settings → Apps and Business Integrations
          </a>
          .
        </p>
        <div className="connect-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={disconnectBusy}
            onClick={() => void handleDisconnect()}
          >
            {disconnectBusy ? "Disconnecting…" : "Yes, disconnect"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setConfirmingDisconnect(false)}
            disabled={disconnectBusy}
          >
            Cancel
          </button>
        </div>
      </Modal>
    </div>
  );
}
