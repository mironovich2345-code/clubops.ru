"use client";

import { useFormState, useFormStatus } from "react-dom";
import { assignEmployeeAction, excludeIdentityAction, type CashierActionState } from "../ofd-cashiers/actions";

const initial: CashierActionState = { ok: false };
export type EmployeeOption = { id: string; fullName: string };

function Btn({ label, tone }: { label: string; tone: "brand" | "rose" | "slate" }) {
  const { pending } = useFormStatus();
  const cls = tone === "brand" ? "bg-brand-600 hover:bg-brand-700 text-white" : tone === "rose" ? "bg-rose-600 hover:bg-rose-700 text-white" : "border border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300";
  return <button type="submit" disabled={pending} className={`inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 text-sm font-medium shadow-sm disabled:opacity-60 ${cls}`}>{pending ? "..." : label}</button>;
}

/**
 * Confirm / manually assign an employee to a cashier identity, or exclude it (spec §19).
 * Mobile-first: full-width select, ≥44px buttons. Server re-checks capability + tenant.
 */
export function CashierMappingActions({ identityId, employees, suggestedEmployeeId, firstSeen }: { identityId: string; employees: EmployeeOption[]; suggestedEmployeeId: string | null; firstSeen: string }) {
  const [assignState, assign] = useFormState(assignEmployeeAction, initial);
  const [excludeState, exclude] = useFormState(excludeIdentityAction, initial);

  return (
    <div className="space-y-3">
      <form action={assign} className="space-y-2">
        <input type="hidden" name="identityId" value={identityId} />
        <input type="hidden" name="manual" value="1" />
        <label className="block">
          <span className="mb-1 block text-[11px] text-slate-500">Сотрудник</span>
          <select name="employeeId" defaultValue={suggestedEmployeeId ?? ""} required className="input w-full text-sm">
            <option value="" disabled>Выберите сотрудника</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="mb-1 block text-[11px] text-slate-500">Действует с</span>
            <input name="effectiveFrom" type="date" defaultValue={firstSeen} className="input text-sm" />
          </label>
          <label className="block grow">
            <span className="mb-1 block text-[11px] text-slate-500">Комментарий</span>
            <input name="comment" className="input w-full text-sm" />
          </label>
          <Btn label="Подтвердить сопоставление" tone="brand" />
        </div>
        {assignState.error ? <div className="text-xs text-rose-600">{assignState.error}</div> : null}
        {assignState.ok && assignState.notice ? <div className="text-xs text-emerald-600">{assignState.notice}</div> : null}
      </form>

      <form action={exclude} onSubmit={(e) => { if (!window.confirm("Исключить кассира из распределения зарплаты?")) e.preventDefault(); }} className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3 dark:border-slate-800/70">
        <input type="hidden" name="identityId" value={identityId} />
        <label className="block grow">
          <span className="mb-1 block text-[11px] text-slate-500">Причина исключения</span>
          <input name="reason" className="input w-full text-sm" />
        </label>
        <Btn label="Исключить" tone="rose" />
        {excludeState.error ? <div className="w-full text-xs text-rose-600">{excludeState.error}</div> : null}
      </form>
    </div>
  );
}
