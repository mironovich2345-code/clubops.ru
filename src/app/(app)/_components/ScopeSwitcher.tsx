"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setActiveScope } from "../scope-actions";

type Option = { id: string; name: string };

/**
 * Topbar scope selector: pick the active company and (optionally) a single club.
 *
 * State is controlled locally (optimistic) so the selects never bounce back to
 * the previous value while the server action persists the cookie. After the
 * action resolves we router.refresh() to re-render every scoped server
 * component; useEffect then reconciles local state with the new server truth.
 *
 * Changing the company resets the club to "Все клубы" (company-level scope) —
 * a club from another company must never stay selected. No global role logic:
 * options are pre-scoped by the caller via getCurrentAccessContext.
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
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [companyId, setCompanyId] = useState(selectedCompanyId);
  const [clubId, setClubId] = useState(selectedClubId ?? "");

  // Reconcile with server-provided scope after a refresh (or external change).
  useEffect(() => setCompanyId(selectedCompanyId), [selectedCompanyId]);
  useEffect(() => setClubId(selectedClubId ?? ""), [selectedClubId]);

  function commit(nextCompanyId: string, nextClubId: string) {
    startTransition(async () => {
      await setActiveScope(nextCompanyId, nextClubId);
      router.refresh();
    });
  }

  function onCompanyChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    setCompanyId(next);
    setClubId(""); // switching company resets to all clubs
    commit(next, "");
  }

  function onClubChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    setClubId(next);
    commit(companyId, next);
  }

  return (
    // Mobile: full-width vertical stack (never two wide selects in a row, §5).
    // Desktop: inline pills as before.
    <div className="flex flex-col gap-2 text-sm lg:flex-row lg:items-center">
      <label className="flex min-h-[44px] w-full min-w-0 items-center gap-1.5 rounded-md bg-slate-100 px-2.5 lg:min-h-0 lg:w-auto lg:py-1">
        <span className="shrink-0 text-xs text-slate-400">Компания</span>
        <select
          value={companyId}
          onChange={onCompanyChange}
          disabled={isPending}
          className="min-w-0 flex-1 truncate bg-transparent font-medium text-slate-700 focus:outline-none disabled:opacity-60 lg:flex-none"
        >
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {clubs.length > 0 ? (
        <label className="flex min-h-[44px] w-full min-w-0 items-center gap-1.5 rounded-md bg-slate-100 px-2.5 lg:min-h-0 lg:w-auto lg:py-1">
          <span className="shrink-0 text-xs text-slate-400">Клуб</span>
          <select
            value={clubId}
            onChange={onClubChange}
            disabled={isPending}
            className="min-w-0 flex-1 truncate bg-transparent font-medium text-slate-700 focus:outline-none disabled:opacity-60 lg:flex-none"
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
    </div>
  );
}
