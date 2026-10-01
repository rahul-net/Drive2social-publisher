// ============================================================
// Firebase Authentication — Phase 2.
// ID tokens live in memory only (never localStorage).
// When VITE_FIREBASE_* env vars are missing/placeholder, `configured`
// is false and every sign-in surface shows an honest message instead
// of crashing (see /signin page and docs/SETUP.md, Phase 10).
// ============================================================

import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
  type User,
} from "firebase/auth";
import { useToast } from "./ToastContext";
import { setIdTokenGetter } from "../lib/api";

interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

/** A value is usable only if it is non-empty and not an env placeholder. */
function isUsable(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.toLowerCase().includes("placeholder") &&
    !value.includes("YOUR_") &&
    !value.startsWith("your-")
  );
}

function readFirebaseConfig(): FirebaseWebConfig | null {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY as string | undefined;
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined;
  const appId = import.meta.env.VITE_FIREBASE_APP_ID as string | undefined;
  if (!isUsable(apiKey) || !isUsable(authDomain) || !isUsable(projectId) || !isUsable(appId)) {
    return null;
  }
  return { apiKey, authDomain, projectId, appId };
}

/** Whether real Firebase web config is present (no real project yet → false). */
export const firebaseConfigured: boolean = readFirebaseConfig() !== null;

function isFirebaseAuthError(err: unknown): err is { code: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  );
}

/** User-friendly message for the most common sign-in failures. */
export function friendlySignInError(err: unknown): string {
  if (isFirebaseAuthError(err)) {
    switch (err.code) {
      case "auth/popup-blocked":
        return "The sign-in popup was blocked. Please allow popups for this site and try again.";
      case "auth/popup-closed-by-user":
      case "auth/cancelled-popup-request":
        return "Sign-in was cancelled. Please try again.";
      case "auth/network-request-failed":
        return "Network error during sign-in. Check your connection and try again.";
      case "auth/unauthorized-domain":
        return "This domain is not authorized for sign-in. Ask the app owner to add it in the Firebase console.";
      default:
        break;
    }
  }
  return err instanceof Error ? err.message : "Sign-in failed. Please try again.";
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  configured: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  getIdToken: (forceRefresh?: boolean) => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { notify } = useToast();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const authRef = useRef<Auth | null>(null);
  const userRef = useRef<User | null>(null);
  userRef.current = user;

  // Initialize Firebase once (only when config is real).
  useEffect(() => {
    if (!firebaseConfigured) {
      setLoading(false);
      return;
    }
    const fbConfig = readFirebaseConfig();
    if (!fbConfig) {
      setLoading(false);
      return;
    }
    let app: FirebaseApp | null = null;
    let auth: Auth | null = null;
    try {
      app = initializeApp(fbConfig);
      auth = getAuth(app);
      authRef.current = auth;
    } catch {
      // init failure: stay signed out, surfaces show the honest message
      setLoading(false);
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setLoading(false);
    });
    return () => {
      unsubscribe();
      authRef.current = null;
    };
  }, []);

  const getIdToken = useCallback(
    async (forceRefresh = false): Promise<string | null> => {
      const current = userRef.current;
      if (!current) return null;
      try {
        return await current.getIdToken(forceRefresh);
      } catch {
        return null;
      }
    },
    [],
  );

  // Hand the API client a module-level getter so every request carries
  // Authorization: Bearer <Firebase ID token> when signed in.
  useEffect(() => {
    setIdTokenGetter((forceRefresh?: boolean) =>
      userRef.current
        ? userRef.current.getIdToken(forceRefresh ?? false).catch(() => null)
        : Promise.resolve(null),
    );
    return () => setIdTokenGetter(() => Promise.resolve(null));
  }, []);

  const signInWithGoogle = useCallback(async (): Promise<void> => {
    const auth = authRef.current;
    if (!auth) {
      notify(
        "error",
        "Firebase is not configured — see docs/SETUP.md. Sign-in is unavailable until then.",
      );
      return;
    }
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      notify("success", "Signed in.");
    } catch (err) {
      // Never log tokens; only surface the friendly message.
      notify("error", friendlySignInError(err));
    }
  }, [notify]);

  const signOut = useCallback(async (): Promise<void> => {
    const auth = authRef.current;
    if (!auth) return;
    try {
      await firebaseSignOut(auth);
      notify("info", "Signed out.");
    } catch {
      notify("error", "Sign-out failed. Please try again.");
    }
  }, [notify]);

  const value = useMemo(
    () => ({
      user,
      loading,
      configured: firebaseConfigured,
      signInWithGoogle,
      signOut,
      getIdToken,
    }),
    [user, loading, signInWithGoogle, signOut, getIdToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
