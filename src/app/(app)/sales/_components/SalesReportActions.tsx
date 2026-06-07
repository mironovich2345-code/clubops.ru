"use client";

import { useState } from "react";
import { transitionSalesReport } from "../report-actions";
import type { SalesReportAction } from "@/lib/sales-report-rows";

export function SalesReportActions({ reportId, actions }: { reportId: string; actions: SalesReportAction[] }) {
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");

  if (actions.length === 0) return <span className="text-xs text-slate-400">Нет доступных действий</span>;

  const canConfirm = actions.includes("confirm");
  const canReject = actions.includes("reject");
  const canCancel = actions.includes("cancel");

  return (
    <form action={transitionSalesReport} className="space-y-3">
      <input type="hidden" name="reportId" value={reportId} />
      {/* Controlled values submitted via hidden inputs. */}
      <input type="hidden" name="accountantComment" value={comment} />
      <input type="hidden" name="rejectionReason" value={reason} />

      {canConfirm ? (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Комментарий бухгалтера (необязательно)</span>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            className="input w-full"
            placeholder="Например: проверено, расхождений нет"
          />
        </label>
      ) : null}

      {canReject ? (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Причина отклонения (обязательно)</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="input w-full"
            placeholder="Что не так с отчётом"
          />
        </label>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canConfirm ? (
          <button
            type="submit"
            name="action"
            value="confirm"
            className="rounded-md border border-emerald-300 bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Подтвердить
          </button>
        ) : null}
        {canReject ? (
          <button
            type="submit"
            name="action"
            value="reject"
            onClick={(e) => {
              if (!reason.trim()) {
                e.preventDefault();
                window.alert("Укажите причину отклонения");
                return;
              }
              if (!window.confirm("Отклонить отчёт?")) e.preventDefault();
            }}
            className="rounded-md border border-rose-200 bg-rose-50 px-4 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-100"
          >
            Отклонить
          </button>
        ) : null}
        {canCancel ? (
          <button
            type="submit"
            name="action"
            value="cancel"
            onClick={(e) => {
              if (!window.confirm("Отменить отчёт?")) e.preventDefault();
            }}
            className="rounded-md border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Отменить
          </button>
        ) : null}
      </div>
    </form>
  );
}
