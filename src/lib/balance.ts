// Financial balance / cash-availability layer (Parts 5–6).
//
// A lightweight, reusable calculation layer on top of the existing payment
// obligations + confirmed-report cash. It answers: how much money is available,
// how much must be paid, will there be a cash gap, how much should remain — per
// legal-entity type (ООО / ИП). This is NOT an accounting system: balances come
// from existing sources (confirmed report cash for ООО) and are `null` when no
// real source exists (ИП today) — we never invent a bank balance.
//
// All functions are pure and integer-only: no NaN, no Infinity, graceful nulls.
import { calculateCashGap, calculateRequiredMoneyByDate } from "@/lib/payment-obligations";
import type { LegalEntityType } from "@/lib/legal-entities";

export type BalanceState = "ok" | "insufficient_data";
export type BalanceRisk = "low" | "high" | "unknown";

// Part 5 — per-entity balance snapshot (helper-based; no DB model required).
export type LegalEntityBalance = {
  legalEntityId: string | null; // null = aggregated by type for the scope
  legalEntityType: LegalEntityType; // "ooo" | "ip"
  currentBalanceKopeks: number | null; // null when no real cash source exists
  obligationsKopeks: number;
  projectedBalanceKopeks: number | null;
  calculatedAt: Date;
  state: BalanceState;
};

export type BalanceForecast = {
  currentBalanceKopeks: number | null;
  obligationsKopeks: number;
  projectedBalanceKopeks: number | null; // currentBalance − obligations
  cashGapKopeks: number | null; // deficit ≥ 0 (0 = no gap); null if unknown
  requiredAdditionalSalesKopeks: number | null; // = cash gap; null if unknown
  hasRisk: boolean;
  state: BalanceState;
};

/**
 * Part 6 — projected balance after the given obligations.
 * projectedBalance = currentCash − obligations. When currentCash is null
 * ("insufficient_data") every derived figure is null and risk is false.
 * Reuses calculateCashGap so there is a single source of cash-gap truth.
 */
export function calculateBalanceForecast(args: {
  currentCashKopeks: number | null;
  obligationsKopeks: number;
}): BalanceForecast {
  const gap = calculateCashGap({ currentCashKopeks: args.currentCashKopeks, obligationsKopeks: args.obligationsKopeks });
  if (gap.state === "insufficient_data") {
    return {
      currentBalanceKopeks: null,
      obligationsKopeks: args.obligationsKopeks,
      projectedBalanceKopeks: null,
      cashGapKopeks: null,
      requiredAdditionalSalesKopeks: null,
      hasRisk: false,
      state: "insufficient_data",
    };
  }
  return {
    currentBalanceKopeks: args.currentCashKopeks,
    obligationsKopeks: args.obligationsKopeks,
    projectedBalanceKopeks: gap.projectedBalanceKopeks,
    cashGapKopeks: gap.deficitKopeks,
    requiredAdditionalSalesKopeks: gap.deficitKopeks,
    hasRisk: gap.hasRisk,
    state: "ok",
  };
}

/**
 * Part 6 — money required by a target date: current cash vs obligations due up to
 * that date. Reuses calculateRequiredMoneyByDate (single source of truth).
 */
export function calculateRequiredCashByDate(args: {
  currentCashKopeks: number | null;
  obligationsUntilDateKopeks: number;
}): BalanceForecast {
  return calculateBalanceForecast({
    currentCashKopeks: args.currentCashKopeks,
    obligationsKopeks: args.obligationsUntilDateKopeks,
  });
}

/** Part 6 — cash gap by a target date (projected balance + deficit/risk). */
export function calculateCashGapByDate(args: {
  currentCashKopeks: number | null;
  obligationsUntilDateKopeks: number;
}): { projectedBalanceKopeks: number | null; cashGapKopeks: number | null; hasRisk: boolean; state: BalanceState } {
  const required = calculateRequiredMoneyByDate({
    currentCashKopeks: args.currentCashKopeks,
    obligationsUntilDateKopeks: args.obligationsUntilDateKopeks,
  });
  if (required.projectedBalanceKopeks === null) {
    return { projectedBalanceKopeks: null, cashGapKopeks: null, hasRisk: false, state: "insufficient_data" };
  }
  const hasRisk = required.projectedBalanceKopeks < 0;
  return {
    projectedBalanceKopeks: required.projectedBalanceKopeks,
    cashGapKopeks: hasRisk ? Math.abs(required.projectedBalanceKopeks) : 0,
    hasRisk,
    state: "ok",
  };
}

/** Risk level for a forecast: unknown (no data) / low (>=0) / high (deficit). */
export function balanceRiskLevel(forecast: BalanceForecast): BalanceRisk {
  if (forecast.state === "insufficient_data") return "unknown";
  return forecast.hasRisk ? "high" : "low";
}

// Per-legal-entity cash gap (Parts 2/4). ООО and ИП are computed independently
// and NEVER offset each other — an ИП surplus cannot cover an ООО deficit.
export type EntityCashGap = {
  type: LegalEntityType;
  currentBalanceKopeks: number | null;
  obligationsKopeks: number;
  projectedBalanceKopeks: number | null;
  risk: BalanceRisk;
};

function oneEntityGap(type: LegalEntityType, balanceKopeks: number | null, obligationsKopeks: number): EntityCashGap {
  const f = calculateBalanceForecast({ currentCashKopeks: balanceKopeks, obligationsKopeks });
  return { type, currentBalanceKopeks: balanceKopeks, obligationsKopeks, projectedBalanceKopeks: f.projectedBalanceKopeks, risk: balanceRiskLevel(f) };
}

/** Build the ООО and ИП cash gaps separately (no merging, ever). */
export function buildEntityCashGaps(args: {
  ooo: { balanceKopeks: number | null; obligationsKopeks: number };
  ip: { balanceKopeks: number | null; obligationsKopeks: number };
}): { ooo: EntityCashGap; ip: EntityCashGap } {
  return {
    ooo: oneEntityGap("ooo", args.ooo.balanceKopeks, args.ooo.obligationsKopeks),
    ip: oneEntityGap("ip", args.ip.balanceKopeks, args.ip.obligationsKopeks),
  };
}

export type MoneyRequiredResult = {
  projectedBalanceKopeks: number | null;
  additionalSalesRequiredKopeks: number | null; // = cash gap; 0 when no gap; null if unknown
  state: BalanceState;
};

/**
 * Part 5 — money required by a date: given the current balance and the
 * obligations due until that date, how much will remain and how much extra in
 * sales is needed to avoid a gap. Pure, finite, graceful null when balance is
 * unknown. Thin wrapper over the forecast (single source of truth).
 */
export function calculateMoneyRequiredByDate(args: {
  currentBalanceKopeks: number | null;
  obligationsUntilDateKopeks: number;
}): MoneyRequiredResult {
  const f = calculateBalanceForecast({ currentCashKopeks: args.currentBalanceKopeks, obligationsKopeks: args.obligationsUntilDateKopeks });
  return {
    projectedBalanceKopeks: f.projectedBalanceKopeks,
    additionalSalesRequiredKopeks: f.requiredAdditionalSalesKopeks,
    state: f.state,
  };
}

/**
 * Build per-type balance snapshots for the scope. `oooCashKopeks` comes from
 * confirmed report cash control; `ipCashKopeks` is null today (no ИП cash source
 * yet) and is shown as "нет данных" — never invented. `now` is passed in so the
 * function stays pure/testable.
 */
export function buildLegalEntityBalances(args: {
  oooCashKopeks: number | null;
  oooObligationsKopeks: number;
  ipCashKopeks: number | null;
  ipObligationsKopeks: number;
  now: Date;
}): LegalEntityBalance[] {
  const make = (type: LegalEntityType, cash: number | null, obligations: number): LegalEntityBalance => {
    const f = calculateBalanceForecast({ currentCashKopeks: cash, obligationsKopeks: obligations });
    return {
      legalEntityId: null,
      legalEntityType: type,
      currentBalanceKopeks: f.currentBalanceKopeks,
      obligationsKopeks: obligations,
      projectedBalanceKopeks: f.projectedBalanceKopeks,
      calculatedAt: args.now,
      state: f.state,
    };
  };
  return [
    make("ooo", args.oooCashKopeks, args.oooObligationsKopeks),
    make("ip", args.ipCashKopeks, args.ipObligationsKopeks),
  ];
}
