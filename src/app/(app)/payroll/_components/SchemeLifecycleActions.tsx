"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  submitSchemeDraft,
  approveSchemeDraft,
  rejectSchemeDraft,
  returnSchemeDraft,
  archiveScheme,
  type SchemeActionState,
} from "../schemes/actions";

const initial: SchemeActionState = { ok: false };

function Btn({ label, tone }: { label: string; tone: "brand" | "rose" | "sky" | "slate" }) {
  const { pending } = useFormStatus();
  const cls =
    tone === "brand" ? "bg-brand-600 hover:bg-brand-700 text-white"
      : tone === "rose" ? "bg-rose-600 hover:bg-rose-700 text-white"
      : tone === "sky" ? "bg-sky-600 hover:bg-sky-700 text-white"
      : "border border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300";
  return (
    <button type="submit" disabled={pending} className={`inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 text-sm font-medium shadow-sm disabled:opacity-60 ${cls}`}>
      {pending ? "..." : label}
    </button>
  );
}

/**
 * Version lifecycle controls (spec §12/§14). `canAuthor` = regional/schemes-manager (submit,
 * archive draft); `canActivate` = GD/owner/chief-accountant (approve/return/reject). Server
 * re-checks every capability + immutability; this only shows the relevant buttons per status.
 */
export function SchemeLifecycleActions({ schemeId, status, canAuthor, canActivate }: { schemeId: string; status: string; canAuthor: boolean; canActivate: boolean }) {
  const [submitState, submit] = useFormState(submitSchemeDraft, initial);
  const [approveState, approve] = useFormState(approveSchemeDraft, initial);
  const [rejectState, reject] = useFormState(rejectSchemeDraft, initial);
  const [returnState, ret] = useFormState(returnSchemeDraft, initial);
  const [archiveState, archive] = useFormState(archiveScheme, initial);

  const err = submitState.error || approveState.error || rejectState.error || returnState.error || archiveState.error;

  return (
    <div className="flex flex-wrap items-start gap-2">
      {canAuthor && status === "draft" ? (
        <form action={submit}><input type="hidden" name="schemeId" value={schemeId} /><Btn label="Отправить на согласование" tone="brand" /></form>
      ) : null}

      {canActivate && status === "pending_approval" ? (
        <>
          <form action={approve} onSubmit={(e) => { if (!window.confirm("Согласовать и активировать версию?")) e.preventDefault(); }}>
            <input type="hidden" name="schemeId" value={schemeId} /><Btn label="Согласовать и активировать" tone="brand" />
          </form>
          <form action={ret} className="flex items-center gap-1">
            <input type="hidden" name="schemeId" value={schemeId} />
            <input name="comment" placeholder="Комментарий" className="input h-11 text-sm" />
            <Btn label="Вернуть" tone="sky" />
          </form>
          <form action={reject} onSubmit={(e) => { if (!window.confirm("Отклонить версию?")) e.preventDefault(); }}>
            <input type="hidden" name="schemeId" value={schemeId} /><Btn label="Отклонить" tone="rose" />
          </form>
        </>
      ) : null}

      {canAuthor && ["draft", "rejected", "cancelled", "superseded"].includes(status) ? (
        <form action={archive} onSubmit={(e) => { if (!window.confirm("Архивировать версию?")) e.preventDefault(); }}>
          <input type="hidden" name="schemeId" value={schemeId} /><Btn label="Архивировать" tone="slate" />
        </form>
      ) : null}

      {err ? <span className="w-full text-xs text-rose-600">{err}</span> : null}
    </div>
  );
}
