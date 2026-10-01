import { useOnlineStatus } from "../lib/useOnlineStatus";

/**
 * App-wide offline banner (rendered above the route content in App.tsx).
 * The service worker keeps the app shell usable offline, but every publish
 * action needs a live connection — this banner makes that explicit so the
 * app never implies publishing will work without one.
 */
export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div
      role="alert"
      className="offline-banner"
      style={{
        background: "#b45309",
        color: "#fff",
        padding: "8px 16px",
        textAlign: "center",
        fontSize: "14px",
        fontWeight: 600,
      }}
    >
      ⚠ You&rsquo;re offline — browsing the app works, but publishing
      requires an internet connection.
    </div>
  );
}
