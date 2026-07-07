"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  submitExpense, approveRegionalBudget, approveOwnerBudget, verifyExpense,
  returnForCorrection, cancelSimplifiedExpense, changeExpenseDate,
} from "../../simplified-actions";

type State = { ok: boolean; error?: string };
const initial: State = { ok: false };

export type WorkflowFlags = {
  canSubmit: boolean;
  canApproveRegional: boolean;
  canApproveOwner: boolean;
  canVerify: boolean;
  canReturn: boolean;
  canCancel: boolean;
  canChangeDate: boolean;
};

function Btn({ label, tone = "brand" }: { label: string; tone?: "brand" | "rose" | "slate" | "emerald" }) {
  const { pending } = useFormStatus();
  const cls = tone === "rose" ? "bg-rose-600 text-white hover:bg-rose-700"
    : tone === "emerald" ? "bg-emerald-600 text-white hover:bg-emerald-700"
    : tone === "slate" ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
    : "bg-brand-600 text-white hover:bg-brand-700";
  return <button type="submit" disabled={pending} className={`rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60 ${cls}`}>{pending ? "…" : label}</button>;
}

function SimpleAction({ expenseId, action, label, tone }: { expenseId: string; action: (p: State | undefined, fd: FormData) => Promise<State>; label: string; tone?: "brand" | "emerald" }) {
  const [state, formAction] = useFormState(action, initial);
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="expenseId" value={expenseId} />
      <Btn label={label} tone={tone} />
      {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
    </form>
  );
}

function ReasonAction({ expenseId, action, label, tone, promptText }: { expenseId: string; action: (p: State | undefined, fd: FormData) => Promise<State>; label: string; tone: "rose" | "slate"; promptText: string }) {
  const [state, formAction] = useFormState(action, initial);
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        const reason = window.prompt(promptText);
        const input = e.currentTarget.querySelector<HTMLInputElement>('input[name="reason"]');
        if (!reason || !reason.trim()) { e.preventDefault(); return; }
        if (input) input.value = reason.trim();
      }}
      className="inline-flex items-center gap-2"
    >
      <input type="hidden" name="expenseId" value={expenseId} />
      <input type="hidden" name="reason" value="" />
      <Btn label={label} tone={tone} />
      {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
    </form>
  );
}

function DateAction({ expenseId }: { expenseId: string }) {
  const [state, formAction] = useFormState(changeExpenseDate, initial);
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2 rounded-md border border-slate-200 p-2">
      <input type="hidden" name="expenseId" value={expenseId} />
      <label className="text-xs text-slate-600">Новая дата
        <input type="date" name="expenseDate" required className="input ml-2" />
      </label>
      <input name="reason" required placeholder="Причина" className="input" />
      <Btn label="Изменить дату" tone="slate" />
      {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
    </form>
  );
}

export function WorkflowActions({ expenseId, flags }: { expenseId: string; flags: WorkflowFlags }) {
  const any = Object.values(flags).some(Boolean);
  if (!any) return null;
  return (
    <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 text-sm font-semibold text-slate-700">Действия</div>
      <div className="flex flex-wrap items-center gap-3">
        {flags.canSubmit ? <SimpleAction expenseId={expenseId} action={submitExpense} label="Отправить" /> : null}
        {flags.canApproveRegional ? <SimpleAction expenseId={expenseId} action={approveRegionalBudget} label="Согласовать (РД)" tone="emerald" /> : null}
        {flags.canApproveOwner ? <SimpleAction expenseId={expenseId} action={approveOwnerBudget} label="Согласовать (собственник)" tone="emerald" /> : null}
        {flags.canVerify ? <SimpleAction expenseId={expenseId} action={verifyExpense} label="Проверить (бухгалтерия)" tone="emerald" /> : null}
        {flags.canReturn ? <ReasonAction expenseId={expenseId} action={returnForCorrection} label="Вернуть на исправление" tone="slate" promptText="Причина возврата:" /> : null}
        {flags.canCancel ? <ReasonAction expenseId={expenseId} action={cancelSimplifiedExpense} label="Отменить" tone="rose" promptText="Причина отмены:" /> : null}
      </div>
      {flags.canChangeDate ? <div className="mt-3"><DateAction expenseId={expenseId} /></div> : null}
    </div>
  );
}
