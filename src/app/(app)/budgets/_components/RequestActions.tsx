"use client";

import { useRef } from "react";
import { decideBudgetRequest } from "../actions";

export function RequestActions({
  requestId,
  canApprove,
  canReject,
  requiresDoubleConfirm,
}: {
  requestId: string;
  canApprove: boolean;
  canReject: boolean;
  requiresDoubleConfirm: boolean;
}) {
  const approveForm = useRef<HTMLFormElement>(null);

  function onApprove(e: React.MouseEvent) {
    e.preventDefault();
    if (requiresDoubleConfirm) {
      // Owner approving a >20% overrun must confirm twice.
      if (!window.confirm("Вы уверены?")) return;
      if (!window.confirm("Проверьте ещё раз")) return;
    }
    approveForm.current?.requestSubmit();
  }

  if (!canApprove && !canReject) return <span className="text-xs text-slate-400">—</span>;

  return (
    <div className="flex gap-2">
      {canApprove ? (
        <form ref={approveForm} action={decideBudgetRequest}>
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="decision" value="approve" />
          {requiresDoubleConfirm ? (
            <>
              <input type="hidden" name="confirm1" value="yes" />
              <input type="hidden" name="confirm2" value="yes" />
            </>
          ) : null}
          <button
            type="submit"
            onClick={onApprove}
            className="rounded-md border border-emerald-300 bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
          >
            Согласовать
          </button>
        </form>
      ) : null}
      {canReject ? (
        <form action={decideBudgetRequest}>
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="decision" value="reject" />
          <button
            type="submit"
            className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100"
          >
            Отклонить
          </button>
        </form>
      ) : null}
    </div>
  );
}
