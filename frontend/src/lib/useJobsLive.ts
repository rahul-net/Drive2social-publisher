// ============================================================
// useJobsLive — live job updates for the Upload Queue (Phase 7).
//
// Strategy, in order:
//   1. Firestore `onSnapshot` via the Firebase client SDK, when the
//      Firebase web config is present AND a user is signed in. This
//      is the true live path — no polling.
//   2. Polling GET /api/jobs every 2.5s otherwise.
//
// HONEST FALLBACK NOTE: Phase 9's firestore.rules allow owner
// get/list on `publishJobs`, so path 1 works once the rules are
// deployed (firebase deploy --only firestore:rules). When the client
// SDK is unconfigured, the user is signed out, or the rules aren't
// deployed yet, onSnapshot fails with permission-denied and the hook
// falls back to polling. The `live` flag tells the UI which path is
// active so it never claims "live" when it is polling.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { getApps } from "firebase/app";
import {
  collection,
  getFirestore,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import type { PublishJob } from "@shared";
import { api } from "./api";
import { firebaseConfigured, useAuth } from "../contexts/AuthContext";

const POLL_INTERVAL_MS = 2500;
const POLL_PAGE_SIZE = 100;

export interface JobsLiveResult {
  state: "loading" | "ready" | "failed";
  jobs: PublishJob[];
  message: string;
  /** True only while a Firestore onSnapshot listener is streaming. */
  live: boolean;
  /** Re-fetch immediately (polling path). */
  refresh: () => void;
}

function sortNewestFirst(jobs: PublishJob[]): PublishJob[] {
  return [...jobs].sort((a, b) =>
    a.createdAt > b.createdAt
      ? -1
      : a.createdAt < b.createdAt
        ? 1
        : (a.id ?? "") < (b.id ?? "")
          ? -1
          : 1,
  );
}

export function useJobsLive(): JobsLiveResult {
  const { user } = useAuth();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [jobs, setJobs] = useState<PublishJob[]>([]);
  const [message, setMessage] = useState("");
  const [live, setLive] = useState(false);
  const pollTimer = useRef<number | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const modeRef = useRef<"snapshot" | "poll">("poll");

  const stopAll = useCallback(() => {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const fetchPoll = useCallback(async () => {
    if (modeRef.current !== "poll") return;
    const res = await api.listJobs({ limit: POLL_PAGE_SIZE });
    if (modeRef.current !== "poll") return;
    if (res.ok) {
      setJobs(sortNewestFirst(res.data.jobs));
      setState("ready");
      setMessage("");
    } else {
      setState("failed");
      setMessage(res.error.message);
    }
  }, []);

  const startPolling = useCallback(() => {
    stopAll();
    modeRef.current = "poll";
    setLive(false);
    void fetchPoll();
    pollTimer.current = window.setInterval(() => {
      void fetchPoll();
    }, POLL_INTERVAL_MS);
  }, [fetchPoll, stopAll]);

  const refresh = useCallback(() => {
    if (modeRef.current === "poll") void fetchPoll();
  }, [fetchPoll]);

  useEffect(() => {
    stopAll();
    setState("loading");
    setJobs([]);
    setMessage("");

    // Path 1: Firestore onSnapshot when the client SDK is configured
    // and a user is signed in.
    if (firebaseConfigured && user) {
      try {
        const app = getApps()[0];
        if (!app) throw new Error("Firebase app not initialized");
        const db = getFirestore(app);
        const q = query(
          collection(db, "publishJobs"),
          where("userId", "==", user.uid),
        );
        modeRef.current = "snapshot";
        unsubRef.current = onSnapshot(
          q,
          (snap) => {
            const list = snap.docs.map(
              (d) => ({ ...(d.data() as PublishJob), id: d.id }),
            );
            setJobs(sortNewestFirst(list));
            setState("ready");
            setMessage("");
            setLive(true);
          },
          () => {
            // e.g. permission-denied under the current firestore.rules
            // (Phase 9 owns the real rules). Fall back to polling
            // honestly instead of showing a broken "live" state.
            startPolling();
          },
        );
        return stopAll;
      } catch {
        // Firestore client unavailable — fall through to polling.
      }
    }

    // Path 2: poll the backend every 2.5s.
    startPolling();
    return stopAll;
  }, [user, startPolling, stopAll]);

  return { state, jobs, message, live, refresh };
}
