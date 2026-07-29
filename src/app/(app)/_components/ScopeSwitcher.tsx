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
    // Mobile: full-width vertical stack, label above, ONE neutral surface (no double-dark,
    // §2). Desktop: inline row. 48px controls.
    <div className="flex flex-col gap-3 text-sm lg:flex-row lg:items-end lg:gap-2">
      <label className="block min-w-0 lg:w-56">
        <span className="mb-1 block text-xs font-medium text-[var(--text-muted)] lg:sr-only">Компания</span>
        <span className="flex h-12 w-full items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 lg:h-9">
          <select
            value={companyId}
            onChange={onCompanyChange}
            disabled={isPending}
            className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 font-medium text-[var(--text-primary)] focus:outline-none focus:ring-0 disabled:opacity-60"
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </span>
      </label>

      {clubs.length > 0 ? (
        <label className="block min-w-0 lg:w-48">
          <span className="mb-1 block text-xs font-medium text-[var(--text-muted)] lg:sr-only">Клуб</span>
          <span className="flex h-12 w-full items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 lg:h-9">
            <select
              value={clubId}
              onChange={onClubChange}
              disabled={isPending}
              className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 font-medium text-[var(--text-primary)] focus:outline-none focus:ring-0 disabled:opacity-60"
            >
              <option value="">Все клубы</option>
              {clubs.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </span>
        </label>
      ) : null}
    </div>
  );
}
