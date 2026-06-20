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

const selectCls =
  "rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200";

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

  const CompanyField = (
    <label className="flex items-center gap-1.5">
      <span className="text-xs text-slate-500 dark:text-slate-400">Компания</span>
      <select className={selectCls} value={companyId ?? ALL} onChange={(e) => navigate({ companyId: e.target.value, clubId: ALL })}>
        <option value={ALL}>Все компании</option>
        {companiesForCity.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
    </label>
  );
  const CityField = (
    <label className="flex items-center gap-1.5">
      <span className="text-xs text-slate-500 dark:text-slate-400">Город</span>
      <select className={selectCls} value={city ?? ALL} onChange={(e) => navigate({ city: e.target.value, clubId: ALL })}>
        <option value={ALL}>Все города</option>
        {citiesForCompany.map((ct) => (
          <option key={ct} value={ct}>{ct}</option>
        ))}
      </select>
    </label>
  );
  const ClubField = (
    <label className="flex items-center gap-1.5">
      <span className="text-xs text-slate-500 dark:text-slate-400">Клуб</span>
      <select className={selectCls} value={clubId ?? ALL} onChange={(e) => navigate({ clubId: e.target.value })}>
        <option value={ALL}>Все клубы</option>
        {clubPool.map((c) => (
          <option key={c.id} value={c.id}>{c.name}{c.city ? ` · ${c.city}` : ""}</option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="inline-flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-700">
        <button
          type="button"
          onClick={() => navigate({ mode: "city" })}
          className={`px-3 py-1.5 text-sm font-medium ${mode === "city" ? "bg-brand-600 text-white" : "bg-white text-slate-700 dark:bg-slate-900 dark:text-slate-200"}`}
        >
          По городу
        </button>
        <button
          type="button"
          onClick={() => navigate({ mode: "company" })}
          className={`px-3 py-1.5 text-sm font-medium ${mode === "company" ? "bg-brand-600 text-white" : "bg-white text-slate-700 dark:bg-slate-900 dark:text-slate-200"}`}
        >
          По компании
        </button>
      </div>
      {mode === "city" ? (
        <>
          {CityField}
          {CompanyField}
          {ClubField}
        </>
      ) : (
        <>
          {CompanyField}
          {CityField}
          {ClubField}
        </>
      )}
    </div>
  );
}
