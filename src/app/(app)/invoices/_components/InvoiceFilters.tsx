"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

type Club = { id: string; name: string; city: string };

/**
 * Period + city/club controls for elevated roles. Every change goes through the
 * URL search params (so reload preserves the period) and the server loader —
 * never client state. Managers never receive this component.
 */
export function InvoiceFilters({
  year, month, monthLabel,
  canNavigateMonths, canFilterByCity, canFilterByClub,
  availableCities, availableClubs, selectedCity, selectedClub,
}: {
  year: number;
  month: number;
  monthLabel: string;
  canNavigateMonths: boolean;
  canFilterByCity: boolean;
  canFilterByClub: boolean;
  availableCities: string[];
  availableClubs: Club[];
  selectedCity: string | null;
  selectedClub: string | null;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();

  function apply(changes: Record<string, string | number | null>) {
    const params = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") params.delete(k);
      else params.set(k, String(v));
    }
    startTransition(() => router.push(`/invoices?${params.toString()}`));
  }

  function gotoMonth(delta: number) {
    const d = new Date(year, month - 1 + delta, 1);
    apply({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  // Changing the city drops an now-incompatible club (server also resets it).
  const clubOptions = selectedCity ? availableClubs.filter((c) => c.city === selectedCity) : availableClubs;

  return (
    // Mobile: month nav row, then city/club as two equal columns. Desktop: inline row.
    <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end" aria-busy={pending}>
      {canNavigateMonths ? (
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Предыдущий месяц" disabled={pending} onClick={() => gotoMonth(-1)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">‹</button>
          <span className="min-w-0 flex-1 text-center text-sm font-medium text-slate-800 dark:text-slate-200 lg:min-w-[9.5rem] lg:flex-none" aria-live="polite">{monthLabel}</span>
          <button type="button" aria-label="Следующий месяц" disabled={pending} onClick={() => gotoMonth(1)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">›</button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:contents">
        {canFilterByCity ? (
          <label className="block min-w-0">
            <span id="inv-city-label" className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Город</span>
            <select aria-labelledby="inv-city-label" value={selectedCity ?? ""} disabled={pending} onChange={(e) => apply({ city: e.target.value || null, clubId: null })} className="input w-full">
              <option value="">Все города</option>
              {availableCities.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        ) : null}

        {canFilterByClub ? (
          <label className="block min-w-0">
            <span id="inv-club-label" className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Клуб</span>
            <select aria-labelledby="inv-club-label" value={selectedClub ?? ""} disabled={pending} onChange={(e) => apply({ clubId: e.target.value || null })} className="input w-full">
              <option value="">Все клубы</option>
              {clubOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        ) : null}
      </div>

      {pending ? <span className="text-xs text-slate-400" role="status">Обновление…</span> : null}
    </div>
  );
}
