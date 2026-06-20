"use client";

import { useFormState, useFormStatus } from "react-dom";
import { closeMonth } from "../../month-close-actions";
import { requestMonthReopen, executeMonthReopen } from "../../month-reopen-actions";

type State = { ok: boolean; error?: string };
const initial: State = { ok: false };

const dtf = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

type LatestRequest = {
  status: "pending" | "approved" | "rejected" | "executed" | "canceled";
  reason: string;
  reviewComment: string | null;
} | null;

function SubmitButton({ idle, busy, tone = "dark" }: { idle: string; busy: string; tone?: "dark" | "light" | "brand" }) {
  const { pending } = useFormStatus();
  const cls =
    tone === "brand"
      ? "bg-brand-600 text-white hover:bg-brand-700"
      : tone === "light"
        ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
        : "bg-slate-800 text-white hover:bg-slate-900";
  return (
    <button type="submit" disabled={pending} className={`rounded-md px-3 py-1.5 text-sm font-medium shadow-sm disabled:opacity-60 ${cls}`}>
      {pending ? busy : idle}
    </button>
  );
}

/**
 * Chief-Accountant month management on the accounting workspace. Server actions
 * enforce the permissions independently; this only renders the right control for
 * the current state. Ordinary Accountants never receive this component.
 */
export function WorkspaceMonthControls({
  month,
  monthLabel,
  status,
  closedByName,
  closedAt,
  latest,
  activeRequestId,
}: {
  month: string;
  monthLabel: string;
  status: "open" | "closed";
  closedByName: string | null;
  closedAt: string | null;
  latest: LatestRequest;
  activeRequestId: string | null;
}) {
  const [closeState, closeAction] = useFormState(closeMonth, initial);
  const [requestState, requestAction] = useFormState(requestMonthReopen, initial);
  const [executeState, executeAction] = useFormState(executeMonthReopen, initial);
  const isClosed = status === "closed";

  return (
    <div className={`mb-6 p-5 ${"rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">Управление месяцем</div>
        <form method="get" className="flex items-center gap-2">
          <input type="month" name="closeMonth" defaultValue={month} className="rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100" />
          <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">Показать</button>
        </form>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="text-base font-semibold text-slate-900 dark:text-slate-100">{monthLabel}</span>
        {isClosed ? (
          <span className="inline-flex rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-200">Закрыт</span>
        ) : (
          <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">Открыт</span>
        )}
        {isClosed && (closedByName || closedAt) ? (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {closedByName ? `Закрыл: ${closedByName}` : ""}
            {closedAt ? ` · ${dtf.format(new Date(closedAt))}` : ""}
          </span>
        ) : null}
      </div>

      <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
        {/* OPEN month -> close */}
        {!isClosed ? (
          <form
            action={closeAction}
            onSubmit={(e) => {
              if (!window.confirm(`Закрыть ${monthLabel}? Финансовые изменения за этот месяц будут заблокированы.`)) e.preventDefault();
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <input type="hidden" name="month" value={month} />
            <input name="comment" placeholder="Комментарий (необязательно)" className="w-56 rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100" />
            <SubmitButton idle="Закрыть месяц" busy="Закрытие..." />
          </form>
        ) : latest?.status === "pending" ? (
          /* CLOSED + pending request */
          <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
            Ожидает согласования собственника
            <div className="mt-0.5 text-xs text-amber-700">Причина: {latest.reason}</div>
          </div>
        ) : latest?.status === "approved" && activeRequestId ? (
          /* CLOSED + approved -> execute */
          <div className="space-y-2">
            <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
              Переоткрытие согласовано
              {latest.reviewComment ? <div className="mt-0.5 text-xs text-emerald-700">Комментарий: {latest.reviewComment}</div> : null}
            </div>
            <form action={executeAction}>
              <input type="hidden" name="requestId" value={activeRequestId} />
              <SubmitButton idle="Переоткрыть месяц" busy="Переоткрытие..." tone="brand" />
            </form>
          </div>
        ) : (
          /* CLOSED + no active request -> request reopen */
          <div className="space-y-2">
            {latest?.status === "rejected" ? (
              <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
                Предыдущий запрос отклонён{latest.reviewComment ? `: ${latest.reviewComment}` : ""}
              </div>
            ) : null}
            <form
              action={requestAction}
              onSubmit={(e) => {
                if (!window.confirm(`Запросить переоткрытие ${monthLabel}? Запрос уйдёт собственнику на согласование.`)) e.preventDefault();
              }}
              className="flex flex-wrap items-end gap-2"
            >
              <input type="hidden" name="month" value={month} />
              <input name="reason" required placeholder="Причина переоткрытия" className="w-72 rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100" />
              <SubmitButton idle="Запросить переоткрытие" busy="Отправка..." tone="light" />
            </form>
          </div>
        )}
      </div>

      {closeState.error ? <p className="mt-2 text-sm text-rose-600">{closeState.error}</p> : null}
      {requestState.ok ? <p className="mt-2 text-sm text-emerald-700">Запрос отправлен собственнику</p> : requestState.error ? <p className="mt-2 text-sm text-rose-600">{requestState.error}</p> : null}
      {executeState.error ? <p className="mt-2 text-sm text-rose-600">{executeState.error}</p> : null}
    </div>
  );
}
