import { useCallback, useState } from "react";
import { api } from "./api";
import { useToast } from "../contexts/ToastContext";

/**
 * Starts the Google OAuth connect flow: fetches the consent URL from the
 * backend (which binds the Firebase uid to the OAuth `state` server-side)
 * and navigates the whole page to Google. Used by Accounts and Drive pages.
 * `purpose` selects the scopes: "drive" (default) or "youtube"
 * (incremental — the Drive grant is kept).
 */
export function useGoogleConnect() {
  const { notify } = useToast();
  const [connecting, setConnecting] = useState(false);

  const connect = useCallback(
    async (purpose: "drive" | "youtube" = "drive") => {
      setConnecting(true);
      try {
        const res = await api.googleStartUrl(purpose);
        if (res.ok) {
          window.location.href = res.data.url;
        } else {
          notify(
            "error",
            `Could not start Google connect: ${res.error.message}`,
          );
          setConnecting(false);
        }
      } catch (err) {
        notify(
          "error",
          `Could not start Google connect: ${
            err instanceof Error ? err.message : "network error"
          }`,
        );
        setConnecting(false);
      }
    },
    [notify],
  );

  return { connecting, connect };
}
