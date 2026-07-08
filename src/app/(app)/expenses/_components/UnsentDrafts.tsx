"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { cancelSimplifiedExpense } from "../simplified-actions";

type Draft = { id: string; title: string; dateText: string; amountText: string; clubName: string };
type State = { ok: boolean; error?: string };
const initial: State = { ok: false };

function CancelBtn() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60">
      {pending ? "…" : "Отменить"}
    </button>
  );
}

function CancelDraft({ id }: { id: string }) {
  const router = useRouter();
  const [state, action] = useFormState(cancelSimplifiedExpense, initial);
  // Refresh the server component so the cancelled draft leaves the list.
  useEffect(() => { if (state.ok) router.refresh(); }, [state.ok, router]);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        const reason = window.prompt("Причина отмены:");
        const input = e.currentTarget.querySelector<HTMLInputElement>('input[name="reason"]');
        if (!reason || !reason.trim()) { e.preventDefault(); return; }
        if (input) input.value = reason.trim();
      }}
      className="inline"
    >
      <input type="hidden" name="expenseId" value={id} />
      <input type="hidden" name="reason" value="" />
      <CancelBtn />
      {state.error ? <span className="ml-2 text-xs text-rose-600">{state.error}</span> : null}
    </form>
  );
}

/** Compact author-only block of the current user's unsent `draft` expenses. */
export function UnsentDrafts({ drafts }: { drafts: Draft[] }) {
  if (drafts.length === 0) return null;
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 shadow-sm">
      <div className="mb-2 text-sm font-semibold text-amber-900">Не отправленные черновики</div>
      <ul className="divide-y divide-amber-200/70">
        {drafts.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-slate-800">{d.title}</div>
              <div className="text-xs text-slate-500">{d.dateText} · {d.amountText} · {d.clubName}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link href={`/expenses/${d.id}`} className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">
                Продолжить заполнение
              </Link>
              <CancelDraft id={d.id} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
