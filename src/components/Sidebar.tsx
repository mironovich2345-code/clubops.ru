"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { NavItem } from "@/lib/navigation";
import { NAV_SECTIONS } from "@/lib/navigation";

type SidebarProps = {
  items: ReadonlyArray<NavItem>;
};

const STORAGE_PREFIX = "clubops:nav:";

const itemClass = (active: boolean) =>
  [
    "block rounded-md px-3 py-2 text-sm font-medium transition-colors",
    active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
  ].join(" ");

export function Sidebar({ items }: SidebarProps) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  // Resolve each section against the access-filtered items the layout passes in.
  // A page/group the user cannot access is simply absent here — no access logic
  // lives in the sidebar.
  const byPage = new Map(items.map((i) => [i.page, i] as const));
  const groups = NAV_SECTIONS.flatMap((s) =>
    s.type === "group"
      ? (() => {
          const children = s.pages.map((p) => byPage.get(p)).filter((x): x is NavItem => Boolean(x));
          return children.length ? [{ id: s.id, children }] : [];
        })()
      : [],
  );
  const activeGroupId = (id: string) => groups.find((g) => g.id === id)?.children.some((c) => isActive(c.href)) ?? false;

  // Expansion state. Initial (SSR + first client render) is deterministic — only
  // the group containing the active page is open — so hydration matches. The
  // saved localStorage state is merged in after mount.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const g of groups) if (g.children.some((c) => isActive(c.href))) init[g.id] = true;
    return init;
  });

  useEffect(() => {
    setExpanded((prev) => {
      const next = { ...prev };
      for (const s of NAV_SECTIONS) {
        if (s.type !== "group") continue;
        const saved = typeof window !== "undefined" ? window.localStorage.getItem(`${STORAGE_PREFIX}${s.id}`) : null;
        if (saved !== null) next[s.id] = saved === "1";
        // Opening a page inside a group always expands that group.
        if (activeGroupId(s.id)) next[s.id] = true;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const value = !prev[id];
      if (typeof window !== "undefined") window.localStorage.setItem(`${STORAGE_PREFIX}${id}`, value ? "1" : "0");
      return { ...prev, [id]: value };
    });
  };

  return (
    <aside className="flex h-screen w-64 flex-col border-r border-slate-200 bg-white">
      <div className="px-6 py-5 border-b border-slate-200">
        <div className="text-lg font-semibold tracking-tight text-slate-900">Club Ops</div>
        <div className="text-xs text-slate-500 mt-0.5">Управление клубами</div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="space-y-1">
          {NAV_SECTIONS.map((section) => {
            if (section.type === "item") {
              const item = byPage.get(section.page);
              if (!item) return null;
              return (
                <li key={item.href}>
                  <Link href={item.href} className={itemClass(isActive(item.href))}>
                    {item.label}
                  </Link>
                </li>
              );
            }

            const children = section.pages.map((p) => byPage.get(p)).filter((x): x is NavItem => Boolean(x));
            if (children.length === 0) return null;
            const groupActive = children.some((c) => isActive(c.href));
            const isOpen = expanded[section.id] ?? false;

            return (
              <li key={section.id}>
                <button
                  type="button"
                  onClick={() => toggle(section.id)}
                  aria-expanded={isOpen}
                  className={[
                    "flex w-full items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    groupActive ? "text-slate-900" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                  ].join(" ")}
                >
                  <span>{section.label}</span>
                  <svg
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden="true"
                    className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
                  >
                    <path d="M6 8l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {isOpen ? (
                  <ul className="mt-1 space-y-1 border-l border-slate-200 pl-3">
                    {children.map((item) => (
                      <li key={item.href}>
                        <Link href={item.href} className={itemClass(isActive(item.href))}>
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
