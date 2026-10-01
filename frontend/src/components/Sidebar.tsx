import { NavLink } from "react-router-dom";

const NAV_ITEMS: Array<{ to: string; label: string; icon: string }> = [
  { to: "/", label: "Dashboard", icon: "📊" },
  { to: "/drive", label: "Drive Videos", icon: "🎬" },
  { to: "/create", label: "Create Post", icon: "✍️" },
  { to: "/queue", label: "Upload Queue", icon: "⏳" },
  { to: "/history", label: "History", icon: "🕘" },
  { to: "/accounts", label: "Accounts", icon: "🔗" },
  { to: "/settings", label: "Settings", icon: "⚙️" },
];

export function Sidebar() {
  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="brand">
        <span className="brand-icon">🚀</span>
        <span className="brand-name">Drive2Social</span>
      </div>
      <ul className="nav-list">
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                isActive ? "nav-link active" : "nav-link"
              }
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
