"use client";

import { approveBudgetChangeProposal, rejectBudgetChangeProposal } from "../proposal-actions";

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
