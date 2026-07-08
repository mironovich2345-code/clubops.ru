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
    <div className="mb-4 flex flex-wrap items-end gap-3" aria-busy={pending}>
      {canNavigateMonths ? (
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Предыдущий месяц" disabled={pending} onClick={() => gotoMonth(-1)} className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">‹</button>
          <span className="min-w-[9.5rem] text-center text-sm font-medium text-slate-800" aria-live="polite">{monthLabel}</span>
          <button type="button" aria-label="Следующий месяц" disabled={pending} onClick={() => gotoMonth(1)} className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">›</button>
        </div>
      ) : null}

      {canFilterByCity ? (
        <label className="block">
          <span id="inv-city-label" className="mb-1 block text-xs font-medium text-slate-600">Город</span>
          <select aria-labelledby="inv-city-label" value={selectedCity ?? ""} disabled={pending} onChange={(e) => apply({ city: e.target.value || null, clubId: null })} className="input">
            <option value="">Все города</option>
            {availableCities.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      ) : null}

      {canFilterByClub ? (
        <label className="block">
          <span id="inv-club-label" className="mb-1 block text-xs font-medium text-slate-600">Клуб</span>
          <select aria-labelledby="inv-club-label" value={selectedClub ?? ""} disabled={pending} onChange={(e) => apply({ clubId: e.target.value || null })} className="input">
            <option value="">Все клубы</option>
            {clubOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      ) : null}

      {pending ? <span className="pb-2 text-xs text-slate-400" role="status">Обновление…</span> : null}
    </div>
  );
}
