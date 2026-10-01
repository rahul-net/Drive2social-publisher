import { Link, useNavigate } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { useAuth } from "../contexts/AuthContext";

interface TopbarProps {
  title: string;
}

export function Topbar({ title }: TopbarProps) {
  const { theme, toggleTheme } = useTheme();
  const { user, loading, configured, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = () => {
    void signOut().then(() => navigate("/signin", { replace: true }));
  };

  return (
    <header className="topbar">
      <h1 className="topbar-title">{title}</h1>
      <div className="topbar-actions">
        {loading ? (
          <span className="user-chip" aria-busy="true">
            Signing in…
          </span>
        ) : user ? (
          <>
            {user.photoURL ? (
              <img
                className="user-avatar"
                src={user.photoURL}
                alt=""
                title={user.email ?? "Signed in"}
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="user-avatar user-avatar-initials" title={user.email ?? "Signed in"} aria-hidden="true">
                {(user.displayName ?? user.email ?? "?").trim().charAt(0).toUpperCase()}
              </span>
            )}
            <span className="user-chip" title={user.email ?? undefined}>
              {user.displayName ?? user.email ?? "Signed in"}
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleSignOut}
            >
              Sign out
            </button>
          </>
        ) : (
          <Link
            className="btn btn-primary"
            to="/signin"
            title={
              configured
                ? "Sign in with Google"
                : "Sign-in unavailable: Firebase is not configured — see docs/SETUP.md"
            }
          >
            Sign in with Google
          </Link>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={toggleTheme}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
      </div>
    </header>
  );
}
