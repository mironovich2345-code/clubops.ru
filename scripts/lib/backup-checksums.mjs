// REM-03 — critical row counts + money aggregates for the manifest and restore comparison. These are
// IDENTITY checks (does the restored DB match the backup?), NOT an accounting source of truth. Takes any
// PrismaClient (postgres at backup, sqlite in tests). Read-only.
const COUNT_TABLES = [
  "company", "club", "legalEntity", "user", "companyUserAccess", "invoice", "invoicePayment", "expense",
  "refund", "balanceSnapshot", "cashCollection", "cashWithdrawal", "cashOtherIncome", "cashRegionalTransfer",
  "cashMovement", "payrollPeriod", "payrollCalculation", "payrollPayment", "payrollPaymentObligation",
  "budget", "auditLog",
];

// [model, whereOrNull, sumField]
const MONEY_SUMS = [
  ["invoice", null, "amountKopeks"],
  ["invoicePayment", { status: "confirmed" }, "amountKopeks"],
  ["expense", { status: "confirmed" }, "amountKopeks"],
  ["refund", { status: "paid" }, "amountKopeks"],
  ["payrollCalculation", null, "netPayableKopeks"],
  ["payrollCalculation", null, "paidKopeks"],
  ["payrollPayment", { status: "confirmed" }, "amountKopeks"],
  ["balanceSnapshot", { status: "active" }, "actualBalanceKopeks"],
  ["budget", null, "limitAmountKopeks"],
];

export async function computeBackupChecksums(prisma) {
  const criticalRowCounts = {};
  for (const t of COUNT_TABLES) { try { criticalRowCounts[t] = await prisma[t].count(); } catch { criticalRowCounts[t] = null; } }
  const criticalMoneyChecksums = {};
  for (const [model, where, field] of MONEY_SUMS) {
    const key = `${model}.${field}${where ? `[${Object.entries(where).map(([k, v]) => `${k}=${v}`).join(",")}]` : ""}`;
    try {
      const agg = await prisma[model].aggregate({ ...(where ? { where } : {}), _sum: { [field]: true } });
      criticalMoneyChecksums[key] = agg._sum[field] ?? 0;
    } catch { criticalMoneyChecksums[key] = null; }
  }
  return { criticalRowCounts, criticalMoneyChecksums };
}

/** Compare two checksum sets (backup vs restored). Returns { match, mismatches[] }. */
export function compareChecksums(a, b) {
  const mismatches = [];
  for (const set of ["criticalRowCounts", "criticalMoneyChecksums"]) {
    const keys = new Set([...Object.keys(a[set] || {}), ...Object.keys(b[set] || {})]);
    for (const k of keys) if ((a[set]?.[k] ?? null) !== (b[set]?.[k] ?? null)) mismatches.push({ set, key: k, backup: a[set]?.[k] ?? null, restored: b[set]?.[k] ?? null });
  }
  return { match: mismatches.length === 0, mismatches };
}
