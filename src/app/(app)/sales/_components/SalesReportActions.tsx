"use client";

import { useRef } from "react";
import { transitionSalesReport } from "../report-actions";
import {
  SALES_REPORT_ACTION_LABELS,
  SALES_REPORT_DESTRUCTIVE_ACTIONS,
  type SalesReportAction,
} from "@/lib/sales-report-rows";

const TONE: Record<SalesReportAction, string> = {
  confirm: "border-emerald-300 bg-emerald-600 text-white hover:bg-emerald-700",
  reject: "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100",
  cancel: "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
};

export function SalesReportActions({ reportId, actions }: { reportId: string; actions: SalesReportAction[] }) {
  const formRef = useRef<HTMLFormElement>(null);

  if (actions.length === 0) return <span className="text-xs text-slate-400">Нет доступных действий</span>;

  return (
    <form ref={formRef} action={transitionSalesReport} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="reportId" value={reportId} />
      {actions.includes("reject") ? (
        <input
          type="text"
          name="rejectionReason"
          placeholder="Причина отклонения (необязательно)"
          className="input w-64"
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <button
            key={a}
            type="submit"
            name="action"
            value={a}
            onClick={(e) => {
              if (SALES_REPORT_DESTRUCTIVE_ACTIONS.includes(a) && !window.confirm("Вы уверены?")) {
                e.preventDefault();
              }
            }}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium ${TONE[a]}`}
          >
            {SALES_REPORT_ACTION_LABELS[a]}
          </button>
        ))}
      </div>
    </form>
  );
}
