// Pure advance-tranche math (STAGE 9). No DB. Shared by the money roll-up (aggregate.ts)
// and the tranche service so there is ONE definition of paid/remaining/status. Money =
// integer kopeks.

export type TrancheLike = { amountKopeks: number; status: string };
export type AdvanceLike = { amountKopeks: number; status: string; approvedAmountKopeks?: number | null };

/**
 * Actually-paid amount of an advance = Σ ACTIVE (non-reversed) tranches. Transition-safe:
 * a legacy paid advance with NO tranches yet folds its single `amountKopeks`; an approved
 * (but not yet paid) advance with no tranches folds 0 — approved ≠ paid (spec §13).
 */
export function advancePaidKopeks(advance: AdvanceLike, tranches: TrancheLike[]): number {
  if (tranches.length > 0) return tranches.filter((t) => t.status === "paid").reduce((s, t) => s + t.amountKopeks, 0);
  return advance.status === "paid" ? advance.amountKopeks : 0;
}

/** Approved amount (falls back to the legacy single amount when not set). */
export function advanceApprovedKopeks(advance: AdvanceLike): number {
  return advance.approvedAmountKopeks ?? advance.amountKopeks;
}

/** Remaining still payable within the approved amount. */
export function advanceRemainingKopeks(approvedKopeks: number, paidKopeks: number): number {
  return Math.max(0, approvedKopeks - paidKopeks);
}

/** True if a new tranche of `newKopeks` would exceed the approved amount. */
export function trancheExceedsApproved(approvedKopeks: number, activePaidKopeks: number, newKopeks: number): boolean {
  return newKopeks <= 0 || activePaidKopeks + newKopeks > approvedKopeks;
}

/**
 * User-facing status (spec §5) derived unambiguously from approved / paid / reversed /
 * approval state. Backend `advance.status` is preserved; this is a display mapping.
 */
export function deriveAdvanceUiStatus(
  advance: { status: string; approvedAmountKopeks?: number | null; amountKopeks: number; linkedPayrollCalculationId?: string | null },
  paidKopeks: number,
  hasReversed: boolean,
): string {
  if (advance.status === "canceled") return hasReversed ? "Сторнирован" : "Отменён";
  if (advance.status === "rejected") return "Отклонён";
  if (advance.status === "requested") return "Ожидает подтверждения";
  const approved = advanceApprovedKopeks(advance);
  if (paidKopeks <= 0) return advance.status === "approved" ? "Согласован" : "Черновик";
  if (hasReversed && paidKopeks < approved) return "Частично сторнирован";
  if (paidKopeks >= approved) return advance.linkedPayrollCalculationId ? "Учтён в периоде" : "Выплачен";
  return "Частично выплачен";
}
