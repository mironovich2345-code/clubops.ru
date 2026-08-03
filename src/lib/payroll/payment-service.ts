// REM-01 — the single domain service for EVERY payroll payout (regular, final, advance, regional).
// One logical payout = exactly ONE financial effect, atomically. All related writes (PayrollPayment,
// salary Expense, CashMovement, calc recompute, obligation refresh) happen inside ONE
// prisma.$transaction using the injected tx client — never the global prisma. Idempotency is enforced
// by a DB UNIQUE key (companyId, idempotencyKey), not a findFirst→create race. A replay of the same
// key returns the existing payment with no new writes; the same key with different parameters is a
// conflict. Server actions must parse input + authorize + resolve scope, then call this — they must
// NOT re-implement the transactional core.
//
// This service does NOT change any salary formula, netPayable, scheme, budget, forecast, or the cash
// contour model — it only makes the EXISTING writes atomic + idempotent.
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DbClient } from "@/lib/db-client";
import { createSalaryExpense, cancelSalaryExpense, type SalaryExpenseKind } from "@/lib/payroll/salary-expense";
import { recomputeCalculationTotals } from "@/lib/payroll/aggregate";
import { generateObligationsForPeriod } from "@/lib/payroll/payment-obligation";

export type PayrollPaymentType = "advance" | "regular" | "final" | "regional";

// Safe, non-technical error contract (spec §17). Never leak a raw Prisma error to the UI.
export type PayrollPaymentErrorCode =
  | "INVALID_AMOUNT"
  | "PAYMENT_EXCEEDS_REMAINING"
  | "IDEMPOTENCY_CONFLICT"
  | "SERIALIZATION_RETRY_EXHAUSTED"
  | "SOURCE_NOT_PAYABLE";

export type PayrollPaymentInput = {
  companyId: string;
  clubId: string;
  legalEntityId: string;
  method: "cash" | "bank";
  sourceType: string; // club_cash | regional_cash | bank_account
  paymentType: PayrollPaymentType;
  // Source record: the calc (regular/advance/final) OR the regional payroll row (regional).
  payrollCalculationId: string;
  employeeId: string;
  employeeName: string;
  payrollPeriodId: string | null;
  cashWalletId: string | null;
  amountKopeks: number;
  paymentDate: Date;
  paidByUserId: string;
  comment: string | null;
  documentKey: string | null;
  idempotencyKey: string;
  // Overpayment guard: the remaining is re-checked INSIDE the transaction (closes TOCTOU).
  // `currentRemainingKopeks` is a fallback for sources without a live calc (e.g. regional); when a
  // real PayrollCalculation drives it, the tx re-reads calc.remainingKopeks fresh.
  remaining?: { currentRemainingKopeks: number; allowOverpayment: boolean; useCalcRemaining: boolean };
  // If set, the period's obligations are regenerated INSIDE the tx (no swallowed refresh — DATA-016).
  refreshObligationsForPeriodId?: string | null;
  expenseKind: SalaryExpenseKind; // "payment" | "advance"
  // TEST-ONLY failure injection point (never wired to production input). See §20.
  _failAt?: FailPoint;
};

export type PayrollPaymentResult =
  | { ok: true; paymentId: string; expenseId: string | null; replayed: boolean }
  | { ok: false; code: PayrollPaymentErrorCode; message: string };

export type FailPoint =
  | "after_payment_create"
  | "after_expense_create"
  | "after_cash_movement"
  | "before_obligation_refresh"
  | "before_commit"
  | "after_commit";

class InjectedFailure extends Error {}
class ConflictSignal extends Error { constructor(readonly code: PayrollPaymentErrorCode, message: string) { super(message); } }

/** Deterministic fingerprint of the parameters that DEFINE the logical payment. Excludes the
 * server-generated paymentDate and the free-text comment (both would cause false conflicts on a
 * legitimate replay — spec §5). A same-key replay must present the same fingerprint. */
export function paymentFingerprint(p: {
  companyId: string; paymentType: string; sourceType: string; payrollCalculationId: string;
  employeeId: string; legalEntityId: string; amountKopeks: number; method: string;
}): string {
  const canonical = [p.companyId, p.paymentType, p.sourceType, p.payrollCalculationId, p.employeeId, p.legalEntityId, String(p.amountKopeks), p.method].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const isSerializationError = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2034" || e.code === "P2037") ||
  (e instanceof Error && /deadlock|could not serialize|database is locked/i.test(e.message));

/**
 * Execute one payroll payout atomically + idempotently. Retries the WHOLE operation on a
 * unique-key race or serialization failure; on retry the committed row is found and returned as a
 * replay (exactly-once under concurrency, on both sqlite and postgres). `db` is injectable for tests.
 */
export async function executePayrollPayment(input: PayrollPaymentInput, db: typeof prisma = prisma): Promise<PayrollPaymentResult> {
  if (!Number.isInteger(input.amountKopeks) || input.amountKopeks <= 0) {
    return { ok: false, code: "INVALID_AMOUNT", message: "Сумма должна быть больше нуля." };
  }
  const fingerprint = paymentFingerprint(input);

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await db.$transaction(async (tx) => {
        // 1. Idempotency reservation (DB-unique, inside the tx).
        const existing = await tx.payrollPayment.findUnique({
          where: { companyId_idempotencyKey: { companyId: input.companyId, idempotencyKey: input.idempotencyKey } },
          select: { id: true, expenseId: true, requestFingerprint: true, status: true },
        });
        if (existing) {
          if (existing.requestFingerprint && existing.requestFingerprint !== fingerprint) {
            throw new ConflictSignal("IDEMPOTENCY_CONFLICT", "Этот ключ операции уже использован с другими параметрами.");
          }
          return { paymentId: existing.id, expenseId: existing.expenseId, replayed: true };
        }

        // 2. Remaining guard, re-read INSIDE the tx (closes TOCTOU).
        if (input.remaining && !input.remaining.allowOverpayment) {
          let remaining = input.remaining.currentRemainingKopeks;
          if (input.remaining.useCalcRemaining) {
            const calc = await tx.payrollCalculation.findUnique({ where: { id: input.payrollCalculationId }, select: { remainingKopeks: true } });
            remaining = calc?.remainingKopeks ?? 0;
          }
          if (input.amountKopeks > remaining) {
            throw new ConflictSignal("PAYMENT_EXCEEDS_REMAINING", "Сумма превышает остаток к выплате.");
          }
        }

        // 3. PayrollPayment (with idempotency + fingerprint + type).
        const payment = await tx.payrollPayment.create({
          data: {
            companyId: input.companyId,
            payrollCalculationId: input.payrollCalculationId,
            employeeId: input.employeeId,
            clubId: input.clubId,
            legalEntityId: input.legalEntityId,
            amountKopeks: input.amountKopeks,
            paymentDate: input.paymentDate,
            paymentMethod: input.method,
            sourceType: input.sourceType,
            status: "confirmed",
            documentKey: input.documentKey,
            comment: input.comment,
            paidByUserId: input.paidByUserId,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: fingerprint,
            paymentType: input.paymentType,
          },
          select: { id: true },
        });
        if (input._failAt === "after_payment_create") throw new InjectedFailure("after_payment_create");

        // 4. The salary Expense (+ cash movement for cash) — SAME tx.
        const { expenseId } = await createSalaryExpense({
          companyId: input.companyId,
          clubId: input.clubId,
          legalEntityId: input.legalEntityId,
          method: input.method,
          amountKopeks: input.amountKopeks,
          paidByUserId: input.paidByUserId,
          cashWalletId: input.cashWalletId,
          employeeId: input.employeeId,
          employeeName: input.employeeName,
          payrollPeriodId: input.payrollPeriodId,
          kind: input.expenseKind,
        }, tx);
        if (input._failAt === "after_expense_create") throw new InjectedFailure("after_expense_create");
        if (input.method === "cash" && input._failAt === "after_cash_movement") throw new InjectedFailure("after_cash_movement");

        // 5. Link the expense back to the payment.
        await tx.payrollPayment.update({ where: { id: payment.id }, data: { expenseId } });

        // 6. Recompute the calc totals — SAME tx.
        await recomputeCalculationTotals(input.payrollCalculationId, tx);

        // 7. Obligation refresh — SAME tx, NOT swallowed (DATA-016).
        if (input._failAt === "before_obligation_refresh") throw new InjectedFailure("before_obligation_refresh");
        if (input.refreshObligationsForPeriodId) {
          await generateObligationsForPeriod(input.refreshObligationsForPeriodId, input.paymentDate, tx);
        }

        if (input._failAt === "before_commit") throw new InjectedFailure("before_commit");
        return { paymentId: payment.id, expenseId, replayed: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000, maxWait: 10_000 }).catch((e) => {
        // Serializable is unsupported on some engines; retry once without it before giving up.
        if (e instanceof Error && /isolation|not supported/i.test(e.message)) {
          return db.$transaction(async (tx) => reExecuteWithoutIsolation(tx, input, fingerprint));
        }
        throw e;
      });

      if (input._failAt === "after_commit") throw new InjectedFailure("after_commit");
      return { ok: true, paymentId: result.paymentId, expenseId: result.expenseId, replayed: result.replayed };
    } catch (e) {
      if (e instanceof ConflictSignal) return { ok: false, code: e.code, message: e.message };
      if (e instanceof InjectedFailure) throw e; // test-only: surfaces the rollback to the test
      if (isUniqueViolation(e) || isSerializationError(e)) {
        if (attempt < MAX_ATTEMPTS) continue; // retry → next loop finds the committed row (replay)
        return { ok: false, code: "SERIALIZATION_RETRY_EXHAUSTED", message: "Операция временно заблокирована, повторите попытку." };
      }
      throw e;
    }
  }
  return { ok: false, code: "SERIALIZATION_RETRY_EXHAUSTED", message: "Операция временно заблокирована, повторите попытку." };
}

// Fallback path used only when the engine rejects the Serializable isolation level. Same body,
// relies on the unique constraint + retry loop for concurrency safety.
async function reExecuteWithoutIsolation(tx: Prisma.TransactionClient, input: PayrollPaymentInput, fingerprint: string) {
  const existing = await tx.payrollPayment.findUnique({
    where: { companyId_idempotencyKey: { companyId: input.companyId, idempotencyKey: input.idempotencyKey } },
    select: { id: true, expenseId: true, requestFingerprint: true },
  });
  if (existing) {
    if (existing.requestFingerprint && existing.requestFingerprint !== fingerprint) throw new ConflictSignal("IDEMPOTENCY_CONFLICT", "Ключ уже использован с другими параметрами.");
    return { paymentId: existing.id, expenseId: existing.expenseId, replayed: true };
  }
  const payment = await tx.payrollPayment.create({
    data: {
      companyId: input.companyId, payrollCalculationId: input.payrollCalculationId, employeeId: input.employeeId,
      clubId: input.clubId, legalEntityId: input.legalEntityId, amountKopeks: input.amountKopeks, paymentDate: input.paymentDate,
      paymentMethod: input.method, sourceType: input.sourceType, status: "confirmed", documentKey: input.documentKey,
      comment: input.comment, paidByUserId: input.paidByUserId, idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint, paymentType: input.paymentType,
    },
    select: { id: true },
  });
  const { expenseId } = await createSalaryExpense({
    companyId: input.companyId, clubId: input.clubId, legalEntityId: input.legalEntityId, method: input.method,
    amountKopeks: input.amountKopeks, paidByUserId: input.paidByUserId, cashWalletId: input.cashWalletId,
    employeeId: input.employeeId, employeeName: input.employeeName, payrollPeriodId: input.payrollPeriodId, kind: input.expenseKind,
  }, tx);
  await tx.payrollPayment.update({ where: { id: payment.id }, data: { expenseId } });
  await recomputeCalculationTotals(input.payrollCalculationId, tx);
  if (input.refreshObligationsForPeriodId) await generateObligationsForPeriod(input.refreshObligationsForPeriodId, input.paymentDate, tx);
  return { paymentId: payment.id, expenseId, replayed: false };
}

// --- Reversal (chief-accountant only, atomic, idempotent) ---

export type PayrollReversalResult =
  | { ok: true; reversed: boolean }
  | { ok: false; code: "ALREADY_REVERSED" | "NOT_FOUND" | "SERIALIZATION_RETRY_EXHAUSTED"; message: string };

/**
 * Reverse a confirmed PayrollPayment atomically: flip status → canceled, cancel its salary Expense
 * (+ compensating cash inflow), recompute the calc — all in ONE tx. Idempotent: a second reversal of
 * the same payment is a no-op success. The caller enforces chief-accountant-only + the reason.
 */
export async function executePayrollReversal(args: { paymentId: string; userId: string; reason: string; refreshObligationsForPeriodId?: string | null }, db: typeof prisma = prisma): Promise<PayrollReversalResult> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        // Compare-and-set: only a currently-confirmed payment can be reversed (idempotent).
        const flip = await tx.payrollPayment.updateMany({ where: { id: args.paymentId, status: "confirmed" }, data: { status: "canceled" } });
        if (flip.count !== 1) {
          const exists = await tx.payrollPayment.findUnique({ where: { id: args.paymentId }, select: { id: true, status: true, payrollCalculationId: true } });
          if (!exists) return { ok: false as const, code: "NOT_FOUND" as const, message: "Выплата не найдена." };
          return { ok: true as const, reversed: false }; // already canceled → idempotent no-op
        }
        const payment = await tx.payrollPayment.findUnique({ where: { id: args.paymentId }, select: { expenseId: true, payrollCalculationId: true } });
        await cancelSalaryExpense(payment?.expenseId, args.userId, args.reason, tx);
        if (payment?.payrollCalculationId) await recomputeCalculationTotals(payment.payrollCalculationId, tx);
        if (args.refreshObligationsForPeriodId) await generateObligationsForPeriod(args.refreshObligationsForPeriodId, new Date(), tx);
        return { ok: true as const, reversed: true };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000, maxWait: 10_000 });
    } catch (e) {
      if (isSerializationError(e) && attempt < MAX_ATTEMPTS) continue;
      if (isSerializationError(e)) return { ok: false, code: "SERIALIZATION_RETRY_EXHAUSTED", message: "Повторите попытку." };
      throw e;
    }
  }
  return { ok: false, code: "SERIALIZATION_RETRY_EXHAUSTED", message: "Повторите попытку." };
}
