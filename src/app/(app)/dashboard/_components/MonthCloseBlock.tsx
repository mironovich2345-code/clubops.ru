"use client";

import { useFormState, useFormStatus } from "react-dom";
import { closeMonth, reopenMonth } from "../../month-close-actions";

type State = { ok: boolean; error?: string };
const initial: State = { ok: false };

const dtf = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

function CloseButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-slate-900 disabled:opacity-60">
      {pending ? "Закрытие..." : "Закрыть месяц"}
    </button>
  );
}
function ReopenButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60">
      {pending ? "Открытие..." : "Открыть месяц"}
    </button>
  );
}

/** Dashboard "Статус месяца" block: shows open/closed and (for allowed roles)
 * close / reopen controls for the selected month. */
export function MonthCloseBlock({
  month,
  monthLabel,
  status,
  closedByName,
  closedAt,
  canClose,
  canReopen,
}: {
  month: string;
  monthLabel: string;
  status: "open" | "closed";
  closedByName: string | null;
  closedAt: string | null;
  canClose: boolean;
  canReopen: boolean;
}) {
  const [closeState, closeAction] = useFormState(closeMonth, initial);
  const [reopenState, reopenAction] = useFormState(reopenMonth, initial);
  const isClosed = status === "closed";

  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-semibold text-slate-700">Статус месяца</div>
        <form method="get" action="/dashboard" className="flex items-center gap-2">
          <input type="month" name="closeMonth" defaultValue={month} className="rounded-md border border-slate-300 px-2 py-1 text-sm" />
          <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50">Показать</button>
        </form>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="text-base font-semibold text-slate-900">{monthLabel}</span>
        {isClosed ? (
          <span className="inline-flex rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-200">Закрыт</span>
        ) : (
          <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">Открыт</span>
        )}
        {isClosed && (closedByName || closedAt) ? (
          <span className="text-xs text-slate-500">
            {closedByName ? `Закрыл: ${closedByName}` : ""}
            {closedAt ? ` · ${dtf.format(new Date(closedAt))}` : ""}
          </span>
        ) : null}
      </div>

      {(canClose && !isClosed) || (canReopen && isClosed) ? (
        <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
          {!isClosed && canClose ? (
            <form action={closeAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="month" value={month} />
              <input name="comment" placeholder="Комментарий (необязательно)" className="w-56 rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
              <CloseButton />
            </form>
          ) : null}
          {isClosed && canReopen ? (
            <form action={reopenAction}>
              <input type="hidden" name="month" value={month} />
              <ReopenButton />
            </form>
          ) : null}
        </div>
      ) : null}

      {closeState.error ? <p className="mt-2 text-sm text-rose-600">{closeState.error}</p> : null}
      {reopenState.error ? <p className="mt-2 text-sm text-rose-600">{reopenState.error}</p> : null}
    </div>
  );
}
