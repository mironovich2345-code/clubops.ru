"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { formatKopeks } from "@/lib/money";

export type RosterRow = {
  calculationId: string;
  name: string;
  roleLabel: string;
  schemeLabel: string;
  status: string;
  statusLabel: string;
  grossKopeks: number;
  paidKopeks: number;
  remainingKopeks: number;
  problems: number;
  breakdown: Array<{ label: string; amountKopeks: number }>;
};

/**
 * Compact period roster. Краткий вид (по умолчанию): одна строка на сотрудника с
 * итогами; подробный вид добавляет свёртку начисления. Полный расчёт открывается на
 * отдельной странице /payroll/periods/[id]/employees/[calculationId] (§6).
 */
export function PeriodRoster({ periodId, rows }: { periodId: string; rows: RosterRow[] }) {
  const [detailed, setDetailed] = useState(false);
  return (
    <div>
      <div className="mb-3 flex items-center justify-end gap-2 text-xs">
        <span className="text-slate-400">Вид:</span>
        <button type="button" onClick={() => setDetailed(false)} className={`rounded-md px-2.5 py-1 font-medium ${!detailed ? "bg-brand-600 text-white" : "border border-slate-300 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"}`}>Краткий</button>
        <button type="button" onClick={() => setDetailed(true)} className={`rounded-md px-2.5 py-1 font-medium ${detailed ? "bg-brand-600 text-white" : "border border-slate-300 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"}`}>Подробный</button>
      </div>

      {/* Mobile cards */}
      <div className="space-y-2 md:hidden">
        {rows.map((r) => (
          <Link key={r.calculationId} href={`/payroll/periods/${periodId}/employees/${r.calculationId}`} className="block rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-900 dark:text-slate-100">{r.name}</span>
              <StatusChip label={r.statusLabel} />
            </div>
            <div className="mt-0.5 text-xs text-slate-500">{r.roleLabel} · {r.schemeLabel}</div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div><div className="text-slate-400">Начислено</div><div className="font-medium tabular-nums">{formatKopeks(r.grossKopeks)}</div></div>
              <div><div className="text-slate-400">Выплачено</div><div className="font-medium tabular-nums">{formatKopeks(r.paidKopeks)}</div></div>
              <div><div className="text-slate-400">Остаток</div><div className={`font-medium tabular-nums ${r.remainingKopeks > 0 ? "text-amber-600" : ""}`}>{formatKopeks(r.remainingKopeks)}</div></div>
            </div>
            {r.problems > 0 ? <div className="mt-1 text-xs text-amber-600">⚠ проблем: {r.problems}</div> : null}
            {detailed && r.breakdown.length ? <BreakdownList lines={r.breakdown} /> : null}
            <div className="mt-2 text-xs text-brand-600">Открыть расчёт →</div>
          </Link>
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-2xl border border-slate-200 md:block dark:border-slate-800">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
            <thead className="bg-slate-50 dark:bg-slate-800/50"><tr>
              <Th>ФИО</Th><Th>Должность</Th><Th>Схема</Th><Th>Статус</Th>
              <Th className="text-right">Начислено</Th><Th className="text-right">Выплачено</Th><Th className="text-right">Остаток</Th><Th className="text-right">Проблем</Th><Th className="text-right"></Th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100 bg-white dark:divide-slate-800/70 dark:bg-slate-900">
              {rows.map((r) => (
                <Fragment key={r.calculationId}>
                  <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">{r.name}</Td>
                    <Td className="whitespace-nowrap">{r.roleLabel}</Td>
                    <Td className="whitespace-nowrap text-slate-500">{r.schemeLabel}</Td>
                    <Td><StatusChip label={r.statusLabel} /></Td>
                    <Td className="text-right tabular-nums">{formatKopeks(r.grossKopeks)}</Td>
                    <Td className="text-right tabular-nums">{formatKopeks(r.paidKopeks)}</Td>
                    <Td className={`text-right tabular-nums ${r.remainingKopeks > 0 ? "text-amber-600" : ""}`}>{formatKopeks(r.remainingKopeks)}</Td>
                    <Td className="text-right">{r.problems > 0 ? <span className="text-amber-600">{r.problems}</span> : <span className="text-slate-300">0</span>}</Td>
                    <Td className="text-right"><Link href={`/payroll/periods/${periodId}/employees/${r.calculationId}`} className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">Открыть расчёт</Link></Td>
                  </tr>
                  {detailed && r.breakdown.length ? (
                    <tr className="bg-slate-50/60 dark:bg-slate-800/20"><td colSpan={9} className="px-4 py-2"><BreakdownList lines={r.breakdown} /></td></tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function BreakdownList({ lines }: { lines: Array<{ label: string; amountKopeks: number }> }) {
  return (
    <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500">
      {lines.map((l, i) => (
        <div key={i}><dt className="inline">{l.label}: </dt><dd className="inline font-medium tabular-nums text-slate-700 dark:text-slate-300">{formatKopeks(l.amountKopeks)}</dd></div>
      ))}
    </dl>
  );
}
function StatusChip({ label }: { label: string }) {
  return <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">{label}</span>;
}
function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th scope="col" className={`whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${className ?? ""}`}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 align-middle text-sm text-slate-700 dark:text-slate-300 ${className ?? ""}`}>{children}</td>;
}
