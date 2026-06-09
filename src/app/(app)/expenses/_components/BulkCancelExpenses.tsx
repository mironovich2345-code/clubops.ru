"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { previewBulkCancelExpenses, cancelExpensesForMonth } from "../actions";
import { formatKopeks } from "@/lib/money";

type BulkState = { ok: boolean; error?: string; count?: number; totalKopeks?: number; done?: boolean };
const initial: BulkState = { ok: false };

function PreviewButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60">
      {pending ? "Подсчёт..." : "Показать"}
    </button>
  );
}
function ExecButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-rose-700 disabled:opacity-60">
      {pending ? "Отмена..." : "Отменить расходы за месяц"}
    </button>
  );
}

/** Regional/manager bulk-cancel of a club's active expenses for a month, with a
 * preview and an explicit "ОТМЕНИТЬ" confirmation. */
export function BulkCancelExpenses({
  clubs,
  categories,
  defaultClubId,
  defaultMonth,
}: {
  clubs: Array<{ id: string; name: string }>;
  categories: ReadonlyArray<{ key: string; label: string }>;
  defaultClubId: string;
  defaultMonth: string;
}) {
  const [month, setMonth] = useState(defaultMonth);
  const [clubId, setClubId] = useState(defaultClubId);
  const [category, setCategory] = useState("");
  const [confirm, setConfirm] = useState("");
  const [preview, previewAction] = useFormState(previewBulkCancelExpenses, initial);
  const [execState, execAction] = useFormState(cancelExpensesForMonth, initial);

  const hidden = (
    <>
      <input type="hidden" name="month" value={month} />
      <input type="hidden" name="clubId" value={clubId} />
      <input type="hidden" name="category" value={category} />
    </>
  );

  return (
    <div className="mb-6 rounded-lg border border-rose-200 bg-white p-4 shadow-sm">
      <div className="text-sm font-semibold text-slate-700">Отменить расходы за месяц</div>
      <p className="mt-0.5 text-xs text-slate-500">Массовая отмена активных расходов выбранного клуба за месяц. Отменённые расходы не учитываются в отчётах.</p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Месяц</span>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Клуб</span>
          <select value={clubId} onChange={(e) => setClubId(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm">
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Статья (необязательно)</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm">
            <option value="">Все статьи</option>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <form action={previewAction}>{hidden}<PreviewButton /></form>
        {preview.ok ? (
          <span className="text-sm text-slate-700">
            Будет отменено: <b>{preview.count}</b> расходов · Сумма: <b>{formatKopeks(preview.totalKopeks ?? 0)}</b>
          </span>
        ) : preview.error ? (
          <span className="text-sm text-rose-600">{preview.error}</span>
        ) : null}
      </div>

      <form action={execAction} className="mt-3 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
        {hidden}
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Для подтверждения введите ОТМЕНИТЬ</span>
          <input name="confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="ОТМЕНИТЬ" className="w-40 rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
        </label>
        <input name="reason" placeholder="Причина (необязательно)" className="w-56 rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
        <ExecButton />
      </form>
      {execState.done ? (
        execState.count === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Под выбранные условия активных расходов не найдено.</p>
        ) : (
          <p className="mt-2 text-sm text-emerald-700">Отменено расходов: {execState.count} на сумму {formatKopeks(execState.totalKopeks ?? 0)}.</p>
        )
      ) : execState.error ? (
        <p className="mt-2 text-sm text-rose-600">{execState.error}</p>
      ) : null}
    </div>
  );
}
