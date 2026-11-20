import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";

import { useWorkers } from "../api/hooks";

const THEME_KEY = "strand.theme";
type Theme = "light" | "dark";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/runs", label: "Runs", end: false },
  { to: "/schedules", label: "Schedules", end: false },
  { to: "/workers", label: "Workers", end: false },
];

const systemTheme = (): Theme =>
  window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function useTheme(): [Theme, () => void] {
  const [chosen, setChosen] = useState<Theme | null>(storedTheme);
  const [system, setSystem] = useState<Theme>(systemTheme);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(query.matches ? "dark" : "light");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (chosen) document.documentElement.dataset["theme"] = chosen;
    else delete document.documentElement.dataset["theme"];
  }, [chosen]);

  const current = chosen ?? system;
  const toggle = useCallback(() => {
    const next: Theme = current === "dark" ? "light" : "dark";
    setChosen(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // The choice still applies for this session.
    }
  }, [current]);
  return [current, toggle];
}

function Thread() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M3 22c5.5 0 6.5-12 13-12s7.5 12 13 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
      />
      <circle cx="16" cy="10" r="3" fill="var(--saffron)" />
    </svg>
  );
}

export function Shell() {
  const [theme, toggleTheme] = useTheme();
  const workers = useWorkers();
  const alive = workers.data?.filter((w) => w.alive).length;

  return (
    <>
      <header className="topbar">
        <Link to="/" className="wordmark" aria-label="Strand home">
          <Thread />
          Strand
        </Link>
        <nav className="nav" aria-label="Main">
          {NAV.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `nav__link${isActive ? " nav__link--active" : ""}`}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar__end">
          {alive !== undefined ? (
            <Link
              to="/workers"
              className={`knot ${alive > 0 ? "knot--alive" : "knot--down"}`}
              style={{ textDecoration: "none" }}
            >
              {alive === 0 ? "No workers" : `${alive} ${alive === 1 ? "worker" : "workers"}`}
            </Link>
          ) : null}
          <button type="button" className="button button--quiet" onClick={toggleTheme}>
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </button>
          <Link to="/settings" className="nav__link" style={{ height: "auto" }}>
            Settings
          </Link>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}
