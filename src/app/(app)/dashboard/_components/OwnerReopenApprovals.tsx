"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { approveMonthReopen, rejectMonthReopen } from "../../month-reopen-actions";

type State = { ok: boolean; error?: string };
const initial: State = { ok: false };

const dtf = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export type ReopenRow = {
  id: string;
  month: string;
  monthLabel: string;
  reason: string;
  requestedByName: string | null;
  requestedAt: string;
  clubName: string | null;
  companyName: string;
};

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

function ActionButton({ idle, busy, tone }: { idle: string; busy: string; tone: "approve" | "reject" }) {
  const { pending } = useFormStatus();
  const cls = tone === "approve" ? "border-emerald-300 bg-emerald-600 text-white hover:bg-emerald-700" : "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100";
  return (
    <button type="submit" disabled={pending} className={`rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${cls}`}>
      {pending ? busy : idle}
    </button>
  );
}

function RequestRow({ row }: { row: ReopenRow }) {
  const [approveState, approveAction] = useFormState(approveMonthReopen, initial);
  const [rejectState, rejectAction] = useFormState(rejectMonthReopen, initial);
  const [comment, setComment] = useState("");

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {row.monthLabel}
            <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
              {row.companyName}{row.clubName ? ` · ${row.clubName}` : " · вся сеть"}
            </span>
          </div>
          <div className="mt-0.5 text-sm text-slate-700 dark:text-slate-300">Причина: {row.reason}</div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {row.requestedByName ?? "—"} · {dtf.format(new Date(row.requestedAt))}
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <form action={approveAction}>
          <input type="hidden" name="requestId" value={row.id} />
          <ActionButton idle="Согласовать" busy="..." tone="approve" />
        </form>
        <form
          action={rejectAction}
          onSubmit={(e) => {
            if (!comment.trim()) {
              e.preventDefault();
              window.alert("Укажите причину отклонения");
            }
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <input type="hidden" name="requestId" value={row.id} />
          <input
            name="comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Причина отклонения"
            className="w-56 rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <ActionButton idle="Отклонить" busy="..." tone="reject" />
        </form>
      </div>

      {approveState.error ? <p className="mt-1 text-sm text-rose-600">{approveState.error}</p> : null}
      {rejectState.error ? <p className="mt-1 text-sm text-rose-600">{rejectState.error}</p> : null}
    </div>
  );
}

/** Owner-only block: pending month-reopening requests with approve/reject.
 * Approval does NOT reopen the month — the Chief Accountant executes afterwards. */
export function OwnerReopenApprovals({ requests }: { requests: ReopenRow[] }) {
  return (
    <div className={`mb-6 overflow-hidden ${CARD}`}>
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Запросы на переоткрытие месяца</span>
        <span className="text-xs text-slate-400">{requests.length}</span>
      </div>
      {requests.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">Нет запросов на согласование</div>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
          {requests.map((r) => (
            <RequestRow key={r.id} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}
