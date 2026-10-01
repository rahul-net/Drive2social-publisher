import { useEffect } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

/**
 * /signin — the only public route. Signed-in users are redirected to
 * where they came from. When Firebase isn't configured, shows an
 * honest message instead of a broken sign-in button.
 */
export function SignInPage() {
  const { user, loading, configured, signInWithGoogle } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } } | null)?.from
    ?.pathname;

  useEffect(() => {
    if (!loading && user) {
      navigate(from ?? "/", { replace: true });
    }
  }, [loading, user, navigate, from]);

  if (loading) {
    return (
      <div className="signin-page">
        <div className="signin-card">
          <div className="spinner" role="status" aria-label="Loading" />
          <p className="state-hint">Checking sign-in…</p>
        </div>
      </div>
    );
  }

  if (user) {
    // Redirect handled above; render nothing while navigating.
    return <Navigate to={from ?? "/"} replace />;
  }

  return (
    <div className="signin-page">
      <div className="signin-card">
        <div className="signin-brand">
          <span className="signin-logo" aria-hidden="true">
            🎬
          </span>
          <h1 className="signin-title">Drive2Social Publisher</h1>
          <p className="signin-subtitle">
            Sign in to publish Drive videos to YouTube and Facebook.
          </p>
        </div>

        {configured ? (
          <>
            <button
              type="button"
              className="btn btn-primary signin-button"
              onClick={() => void signInWithGoogle()}
            >
              <span aria-hidden="true">G</span> Sign in with Google
            </button>
            <p className="signin-hint">
              We use your Google account only to verify who you are.
            </p>
          </>
        ) : (
          <div className="signin-notice" role="alert">
            <p className="state-title">Sign-in is not available yet</p>
            <p className="state-hint">
              Firebase is not configured — see <code>docs/SETUP.md</code> for
              the setup steps (Phase 10). No Firebase project exists yet, so
              this page is intentionally disabled rather than broken.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
