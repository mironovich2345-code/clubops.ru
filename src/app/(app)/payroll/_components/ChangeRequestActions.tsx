"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  approveChangeRequest,
  rejectChangeRequest,
  returnChangeRequest,
  cancelChangeRequest,
  resubmitChangeRequest,
  type ChangeRequestState,
} from "../change-requests/actions";

const initial: ChangeRequestState = { ok: false };

function Btn({ label, tone }: { label: string; tone: "brand" | "rose" | "sky" | "slate" }) {
  const { pending } = useFormStatus();
  const cls =
    tone === "brand"
      ? "bg-brand-600 hover:bg-brand-700 text-white"
      : tone === "rose"
        ? "bg-rose-600 hover:bg-rose-700 text-white"
        : tone === "sky"
          ? "bg-sky-600 hover:bg-sky-700 text-white"
          : "border border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300";
  return (
    <button type="submit" disabled={pending} className={`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium shadow-sm disabled:opacity-60 ${cls}`}>
      {pending ? "..." : label}
    </button>
  );
}

/**
 * GD/owner decision panel (approve / return / reject) + confirmation. Before/after is
 * shown by the parent; here we gate the mutation. A comment is required to return/reject.
 */
export function ReviewActions({ requestId, impactSummary }: { requestId: string; impactSummary: string }) {
  const [approveState, approve] = useFormState(approveChangeRequest, initial);
  const [returnState, ret] = useFormState(returnChangeRequest, initial);
  const [rejectState, reject] = useFormState(rejectChangeRequest, initial);

  return (
    <div className="space-y-3">
      <form action={approve} onSubmit={(e) => { if (!window.confirm(`Согласовать и применить изменение?\n${impactSummary}`)) e.preventDefault(); }} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="requestId" value={requestId} />
        <input name="comment" placeholder="Комментарий (необязательно)" className="input grow text-sm" />
        <Btn label="Согласовать и применить" tone="brand" />
        {approveState.error ? <span className="w-full text-xs text-rose-600">{approveState.error}</span> : null}
      </form>

      <div className="grid gap-2 sm:grid-cols-2">
        <form action={ret} className="rounded-lg border border-slate-200 p-2 dark:border-slate-800">
          <input type="hidden" name="requestId" value={requestId} />
          <input name="comment" required placeholder="Что доработать (обязательно)" className="input mb-2 w-full text-sm" />
          <Btn label="Вернуть на доработку" tone="sky" />
          {returnState.error ? <div className="mt-1 text-xs text-rose-600">{returnState.error}</div> : null}
        </form>
        <form action={reject} onSubmit={(e) => { if (!window.confirm("Отклонить заявку? Расчёт не изменится.")) e.preventDefault(); }} className="rounded-lg border border-slate-200 p-2 dark:border-slate-800">
          <input type="hidden" name="requestId" value={requestId} />
          <input name="comment" required placeholder="Причина отклонения (обязательно)" className="input mb-2 w-full text-sm" />
          <Btn label="Отклонить" tone="rose" />
          {rejectState.error ? <div className="mt-1 text-xs text-rose-600">{rejectState.error}</div> : null}
        </form>
      </div>
    </div>
  );
}

/** Author controls: cancel an open request, or edit+resubmit a returned one. */
export function AuthorActions({ requestId, canResubmit }: { requestId: string; canResubmit: boolean }) {
  const [cancelState, cancel] = useFormState(cancelChangeRequest, initial);
  const [resubmitState, resubmit] = useFormState(resubmitChangeRequest, initial);
  return (
    <div className="space-y-2">
      {canResubmit ? (
        <form action={resubmit} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="requestId" value={requestId} />
          <input name="regionalComment" placeholder="Комментарий к доработке" className="input grow text-sm" />
          <Btn label="Отправить повторно" tone="brand" />
          {resubmitState.error ? <span className="w-full text-xs text-rose-600">{resubmitState.error}</span> : null}
        </form>
      ) : null}
      <form action={cancel} onSubmit={(e) => { if (!window.confirm("Отменить заявку?")) e.preventDefault(); }}>
        <input type="hidden" name="requestId" value={requestId} />
        <Btn label="Отменить заявку" tone="slate" />
        {cancelState.error ? <div className="mt-1 text-xs text-rose-600">{cancelState.error}</div> : null}
      </form>
    </div>
  );
}
