"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Sheet } from "./Sheet";
import { FilterIcon, CloseIcon } from "./icons";

export type FilterChip = { label: string; removeHref?: string };

/**
 * Mobile filter affordance (spec §4/§8/§11). Desktop keeps its inline filter row; this is
 * `lg:hidden`. Shows a "Фильтры" trigger + active-filter chips, and opens a bottom sheet holding
 * the page's own filter <form> (id = `formId`). The footer "Применить" submits that form (a GET
 * to the same route), so filtering stays server-driven with no new data path.
 */
export function FilterSheet({ formId, chips = [], children }: { formId: string; chips?: FilterChip[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const active = chips.length;
  return (
    <div className="lg:hidden">
      <div className="flex items-center gap-2 overflow-x-auto py-1">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700"
        >
          <FilterIcon className="h-4 w-4" /> Фильтры{active ? ` (${active})` : ""}
        </button>
        {chips.map((c, i) => (
          <span key={i} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700">
            {c.label}
            {c.removeHref ? (
              <Link href={c.removeHref} aria-label={`Убрать фильтр ${c.label}`} className="text-brand-500 hover:text-brand-700"><CloseIcon className="h-3.5 w-3.5" /></Link>
            ) : null}
          </span>
        ))}
      </div>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Фильтры"
        footer={
          <button type="submit" form={formId} className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700">
            Применить
          </button>
        }
      >
        {children}
      </Sheet>
    </div>
  );
}
