"use client";

import { useFormState, useFormStatus } from "react-dom";
import { recordEmployeeAdvance, approveEmployeeAdvance, cancelEmployeeAdvance, type AdvanceState } from "../advance-actions";
import { formatKopeks } from "@/lib/money";

const initial: AdvanceState = { ok: false };

export type EmployeeAdvanceRow = {
  id: string;
  periodYear: number;
  periodMonth: number;
  amountKopeks: number;
  method: string | null;
  status: string;
  earnedToDateSource: string | null;
  comment: string | null;
};

const STATUS_LABEL: Record<string, string> = { requested: "Ожидает подтверждения регионала", paid: "Выдан", approved: "Подтверждён", canceled: "Отменён" };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? "…" : label}
    </button>
  );
}

export function EmployeeAdvancePanel({
  employeeId,
  clubId,
  currentMonth,
  canManage,
  canApprove,
  advances,
}: {
  employeeId: string;
  clubId: string;
  currentMonth: string; // YYYY-MM
  canManage: boolean;
  canApprove: boolean; // regional director
  advances: EmployeeAdvanceRow[];
}) {
  const [state, action] = useFormState(recordEmployeeAdvance, initial);
  return (
    <div>
      {advances.length > 0 ? (
        <ul className="mb-3 space-y-1 text-sm">
          {advances.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-slate-600 dark:text-slate-300">
                {String(a.periodMonth).padStart(2, "0")}.{a.periodYear} · {formatKopeks(a.amountKopeks)} · {a.method === "bank" ? "безнал" : "наличные"}
                {a.earnedToDateSource === "manual" ? <span className="ml-1 text-xs text-amber-600">ручная база</span> : null}
                <span className="ml-2 text-xs text-slate-400">{STATUS_LABEL[a.status] ?? a.status}</span>
              </span>
              <span className="flex gap-2">
                {canApprove && a.status === "requested" ? (
                  <form action={approveEmployeeAdvance}>
                    <input type="hidden" name="advanceId" value={a.id} />
                    <button type="submit" className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">Подтвердить и выдать</button>
                  </form>
                ) : null}
                {canManage && ["requested", "approved", "paid"].includes(a.status) ? (
                  <form action={cancelEmployeeAdvance} onSubmit={(e) => { if (!window.confirm("Отменить аванс?")) e.preventDefault(); }}>
                    <input type="hidden" name="advanceId" value={a.id} />
                    <button type="submit" className="text-slate-400 hover:text-rose-600">✕</button>
                  </form>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mb-3 text-sm text-slate-500 dark:text-slate-400">Авансов нет.</div>
      )}

      {canManage ? (
        <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <input type="hidden" name="employeeId" value={employeeId} />
          <input type="hidden" name="clubId" value={clubId} />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Месяц</span>
            <input type="month" name="month" defaultValue={currentMonth} className="input w-full" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Сумма, ₽</span>
            <input name="amount" type="number" min="0" step="0.01" className="input w-full" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Способ</span>
            <select name="method" defaultValue="cash" className="input w-full">
              <option value="cash">Наличные</option>
              <option value="bank">Безнал</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Заработано к дате, ₽ (если расчёта нет)</span>
            <input name="earnedToDate" type="number" min="0" step="0.01" className="input w-full" placeholder="вручную" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Комментарий</span>
            <input name="comment" className="input w-full" />
          </label>
          <div className="flex items-center gap-3 sm:col-span-3 lg:col-span-5">
            <Submit label="Выдать аванс" />
            {state.ok ? <span className="text-sm text-emerald-700">{state.notice}</span> : state.error ? <span className="text-sm text-rose-600">{state.error}</span> : null}
          </div>
        </form>
      ) : null}
      <p className="mt-2 text-xs text-slate-400">Аванс можно выдать в открытом текущем месяце до создания расчётного периода. Если расчёт не готов — укажите заработанную к дате сумму вручную (нужен комментарий); ручной аванс управляющего подтверждает региональный директор.</p>
    </div>
  );
}
