import { useCallback, useState } from "react";
import { api } from "./api";
import { useToast } from "../contexts/ToastContext";

/**
 * Starts the Meta (Facebook) OAuth connect flow: fetches the consent
 * URL from the backend (which binds the Firebase uid to the OAuth
 * `state` server-side) and navigates the whole page to Facebook.
 * Mirrors useGoogleConnect. Used by the Accounts page.
 */
export function useMetaConnect() {
  const { notify } = useToast();
  const [connecting, setConnecting] = useState(false);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const res = await api.metaStartUrl();
      if (res.ok) {
        window.location.href = res.data.url;
      } else {
        notify(
          "error",
          `Could not start Facebook connect: ${res.error.message}`,
        );
        setConnecting(false);
      }
    } catch (err) {
      notify(
        "error",
        `Could not start Facebook connect: ${
          err instanceof Error ? err.message : "network error"
        }`,
      );
      setConnecting(false);
    }
  }, [notify]);

  return { connecting, connect };
}
