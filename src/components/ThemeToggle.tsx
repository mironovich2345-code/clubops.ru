"use client";

import { useEffect, useRef, useState } from "react";

type Theme = "light" | "dark" | "system";
const OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Светлая" },
  { value: "dark", label: "Тёмная" },
  { value: "system", label: "Системная" },
];

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Apply a theme to <html> (class + data-theme + color-scheme). Kept in sync with the
 * pre-hydration inline script in the root layout. Never touches auth/session. */
function applyTheme(theme: Theme): void {
  const isDark = theme === "dark" || (theme === "system" && systemPrefersDark());
  const el = document.documentElement;
  el.classList.toggle("dark", isDark);
  el.setAttribute("data-theme", isDark ? "dark" : "light");
  el.style.colorScheme = isDark ? "dark" : "light";
}

function Icon({ theme }: { theme: Theme }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (theme === "light") {
    return (
      <svg {...common}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>
    );
  }
  if (theme === "dark") {
    return <svg {...common}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>;
  }
  return <svg {...common}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Read the stored choice on mount (SSR renders the default; no hydration mismatch
  // because the button label/icon only depends on client state after mount).
  useEffect(() => {
    const stored = (typeof localStorage !== "undefined" && localStorage.getItem("theme")) as Theme | null;
    if (stored === "light" || stored === "dark" || stored === "system") setTheme(stored);
  }, []);

  // Follow the OS when in "system" mode (live), and close the menu on outside click.
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystem = () => { if (theme === "system") applyTheme("system"); };
    mql.addEventListener("change", onSystem);
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => { mql.removeEventListener("change", onSystem); document.removeEventListener("mousedown", onDown); };
  }, [theme]);

  const choose = (next: Theme) => {
    setTheme(next);
    setOpen(false);
    try { localStorage.setItem("theme", next); } catch { /* storage disabled — session-only */ }
    applyTheme(next);
  };

  const current = OPTIONS.find((o) => o.value === theme) ?? OPTIONS[2];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Тема: ${current.label}`}
        title={`Тема: ${current.label}`}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        <Icon theme={theme} />
        <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden className="text-slate-400"><path d="M6 8l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={theme === o.value}
              onClick={() => choose(o.value)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${theme === o.value ? "bg-brand-50 text-brand-700" : "text-slate-700 hover:bg-slate-50"}`}
            >
              <Icon theme={o.value} />
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
