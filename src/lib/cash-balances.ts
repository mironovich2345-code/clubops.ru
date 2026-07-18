// Pure "фактический остаток" (physical cash) calculation for the managerial cash
// contour. SEPARATE from the confirmed-only CashWallet/CashMovement ledger and from
// profit analytics: here a PENDING operation already moves the balance, because the
// money has physically left / entered the club. No I/O, no secrets, deterministic.
// Integer kopeks throughout.
//
// The fact balance is measured FROM THE LATEST OPENING/CONTROL CHECKPOINT (a
// BalanceSnapshot), per legal entity: only OFD cash and operations dated strictly
// AFTER that checkpoint count. Without a checkpoint the balance is a "расчётный
// остаток от 0 ₽" and the UI must say so.
//
// Остаток ООО = opening ООО + OFD cash ООО (после чек-поинта) − collections
//               (pending|approved) − withdrawals ООО→ИП (pending|approved)
// Остаток ИП  = opening ИП + OFD cash ИП (после чек-поинта) + withdrawals ООО→ИП
//               (pending|approved) + «Иное» − ИП expenses (pending + approved)
// draft / rejected / cancelled are NEVER counted. Approval does not move the balance
// a second time; reject/cancel removes the operation's effect.

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

// --- Inputs / outputs ------------------------------------------------------
export type EntityType = "ooo" | "ip";
export type OfdCashRow = { legalEntityType: EntityType | null; date: string; incomeCashKopeks: number; returnCashKopeks: number };
export type DatedStatusAmount = { status: string; amountKopeks: number; date: string };
export type DatedAmount = { amountKopeks: number; date: string };

export type CashBalancesInput = {
  oooOpeningKopeks: number;
  ipOpeningKopeks: number;
  oooOpeningDate: string | null; // "YYYY-MM-DD" of the latest ООО checkpoint, or null
  ipOpeningDate: string | null;
  ofdRows: OfdCashRow[];
  today: string; // "YYYY-MM-DD"
  yesterday: string;
  monthPrefix: string; // "YYYY-MM"
  collections: DatedStatusAmount[]; // ООО collections (инкассация)
  withdrawals: DatedStatusAmount[]; // ООО→ИП (изъятие)
  ipExpenses: DatedStatusAmount[]; // наличные расходы ИП
  ipOtherIncome?: DatedAmount[]; // confirmed «Иное»
};

export type CashBalances = {
  // ИП
  cashIpOpening: number;
  cashIpOpeningDate: string | null;
  cashIpOpeningSet: boolean;
  cashIpOfdSinceOpening: number; // used in the fact balance (after the checkpoint)
  cashIpOfdYesterday: number;
  cashIpOfdToday: number;
  cashIpOfdMonth: number;
  cashIpWithdrawalsFromOoo: number;
  cashIpOtherIncome: number;
  cashIpPendingExpenses: number;
  cashIpApprovedExpenses: number;
  cashIpFactBalance: number;
  // ООО
  cashOooOpening: number;
  cashOooOpeningDate: string | null;
  cashOooOpeningSet: boolean;
  cashOooOfdSinceOpening: number;
  cashOooOfdYesterday: number;
  cashOooOfdToday: number;
  cashOooOfdMonth: number;
  cashOooPendingCollections: number;
  cashOooApprovedCollections: number;
  cashOooPendingWithdrawalsToIp: number;
  cashOooApprovedWithdrawalsToIp: number;
  cashOooFactBalance: number;
};

// A movement dated strictly AFTER the checkpoint counts (the checkpoint captures
// everything up to and including its date). Null checkpoint → count everything.
const after = (date: string, since: string | null) => (since === null ? true : date > since);
const sum = (xs: { amountKopeks: number }[]) => xs.reduce((a, x) => a + (x.amountKopeks || 0), 0);
const pick = <T extends { status: string }>(xs: T[], allowed: readonly string[]) => xs.filter((x) => allowed.includes(x.status));

function ofdCashNet(rows: OfdCashRow[], type: EntityType, keep: (date: string) => boolean): number {
  return rows.filter((r) => r.legalEntityType === type && keep(r.date)).reduce((a, r) => a + (r.incomeCashKopeks || 0) - (r.returnCashKopeks || 0), 0);
}

/** Pure fact-balance calculation for one club's ООО and ИП cash. */
export function calculateCashBalances(input: CashBalancesInput): CashBalances {
  const other = input.ipOtherIncome ?? [];

  // --- ИП ---
  const cashIpOpening = input.ipOpeningKopeks || 0;
  const ipSince = input.ipOpeningDate;
  const cashIpOfdSinceOpening = ofdCashNet(input.ofdRows, "ip", (d) => after(d, ipSince));
  const cashIpOfdYesterday = ofdCashNet(input.ofdRows, "ip", (d) => d === input.yesterday);
  const cashIpOfdToday = ofdCashNet(input.ofdRows, "ip", (d) => d === input.today);
  const cashIpOfdMonth = ofdCashNet(input.ofdRows, "ip", (d) => d.startsWith(input.monthPrefix));
  const cashIpWithdrawalsFromOoo = sum(pick(input.withdrawals.filter((w) => after(w.date, ipSince)), WITHDRAWAL_FACT_STATUSES));
  const cashIpOtherIncome = sum(other.filter((o) => after(o.date, ipSince)));
  const cashIpPendingExpenses = sum(pick(input.ipExpenses.filter((e) => after(e.date, ipSince)), IP_EXPENSE_PENDING_STATUSES));
  const cashIpApprovedExpenses = sum(pick(input.ipExpenses.filter((e) => after(e.date, ipSince)), IP_EXPENSE_APPROVED_STATUSES));
  const cashIpFactBalance = cashIpOpening + cashIpOfdSinceOpening + cashIpWithdrawalsFromOoo + cashIpOtherIncome - cashIpPendingExpenses - cashIpApprovedExpenses;

  // --- ООО ---
  const cashOooOpening = input.oooOpeningKopeks || 0;
  const oooSince = input.oooOpeningDate;
  const cashOooOfdSinceOpening = ofdCashNet(input.ofdRows, "ooo", (d) => after(d, oooSince));
  const cashOooOfdYesterday = ofdCashNet(input.ofdRows, "ooo", (d) => d === input.yesterday);
  const cashOooOfdToday = ofdCashNet(input.ofdRows, "ooo", (d) => d === input.today);
  const cashOooOfdMonth = ofdCashNet(input.ofdRows, "ooo", (d) => d.startsWith(input.monthPrefix));
  const oooCollections = input.collections.filter((c) => after(c.date, oooSince));
  const oooWithdrawals = input.withdrawals.filter((w) => after(w.date, oooSince));
  const cashOooPendingCollections = sum(pick(oooCollections, [COLLECTION_STATUS.PENDING]));
  const cashOooApprovedCollections = sum(pick(oooCollections, [COLLECTION_STATUS.APPROVED]));
  const cashOooPendingWithdrawalsToIp = sum(pick(oooWithdrawals, [WITHDRAWAL_STATUS.PENDING]));
  const cashOooApprovedWithdrawalsToIp = sum(pick(oooWithdrawals, [WITHDRAWAL_STATUS.APPROVED]));
  const cashOooFactBalance =
    cashOooOpening + cashOooOfdSinceOpening - cashOooPendingCollections - cashOooApprovedCollections - cashOooPendingWithdrawalsToIp - cashOooApprovedWithdrawalsToIp;

  return {
    cashIpOpening,
    cashIpOpeningDate: input.ipOpeningDate,
    cashIpOpeningSet: input.ipOpeningDate !== null,
    cashIpOfdSinceOpening,
    cashIpOfdYesterday,
    cashIpOfdToday,
    cashIpOfdMonth,
    cashIpWithdrawalsFromOoo,
    cashIpOtherIncome,
    cashIpPendingExpenses,
    cashIpApprovedExpenses,
    cashIpFactBalance,
    cashOooOpening,
    cashOooOpeningDate: input.oooOpeningDate,
    cashOooOpeningSet: input.oooOpeningDate !== null,
    cashOooOfdSinceOpening,
    cashOooOfdYesterday,
    cashOooOfdToday,
    cashOooOfdMonth,
    cashOooPendingCollections,
    cashOooApprovedCollections,
    cashOooPendingWithdrawalsToIp,
    cashOooApprovedWithdrawalsToIp,
    cashOooFactBalance,
  };
}
