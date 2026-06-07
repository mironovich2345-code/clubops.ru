"use client";

import { useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { createSalesReport, type CreateReportState } from "../report-actions";
import { SALES_REPORT_ROWS, validateSalesReportLines } from "@/lib/sales-report-rows";

const initial: CreateReportState = { ok: false };

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Сохранение..." : "Создать отчёт"}
    </button>
  );
}

export function SalesReportForm({ clubs }: { clubs: Array<{ id: string; name: string }> }) {
  const [state, action] = useFormState(createSalesReport, initial);
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const warnings = useMemo(() => {
    const byKey: Record<string, number> = {};
    for (const r of SALES_REPORT_ROWS) {
      const n = Number(String(amounts[r.key] ?? "0").replace(",", "."));
      byKey[r.key] = Number.isFinite(n) ? n : 0;
    }
    return validateSalesReportLines(byKey);
  }, [amounts]);

  return (
    <div className="mb-8 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
        Новый сменный отчёт
      </div>
      <form action={action} className="p-4">
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Дата отчёта</span>
            <input type="date" name="reportDate" defaultValue={todayInput()} className="input w-full" />
            {state.fieldErrors?.reportDate ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.reportDate}</span> : null}
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Клуб</span>
            <select name="clubId" defaultValue={clubs[0]?.id ?? ""} className="input w-full">
              {clubs.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {state.fieldErrors?.clubId ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.clubId}</span> : null}
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Менеджер смены</span>
            <input type="text" name="managerName" placeholder="ФИО" className="input w-full" />
          </label>
        </div>

        <div className="overflow-hidden rounded-md border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Строка</th>
                <th className="px-4 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Сумма, ₽</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {SALES_REPORT_ROWS.map((row) => (
                <tr key={row.key} className="hover:bg-slate-50">
                  <td className="px-4 py-1.5 text-sm text-slate-700">{row.label}</td>
                  <td className="px-4 py-1.5 text-right">
                    <input
                      type="text"
                      inputMode="decimal"
                      name={`amount_${row.key}`}
                      defaultValue="0"
                      onChange={(e) => setAmounts((prev) => ({ ...prev, [row.key]: e.target.value }))}
                      className="input w-40 text-right"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <label className="mt-4 block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Примечания</span>
          <textarea name="notes" rows={2} className="input w-full" />
        </label>

        {warnings.length > 0 ? (
          <div className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
            <div className="font-medium">Есть расхождения в отчёте</div>
            <ul className="mt-1 list-inside list-disc text-xs">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            <div className="mt-1 text-xs text-amber-700">Сохранение не блокируется — бухгалтер увидит расхождения при проверке.</div>
          </div>
        ) : null}

        {state.error && !state.fieldErrors ? (
          <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">{state.error}</div>
        ) : null}

        <div className="mt-4 flex justify-end">
          <Submit />
        </div>
      </form>
    </div>
  );
}
