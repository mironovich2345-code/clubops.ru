"use client";

import { setActiveScope } from "../scope-actions";

type Option = { id: string; name: string };

/**
 * Topbar scope selector: pick the active company and (optionally) a single club.
 * Changing either select submits the form, which sets the scope cookie and
 * revalidates the layout so all data re-scopes. "Все клубы" clears the club to
 * give a company-level view. No global role logic — options are pre-scoped by
 * the caller via getCurrentAccessContext.
 */
export function ScopeSwitcher({
  companies,
  clubs,
  selectedCompanyId,
  selectedClubId,
}: {
  companies: Option[];
  clubs: Option[];
  selectedCompanyId: string;
  selectedClubId: string | null;
}) {
  return (
    <form
      action={setActiveScope}
      className="flex items-center gap-2 text-sm"
      onChange={(e) => e.currentTarget.requestSubmit()}
    >
      <label className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2.5 py-1">
        <span className="text-xs text-slate-400">Компания</span>
        <select
          name="companyId"
          defaultValue={selectedCompanyId}
          className="bg-transparent font-medium text-slate-700 focus:outline-none"
        >
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {clubs.length > 0 ? (
        <label className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2.5 py-1">
          <span className="text-xs text-slate-400">Клуб</span>
          {/* Remount on company change so the default resets to "Все клубы". */}
          <select
            key={selectedCompanyId}
            name="clubId"
            defaultValue={selectedClubId ?? ""}
            className="bg-transparent font-medium text-slate-700 focus:outline-none"
          >
            <option value="">Все клубы</option>
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </form>
  );
}
