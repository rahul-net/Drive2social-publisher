import { useEffect, useState } from "react";

/**
 * Tracks the browser's online/offline state via the `online` / `offline`
 * window events. Used to keep the UI honest: the app shell (PWA) works
 * offline thanks to the service worker, but publishing a video always
 * requires an internet connection, so publish buttons stay disabled while
 * offline and an offline banner is shown app-wide.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
