import { useEffect, useState } from "react";
import type { ApiResponse } from "@shared";

export type LoadState<T> =
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "failed"; message: string };

/**
 * Fetch-once hook around the typed API client. Honest states only:
 * loading → ready (even if empty) → failed. Never fabricates data.
 */
export function useApiData<T>(fetcher: () => Promise<ApiResponse<T>>): LoadState<T> {
  const [result, setResult] = useState<LoadState<T>>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetcher()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setResult({ state: "ready", data: res.data });
        } else {
          setResult({ state: "failed", message: res.error.message });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResult({
          state: "failed",
          message: err instanceof Error ? err.message : "Request failed",
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return result;
}
