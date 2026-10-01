import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { Toasts } from "./Toasts";

interface LayoutProps {
  title: string;
  children: ReactNode;
}

export function Layout({ title, children }: LayoutProps) {
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main-column">
        <Topbar title={title} />
        <main className="content">{children}</main>
      </div>
      <Toasts />
    </div>
  );
}
