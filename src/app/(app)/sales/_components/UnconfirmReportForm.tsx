"use client";

import { useState } from "react";
import { unconfirmSalesReport } from "../report-actions";

const CONFIRM_TEXT =
  "Отчёт снова попадёт на проверку и перестанет учитываться в аналитике до повторного подтверждения.";

export function UnconfirmReportForm({ reportId }: { reportId: string }) {
  const [reason, setReason] = useState("");
  return (
    <form action={unconfirmSalesReport} className="space-y-3">
      <input type="hidden" name="reportId" value={reportId} />
      <p className="text-xs text-slate-500">{CONFIRM_TEXT}</p>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Причина (обязательно)</span>
        <input
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="input w-full"
          placeholder="Например: подтверждено по ошибке / найдено расхождение"
        />
      </label>
      <button
        type="submit"
        onClick={(e) => {
          if (!reason.trim()) {
            e.preventDefault();
            window.alert("Укажите причину отмены подтверждения");
            return;
          }
          if (!window.confirm(`${CONFIRM_TEXT} Продолжить?`)) e.preventDefault();
        }}
        className="rounded-md border border-amber-300 bg-amber-50 px-4 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
      >
        Отменить подтверждение
      </button>
    </form>
  );
}
