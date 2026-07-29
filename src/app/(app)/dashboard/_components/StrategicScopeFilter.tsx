"use client";

import { useRouter } from "next/navigation";
import type { CompanySummary, ClubSummary, StrategicScopeMode } from "@/lib/strategic-scope";

const ALL = "all";

type Props = {
  companies: CompanySummary[];
  clubs: ClubSummary[]; // accessible clubs only (safe to expose)
  mode: StrategicScopeMode;
  companyId: string | null;
  city: string | null;
  clubId: string | null;
  month: string;
  /** Page to navigate to (default the dashboard). Lets every strategic page reuse
   * one filter instead of a copy. */
  basePath?: string;
  /** Page-specific params to preserve across scope changes (period/category/...). */
  extra?: Record<string, string>;
};

// Mobile: full-width, 48px tall, 16px text (no iOS auto-zoom). Desktop: compact inline.
const selectCls =
  "min-h-[48px] w-full rounded-md border border-slate-300 bg-white px-3 text-[16px] text-slate-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 sm:min-h-0 sm:w-auto sm:py-1.5 sm:text-sm";

export function StrategicScopeFilter({ companies, clubs, mode, companyId, city, clubId, month, basePath = "/dashboard", extra }: Props) {
  const router = useRouter();

  const allCities = [...new Set(clubs.map((c) => c.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));

  // Dependent option pools (computed from accessible clubs only).
  const citiesForCompany = companyId
    ? [...new Set(clubs.filter((c) => c.companyId === companyId).map((c) => c.city).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, "ru"),
      )
    : allCities;
  const companiesForCity = city ? companies.filter((co) => clubs.some((c) => c.companyId === co.id && c.city === city)) : companies;
  const clubPool = clubs.filter((c) => (!companyId || c.companyId === companyId) && (!city || c.city === city));

  function navigate(next: { mode?: StrategicScopeMode; companyId?: string; city?: string; clubId?: string }) {
    const nMode = next.mode ?? mode;
    let nCompany = next.companyId ?? companyId ?? ALL;
    let nCity = next.city ?? city ?? ALL;
    let nClub = next.clubId ?? clubId ?? ALL;

    // Re-validate dependents client-side (the server resolver re-validates too).
    if (nCompany !== ALL && !companies.some((c) => c.id === nCompany)) nCompany = ALL;
    if (nCity !== ALL) {
      const cityPool = nCompany !== ALL ? clubs.filter((c) => c.companyId === nCompany) : clubs;
      if (!cityPool.some((c) => c.city === nCity)) nCity = ALL;
    }
    if (nClub !== ALL) {
      const pool = clubs.filter((c) => (nCompany === ALL || c.companyId === nCompany) && (nCity === ALL || c.city === nCity));
      if (!pool.some((c) => c.id === nClub)) nClub = ALL;
    }

    const params = new URLSearchParams();
    params.set("scopeMode", nMode);
    if (nCompany !== ALL) params.set("companyId", nCompany);
    if (nCity !== ALL) params.set("city", nCity);
    if (nClub !== ALL) params.set("clubId", nClub);
    if (month) params.set("month", month);
    for (const [k, v] of Object.entries(extra ?? {})) if (v) params.set(k, v);
    router.push(`${basePath}?${params.toString()}`);
  }

  // Fields: label ABOVE control (spec §2), full-width column on mobile, inline on desktop.
  const Field = (label: string, select: React.ReactNode) => (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</span>
      {select}
    </label>
  );
  const CompanyField = Field(
    "Компания",
    <select className={selectCls} value={companyId ?? ALL} onChange={(e) => navigate({ companyId: e.target.value, clubId: ALL })}>
      <option value={ALL}>Все компании</option>
      {companiesForCity.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
    </select>,
  );
  const CityField = Field(
    "Город",
    <select className={selectCls} value={city ?? ALL} onChange={(e) => navigate({ city: e.target.value, clubId: ALL })}>
      <option value={ALL}>Все города</option>
      {citiesForCompany.map((ct) => (<option key={ct} value={ct}>{ct}</option>))}
    </select>,
  );
  const ClubField = Field(
    "Клуб",
    <select className={selectCls} value={clubId ?? ALL} onChange={(e) => navigate({ clubId: e.target.value })}>
      <option value={ALL}>Все клубы</option>
      {clubPool.map((c) => (<option key={c.id} value={c.id}>{c.name}{c.city ? ` · ${c.city}` : ""}</option>))}
    </select>,
  );

  // Compact scope summary — what's actually selected, so the collapsed filter reads clearly.
  const selectedCompany = companyId ? companies.find((c) => c.id === companyId)?.name : null;
  const selectedClub = clubId ? clubs.find((c) => c.id === clubId)?.name : null;
  const chips = [
    mode === "city" ? "По городу" : "По компании",
    selectedCompany,
    city,
    selectedClub,
  ].filter(Boolean) as string[];

  return (
    <div className="mb-5 space-y-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      {/* Mode switch: full-width segmented on mobile, inline on desktop. */}
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800 sm:inline-flex sm:w-auto">
        <button
          type="button"
          onClick={() => navigate({ mode: "city" })}
          className={`min-h-[40px] rounded-md px-4 text-sm font-medium transition ${mode === "city" ? "bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300" : "text-slate-500 dark:text-slate-400"}`}
        >
          По городу
        </button>
        <button
          type="button"
          onClick={() => navigate({ mode: "company" })}
          className={`min-h-[40px] rounded-md px-4 text-sm font-medium transition ${mode === "company" ? "bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300" : "text-slate-500 dark:text-slate-400"}`}
        >
          По компании
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-end">
        {mode === "city" ? (<>{CityField}{CompanyField}{ClubField}</>) : (<>{CompanyField}{CityField}{ClubField}</>)}
      </div>

      {chips.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c, i) => (
            <span key={i} className="inline-flex items-center rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">{c}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Spec §2 names this OwnerScopeFilter — it is the single shared implementation; the
// alias avoids forking a second copy across owner pages.
export const OwnerScopeFilter = StrategicScopeFilter;
