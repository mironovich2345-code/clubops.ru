// Pure "фактический остаток" (physical cash) calculation for the managerial cash
// contour. This is SEPARATE from the confirmed-only CashWallet/CashMovement ledger
// and from profit analytics: here a PENDING operation already moves the balance,
// because the money has physically left / entered the club. No I/O, no secrets,
// fully deterministic and testable. Integer kopeks throughout.
//
// Rules:
//   Остаток ООО = opening + OFD cash ООО − collections(pending|approved)
//                 − withdrawals ООО→ИП (pending|approved)
//   Остаток ИП  = opening + OFD cash ИП + withdrawals ООО→ИП (pending|approved)
//                 + other income − ИП expenses (pending + approved)
// draft / rejected / cancelled are NEVER counted. Approval does not move the
// balance a second time (a pending op already counted stays counted once approved).

// --- Status constants ------------------------------------------------------
export const COLLECTION_STATUS = {
  DRAFT: "draft",
  PENDING: "pending_accountant_review",
  APPROVED: "approved",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
} as const;

export const WITHDRAWAL_STATUS = {
  DRAFT: "draft",
  PENDING: "pending_review",
  APPROVED: "approved",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
} as const;

// Statuses that count toward the fact balance for collections/withdrawals.
export const COLLECTION_FACT_STATUSES: readonly string[] = [COLLECTION_STATUS.PENDING, COLLECTION_STATUS.APPROVED];
export const WITHDRAWAL_FACT_STATUSES: readonly string[] = [WITHDRAWAL_STATUS.PENDING, WITHDRAWAL_STATUS.APPROVED];

// ИП cash-expense statuses. "Money physically left the till" the moment the expense
// is submitted for review, so every non-draft/non-terminal status reduces the fact
// balance. Profit/budget analytics keep their own stricter "realized" set (verified/
// confirmed) — we do NOT change that; the two views are intentionally separate.
export const IP_EXPENSE_PENDING_STATUSES: readonly string[] = [
  "submitted",
  "pending_regional_budget_approval",
  "pending_owner_budget_approval",
  "pending_accountant_verification",
  "needs_correction",
  "waiting_budget_approval", // legacy v1 pending
];
export const IP_EXPENSE_APPROVED_STATUSES: readonly string[] = ["verified", "confirmed"];

const sum = (xs: { amountKopeks: number }[]) => xs.reduce((a, x) => a + (x.amountKopeks || 0), 0);
const withStatus = (xs: { status: string; amountKopeks: number }[], allowed: readonly string[]) =>
  xs.filter((x) => allowed.includes(x.status));

// --- Inputs / outputs ------------------------------------------------------
export type EntityType = "ooo" | "ip";

export type OfdCashRow = {
  legalEntityType: EntityType | null;
  date: string; // "YYYY-MM-DD"
  incomeCashKopeks: number;
  returnCashKopeks: number;
};
export type StatusAmount = { status: string; amountKopeks: number };

export type CashBalancesInput = {
  oooOpeningKopeks: number;
  ipOpeningKopeks: number;
  ofdRows: OfdCashRow[];
  yesterday: string; // "YYYY-MM-DD"
  collections: StatusAmount[]; // ООО collections (инкассация)
  withdrawals: StatusAmount[]; // ООО→ИП (изъятие)
  ipExpenses: StatusAmount[]; // наличные расходы ИП
  ipOtherIncomeKopeks?: number; // confirmed «Иное» (0 if none)
};

export type CashBalances = {
  // ИП
  cashIpOpening: number;
  cashIpOfdIncome: number;
  cashIpOfdYesterday: number;
  cashIpWithdrawalsFromOoo: number;
  cashIpOtherIncome: number;
  cashIpPendingExpenses: number;
  cashIpApprovedExpenses: number;
  cashIpFactBalance: number;
  // ООО
  cashOooOpening: number;
  cashOooOfdIncome: number;
  cashOooOfdYesterday: number;
  cashOooPendingCollections: number;
  cashOooApprovedCollections: number;
  cashOooPendingWithdrawalsToIp: number;
  cashOooApprovedWithdrawalsToIp: number;
  cashOooFactBalance: number;
};

function ofdCashNet(rows: OfdCashRow[], type: EntityType): number {
  return rows.filter((r) => r.legalEntityType === type).reduce((a, r) => a + (r.incomeCashKopeks || 0) - (r.returnCashKopeks || 0), 0);
}
function ofdCashNetOnDay(rows: OfdCashRow[], type: EntityType, day: string): number {
  return rows.filter((r) => r.legalEntityType === type && r.date === day).reduce((a, r) => a + (r.incomeCashKopeks || 0) - (r.returnCashKopeks || 0), 0);
}

/** Pure fact-balance calculation for one club's ООО and ИП cash. */
export function calculateCashBalances(input: CashBalancesInput): CashBalances {
  const cashIpOpening = input.ipOpeningKopeks || 0;
  const cashIpOfdIncome = ofdCashNet(input.ofdRows, "ip");
  const cashIpOfdYesterday = ofdCashNetOnDay(input.ofdRows, "ip", input.yesterday);
  const cashIpWithdrawalsFromOoo = sum(withStatus(input.withdrawals, WITHDRAWAL_FACT_STATUSES));
  const cashIpOtherIncome = input.ipOtherIncomeKopeks || 0;
  const cashIpPendingExpenses = sum(withStatus(input.ipExpenses, IP_EXPENSE_PENDING_STATUSES));
  const cashIpApprovedExpenses = sum(withStatus(input.ipExpenses, IP_EXPENSE_APPROVED_STATUSES));
  const cashIpFactBalance =
    cashIpOpening + cashIpOfdIncome + cashIpWithdrawalsFromOoo + cashIpOtherIncome - cashIpPendingExpenses - cashIpApprovedExpenses;

  const cashOooOpening = input.oooOpeningKopeks || 0;
  const cashOooOfdIncome = ofdCashNet(input.ofdRows, "ooo");
  const cashOooOfdYesterday = ofdCashNetOnDay(input.ofdRows, "ooo", input.yesterday);
  const cashOooPendingCollections = sum(withStatus(input.collections, [COLLECTION_STATUS.PENDING]));
  const cashOooApprovedCollections = sum(withStatus(input.collections, [COLLECTION_STATUS.APPROVED]));
  const cashOooPendingWithdrawalsToIp = sum(withStatus(input.withdrawals, [WITHDRAWAL_STATUS.PENDING]));
  const cashOooApprovedWithdrawalsToIp = sum(withStatus(input.withdrawals, [WITHDRAWAL_STATUS.APPROVED]));
  const cashOooFactBalance =
    cashOooOpening +
    cashOooOfdIncome -
    cashOooPendingCollections -
    cashOooApprovedCollections -
    cashOooPendingWithdrawalsToIp -
    cashOooApprovedWithdrawalsToIp;

  return {
    cashIpOpening,
    cashIpOfdIncome,
    cashIpOfdYesterday,
    cashIpWithdrawalsFromOoo,
    cashIpOtherIncome,
    cashIpPendingExpenses,
    cashIpApprovedExpenses,
    cashIpFactBalance,
    cashOooOpening,
    cashOooOfdIncome,
    cashOooOfdYesterday,
    cashOooPendingCollections,
    cashOooApprovedCollections,
    cashOooPendingWithdrawalsToIp,
    cashOooApprovedWithdrawalsToIp,
    cashOooFactBalance,
  };
}
