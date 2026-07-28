"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

// Single-active accordion (spec §11): opening one working block closes the others, so
// the cash-operations page never becomes an endless stack of expanded forms. Server-
// rendered forms/tables pass through as `children`.
const Ctx = createContext<{ openId: string | null; setOpenId: (id: string | null) => void }>({ openId: null, setOpenId: () => {} });

export function AccordionGroup({ children, defaultOpenId = null }: { children: ReactNode; defaultOpenId?: string | null }) {
  const [openId, setOpenId] = useState<string | null>(defaultOpenId);
  return <Ctx.Provider value={{ openId, setOpenId }}>{children}</Ctx.Provider>;
}

export function AccordionItem({ id, title, subtitle, summary, children }: { id: string; title: string; subtitle?: string; summary?: ReactNode; children: ReactNode }) {
  const { openId, setOpenId } = useContext(Ctx);
  const open = openId === id;
  return (
    <div className={`mb-3 rounded-lg border bg-white shadow-sm ${open ? "border-brand-200" : "border-slate-200"}`}>
      <button
        type="button"
        onClick={() => setOpenId(open ? null : id)}
        aria-expanded={open}
        className="flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-slate-800">{title}</span>
          {subtitle && open ? <span className="mt-0.5 block break-anywhere text-xs text-slate-500">{subtitle}</span> : null}
          {!open && summary ? <span className="mt-0.5 block break-anywhere text-xs text-slate-400">{summary}</span> : null}
        </span>
        <span className={`shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>⌄</span>
      </button>
      {open ? <div className="border-t border-slate-100 px-4 py-4">{children}</div> : null}
    </div>
  );
}
