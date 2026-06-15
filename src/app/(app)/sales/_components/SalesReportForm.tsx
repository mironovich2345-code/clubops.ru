"use client";

import { useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { createSalesReport, type CreateReportState } from "../report-actions";
import {
  SALES_REPORT_ROWS,
  REPORT_SECTIONS,
  CALC_HINT,
  ENCASHMENT_KEY,
  REVENUE_LINE_KEY,
  CASH_MOVEMENT_KEYS,
  computeSalesReportTotals,
  type ReportSection,
} from "@/lib/sales-report-rows";
import { employeePositionLabel, type ManagerCandidate } from "@/lib/club-employees";

const initial: CreateReportState = { ok: false };
const rub = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmt = (n: number) => `${rub.format(n)} ₽`;

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toNum(s: string | undefined): number {
  const n = Number(String(s ?? "0").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function Submit({ total, disabled }: { total: number; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
      <div className="text-sm text-slate-600">
        Общая выручка: <span className="text-base font-semibold text-slate-900">{fmt(total)}</span>
      </div>
      <button
        type="submit"
        disabled={pending || disabled}
        className="inline-flex items-center justify-center rounded-md bg-brand-600 px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
      >
        {pending ? "Сохранение..." : "Создать отчёт"}
      </button>
    </div>
  );
}

export function SalesReportForm({
  clubs,
  employees,
}: {
  clubs: Array<{ id: string; name: string }>;
  employees: ManagerCandidate[];
}) {
  const [state, action] = useFormState(createSalesReport, initial);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [clubId, setClubId] = useState<string>(clubs[0]?.id ?? "");

  // Only managers / night managers of the selected club can close its shift.
  const managerOptions = useMemo(
    () => employees.filter((e) => e.clubId === clubId),
    [employees, clubId],
  );

  // Live calculated rows (rubles) from the base inputs — same formula the server
  // recomputes authoritatively on save.
  const computed = useMemo(() => {
    const base: Record<string, number> = {};
    for (const r of SALES_REPORT_ROWS) if (!r.calc) base[r.key] = toNum(amounts[r.key]);
    return computeSalesReportTotals(base);
  }, [amounts]);

  const encashment = computed[ENCASHMENT_KEY] ?? 0;
  // Base amounts must be non-negative (server enforces the same rule).
  const hasNegative = useMemo(
    () => SALES_REPORT_ROWS.some((r) => !r.calc && toNum(amounts[r.key]) < 0),
    [amounts],
  );

  return (
    <div className="mb-8 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
        Новый сменный отчёт
      </div>
      <form action={action} className="px-4 pb-2 pt-4">
        <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Дата отчёта</span>
            <input type="date" name="reportDate" defaultValue={todayInput()} className="input w-full" />
            {state.fieldErrors?.reportDate ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.reportDate}</span> : null}
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Клуб</span>
            <select name="clubId" value={clubId} onChange={(e) => setClubId(e.target.value)} className="input w-full">
              {clubs.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {state.fieldErrors?.clubId ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.clubId}</span> : null}
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Менеджер смены</span>
            <select name="managerEmployeeId" defaultValue="" required className="input w-full">
              <option value="" disabled>Выберите менеджера</option>
              {managerOptions.map((m) => (
                <option key={m.id} value={m.id}>{m.fullName} · {employeePositionLabel(m.position)}</option>
              ))}
            </select>
            {managerOptions.length === 0 ? (
              <span className="mt-1 block text-xs text-amber-600">
                Нет активных менеджеров в этом клубе — добавьте сотрудника на странице «Сотрудники».
              </span>
            ) : null}
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {REPORT_SECTIONS.map((section) => (
            <Section
              key={section.key}
              title={section.label}
              sectionKey={section.key}
              amounts={amounts}
              computed={computed}
              onChange={(key, value) => setAmounts((prev) => ({ ...prev, [key]: value }))}
            />
          ))}
        </div>

        {/* Part 4 — encashment / withdrawal kept apart from ООО sales */}
        <CashMovementBlock onChange={(key, value) => setAmounts((prev) => ({ ...prev, [key]: value }))} />

        <label className="mt-4 block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Примечания</span>
          <textarea name="notes" rows={2} className="input w-full" />
        </label>

        {encashment > 0 ? (
          <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">
            Указана инкассация — приложите документ инкассации на странице отчёта после сохранения.
          </div>
        ) : null}

        {hasNegative ? (
          <div className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
            Сумма не может быть отрицательной
          </div>
        ) : null}

        {state.error && !state.fieldErrors ? (
          <div className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
            {state.error}
            {state.existingReportId ? (
              <a
                href={`/sales/reports/${state.existingReportId}`}
                className="ml-2 font-medium text-brand-600 underline hover:text-brand-700"
              >
                Открыть существующий отчёт
              </a>
            ) : null}
          </div>
        ) : null}

        <Submit total={computed[REVENUE_LINE_KEY] ?? 0} disabled={hasNegative} />
      </form>
    </div>
  );
}

function CashMovementBlock({ onChange }: { onChange: (key: string, value: string) => void }) {
  const rows = SALES_REPORT_ROWS.filter((r) => CASH_MOVEMENT_KEYS.includes(r.key) && !r.calc);
  return (
    <div className="mt-4 overflow-hidden rounded-md border border-slate-200">
      <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Инкассация и изъятия
      </div>
      <div className="divide-y divide-slate-100 sm:grid sm:grid-cols-2 sm:divide-y-0">
        {rows.map((row) => (
          <label key={row.key} className="flex items-center justify-between gap-2 px-3 py-1.5">
            <span className="min-w-0 truncate text-sm text-slate-700">{row.label}</span>
            <input
              type="text"
              inputMode="decimal"
              name={`amount_${row.key}`}
              defaultValue="0"
              onChange={(e) => onChange(row.key, e.target.value)}
              className="input w-28 text-right sm:w-32"
            />
          </label>
        ))}
      </div>
      <div className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500">
        Это движение наличных, а не выручка. Приложите подтверждающие документы на странице отчёта.
      </div>
    </div>
  );
}

function Section({
  title,
  sectionKey,
  amounts,
  computed,
  onChange,
}: {
  title: string;
  sectionKey: ReportSection;
  amounts: Record<string, string>;
  computed: Record<string, number>;
  onChange: (key: string, value: string) => void;
}) {
  // Cash movements (инкассация / изъятие) are rendered in their own block below.
  const rows = SALES_REPORT_ROWS.filter((r) => r.section === sectionKey && !CASH_MOVEMENT_KEYS.includes(r.key));
  return (
    <div className="overflow-hidden rounded-md border border-slate-200">
      <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </div>
      {sectionKey === "ip" ? (
        <div className="border-b border-slate-100 bg-violet-50/40 px-3 py-1.5 text-[11px] text-violet-700">
          Выручка ИП автоматически учитывается как ПТ
        </div>
      ) : null}
      <div className="divide-y divide-slate-100">
        {rows.map((row) =>
          row.calc ? (
            <div key={row.key} className="flex items-center justify-between gap-2 bg-slate-50 px-3 py-1.5">
              <div className="min-w-0">
                <div className="truncate text-sm text-slate-600">{row.label}</div>
                <div className="text-[10px] text-slate-400">{CALC_HINT}</div>
              </div>
              <div className="whitespace-nowrap text-sm font-semibold text-slate-900">{fmt(computed[row.key] ?? 0)}</div>
            </div>
          ) : (
            <label key={row.key} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span className="min-w-0 truncate text-sm text-slate-700">{row.label}</span>
              <input
                type="text"
                inputMode="decimal"
                name={`amount_${row.key}`}
                defaultValue="0"
                onChange={(e) => onChange(row.key, e.target.value)}
                className="input w-28 text-right sm:w-32"
              />
            </label>
          ),
        )}
      </div>
    </div>
  );
}
