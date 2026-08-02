"use client";

import { approveBudgetChangeProposal, rejectBudgetChangeProposal, updateSalaryPlanningSettings } from "../proposal-actions";

/** Approve / reject buttons for a pending salary-budget change proposal (owner/GD only). */
export function SalaryProposalActions({ proposalId, canDecide }: { proposalId: string; canDecide: boolean }) {
  if (!canDecide) return <span className="text-xs text-slate-400">На согласовании</span>;
  return (
    <div className="flex gap-2">
      <form action={approveBudgetChangeProposal}>
        <input type="hidden" name="proposalId" value={proposalId} />
        <button type="submit" className="rounded-md border border-emerald-300 bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700">
          Согласовать
        </button>
      </form>
      <form action={rejectBudgetChangeProposal}>
        <input type="hidden" name="proposalId" value={proposalId} />
        <button type="submit" className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100">
          Отклонить
        </button>
      </form>
    </div>
  );
}

/** Owner/GD salary-planning settings: sync mode, taxes flag, pay-schedule days + weekend rule. */
export function PlanningSettingsForm({
  syncMode,
  includesTaxes,
  advanceDay,
  finalDay,
  weekendRule,
}: {
  syncMode: string;
  includesTaxes: boolean;
  advanceDay: number | null;
  finalDay: number | null;
  weekendRule: string | null;
}) {
  return (
    <form action={updateSalaryPlanningSettings} className="mt-4 grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2 lg:grid-cols-3 dark:border-slate-700 dark:bg-slate-800">
      <label className="text-xs">
        <span className="mb-1 block font-medium text-slate-600 dark:text-slate-300">Синхронизация бюджета</span>
        <select name="syncMode" defaultValue={syncMode} className="input w-full text-sm">
          <option value="manual">Вручную (без предложений)</option>
          <option value="suggested">Предлагать изменение</option>
          <option value="auto_sync">Автосинхронизация</option>
        </select>
      </label>
      <label className="text-xs">
        <span className="mb-1 block font-medium text-slate-600 dark:text-slate-300">День аванса (1–28)</span>
        <input name="advanceDay" type="number" min={1} max={28} defaultValue={advanceDay ?? ""} className="input w-full text-sm" placeholder="не задан" />
      </label>
      <label className="text-xs">
        <span className="mb-1 block font-medium text-slate-600 dark:text-slate-300">День расчёта (1–28)</span>
        <input name="finalDay" type="number" min={1} max={28} defaultValue={finalDay ?? ""} className="input w-full text-sm" placeholder="не задан" />
      </label>
      <label className="text-xs">
        <span className="mb-1 block font-medium text-slate-600 dark:text-slate-300">Перенос с выходных</span>
        <select name="weekendRule" defaultValue={weekendRule ?? "none"} className="input w-full text-sm">
          <option value="none">Не переносить</option>
          <option value="shift_earlier">На пятницу (раньше)</option>
          <option value="shift_later">На понедельник (позже)</option>
        </select>
      </label>
      <label className="flex items-end gap-2 text-xs">
        <input name="includesTaxes" type="checkbox" defaultChecked={includesTaxes} className="h-4 w-4" />
        <span className="font-medium text-slate-600 dark:text-slate-300">Бюджет включает налоги/взносы</span>
      </label>
      <div className="flex items-end">
        <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200">
          Сохранить настройки
        </button>
      </div>
    </form>
  );
}
