"use client";

import { approveBudgetRequest, rejectBudgetRequest } from "../actions";

export function RequestActions({
  requestId,
  canDecide,
}: {
  requestId: string;
  canDecide: boolean;
}) {
  if (!canDecide) return <span className="text-xs text-slate-400">—</span>;

  return (
    <div className="flex gap-2">
      <form action={approveBudgetRequest}>
        <input type="hidden" name="requestId" value={requestId} />
        <button
          type="submit"
          className="rounded-md border border-emerald-300 bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
        >
          Согласовать
        </button>
      </form>
      <form action={rejectBudgetRequest}>
        <input type="hidden" name="requestId" value={requestId} />
        <button
          type="submit"
          className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100"
        >
          Отклонить
        </button>
      </form>
    </div>
  );
}
