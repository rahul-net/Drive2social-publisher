import type { ReactElement } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

interface RequireAuthProps {
  children: ReactElement;
}

/**
 * Route guard: while auth initializes show a spinner; afterwards,
 * unauthenticated users go to /signin. Works even when Firebase is
 * not configured (the /signin page explains the situation honestly).
 */
export function RequireAuth({ children }: RequireAuthProps) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="state-block auth-loading" aria-busy="true">
        <div className="spinner" role="status" aria-label="Loading" />
        <p className="state-hint">Checking sign-in…</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/signin" state={{ from: location }} replace />;
  }

  return children;
}
