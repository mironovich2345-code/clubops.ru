// Payroll cash-ledger integration. A cash payout (advance or salary payment) reduces
// the club/regional cash wallet EXACTLY ONCE by writing a CashMovement OUTFLOW
// (fromWalletId set, positive kopeks) — the same immutable ledger the expenses use,
// never a parallel balance. Idempotency rides the CashMovement @@unique([sourceType,
// sourceId]). Cancellation posts a COMPENSATING INFLOW (confirmed rows are immutable),
// which restores the balance once. Bank payments do NOT touch a cash wallet.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MSTATUS } from "@/lib/cash-wallets";

export const PAYROLL_PAYMENT_SOURCE = "payroll_payment";
export const PAYROLL_PAYMENT_REVERSAL_SOURCE = "payroll_payment_reversal";
export const PAYROLL_ADVANCE_SOURCE = "payroll_advance";
export const PAYROLL_ADVANCE_REVERSAL_SOURCE = "payroll_advance_reversal";

const isUniqueClash = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** Pure: an advance may not exceed the amount earned to date (spec §4). */
export function advanceWithinEarned(amountKopeks: number, earnedToDateKopeks: number): boolean {
  return Number.isFinite(amountKopeks) && amountKopeks > 0 && amountKopeks <= earnedToDateKopeks;
}

type OutflowParams = {
  companyId: string;
  clubId: string;
  legalEntityId: string;
  walletId: string;
  amountKopeks: number;
  occurredAt: Date;
  sourceType: string;
  sourceId: string;
  userId: string;
  comment?: string | null;
};

/** Create a confirmed OUTFLOW movement (money leaves the wallet). Idempotent on
 * (sourceType, sourceId) — a retry returns the existing movement id, never a 2nd
 * deduction. Returns the movement id. */
export async function postCashOutflow(p: OutflowParams): Promise<string | null> {
  try {
    const mv = await prisma.cashMovement.create({
      data: {
        companyId: p.companyId,
        clubId: p.clubId,
        legalEntityId: p.legalEntityId,
        type: "payroll_payout",
        amountKopeks: p.amountKopeks,
        fromWalletId: p.walletId,
        toWalletId: null,
        status: MSTATUS.CONFIRMED,
        occurredAt: p.occurredAt,
        confirmedAt: new Date(),
        createdByUserId: p.userId,
        confirmedByUserId: p.userId,
        sourceType: p.sourceType,
        sourceId: p.sourceId,
        comment: p.comment ?? null,
      },
      select: { id: true },
    });
    return mv.id;
  } catch (e) {
    if (isUniqueClash(e)) {
      const existing = await prisma.cashMovement.findFirst({
        where: { sourceType: p.sourceType, sourceId: p.sourceId },
        select: { id: true },
      });
      return existing?.id ?? null;
    }
    throw e;
  }
}

/** Create a confirmed INFLOW movement (money enters the wallet) — used when an employee
 * repays a debt in cash. Idempotent on (sourceType, sourceId). */
export async function postCashInflow(p: OutflowParams): Promise<string | null> {
  try {
    const mv = await prisma.cashMovement.create({
      data: {
        companyId: p.companyId,
        clubId: p.clubId,
        legalEntityId: p.legalEntityId,
        type: "payroll_repayment",
        amountKopeks: p.amountKopeks,
        fromWalletId: null,
        toWalletId: p.walletId,
        status: MSTATUS.CONFIRMED,
        occurredAt: p.occurredAt,
        confirmedAt: new Date(),
        createdByUserId: p.userId,
        confirmedByUserId: p.userId,
        sourceType: p.sourceType,
        sourceId: p.sourceId,
        comment: p.comment ?? null,
      },
      select: { id: true },
    });
    return mv.id;
  } catch (e) {
    if (isUniqueClash(e)) {
      const existing = await prisma.cashMovement.findFirst({ where: { sourceType: p.sourceType, sourceId: p.sourceId }, select: { id: true } });
      return existing?.id ?? null;
    }
    throw e;
  }
}

type ReversalParams = {
  companyId: string;
  clubId: string;
  legalEntityId: string;
  walletId: string;
  amountKopeks: number;
  occurredAt: Date;
  reversalSourceType: string;
  sourceId: string;
  userId: string;
};

/** Restore the balance for a cancelled cash payout with a COMPENSATING INFLOW back
 * into the same wallet. Idempotent on the reversal (sourceType, sourceId). */
export async function reverseCashOutflow(p: ReversalParams): Promise<void> {
  try {
    await prisma.cashMovement.create({
      data: {
        companyId: p.companyId,
        clubId: p.clubId,
        legalEntityId: p.legalEntityId,
        type: "payroll_payout_reversal",
        amountKopeks: p.amountKopeks,
        fromWalletId: null,
        toWalletId: p.walletId,
        status: MSTATUS.CONFIRMED,
        occurredAt: p.occurredAt,
        confirmedAt: new Date(),
        createdByUserId: p.userId,
        confirmedByUserId: p.userId,
        sourceType: p.reversalSourceType,
        sourceId: p.sourceId,
      },
    });
  } catch (e) {
    if (!isUniqueClash(e)) throw e;
  }
}
