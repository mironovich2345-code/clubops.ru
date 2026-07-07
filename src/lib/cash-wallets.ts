// Centralized cash-wallet + movement service (server-only). A wallet balance is
// derived ONLY from CONFIRMED CashMovement rows — never from mutable manual
// fields. All money is integer kopeks. This is the single source of cash truth;
// page components must not compute balances from unrelated tables.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/access";

export const WALLET_CLUB = "club_cash";
export const WALLET_REGIONAL = "regional_cash";

export const MOVEMENT = {
  OPENING: "opening_balance",
  OFD_INCOME: "ofd_cash_income",
  OTHER_INCOME: "other_cash_income",
  TRANSFER: "internal_transfer",
  EXPENSE: "expense",
  REFUND: "cash_refund",
  ADJUSTMENT: "adjustment",
} as const;

export const MSTATUS = {
  DRAFT: "draft",
  PENDING: "pending_confirmation",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
} as const;

type Db = typeof prisma | Prisma.TransactionClient;

// --- Wallet resolution -----------------------------------------------------

/** The single active club_cash wallet for a Club + ИП, creating it if absent. */
export async function ensureClubCashWallet(companyId: string, clubId: string, legalEntityId: string, db: Db = prisma): Promise<string> {
  const existing = await db.cashWallet.findFirst({ where: { clubId, legalEntityId, type: WALLET_CLUB, isActive: true }, select: { id: true } });
  if (existing) return existing.id;
  const created = await db.cashWallet.create({ data: { companyId, clubId, legalEntityId, type: WALLET_CLUB, holderUserId: null } });
  return created.id;
}

/** The regional_cash wallet for a holder + Club + ИП, creating it if absent. */
export async function ensureRegionalCashWallet(companyId: string, clubId: string, legalEntityId: string, holderUserId: string, db: Db = prisma): Promise<string> {
  const existing = await db.cashWallet.findFirst({ where: { clubId, legalEntityId, type: WALLET_REGIONAL, holderUserId, isActive: true }, select: { id: true } });
  if (existing) return existing.id;
  const created = await db.cashWallet.create({ data: { companyId, clubId, legalEntityId, type: WALLET_REGIONAL, holderUserId } });
  return created.id;
}

export async function getClubWallet(clubId: string, legalEntityId: string): Promise<{ id: string } | null> {
  return prisma.cashWallet.findFirst({ where: { clubId, legalEntityId, type: WALLET_CLUB, isActive: true }, select: { id: true } });
}

// --- Balances (confirmed movements only) -----------------------------------

/** wallet balance = Σ(confirmed toWallet) − Σ(confirmed fromWallet). */
export async function walletBalanceKopeks(walletId: string, db: Db = prisma): Promise<number> {
  const [inc, out] = await Promise.all([
    db.cashMovement.aggregate({ where: { toWalletId: walletId, status: MSTATUS.CONFIRMED }, _sum: { amountKopeks: true } }),
    db.cashMovement.aggregate({ where: { fromWalletId: walletId, status: MSTATUS.CONFIRMED }, _sum: { amountKopeks: true } }),
  ]);
  return (inc._sum.amountKopeks ?? 0) - (out._sum.amountKopeks ?? 0);
}

export type ClubCashBreakdown = {
  clubWalletId: string | null;
  hasOpeningBalance: boolean;
  clubBalanceKopeks: number;
  regional: Array<{ walletId: string; holderUserId: string | null; balanceKopeks: number }>;
  regionalTotalKopeks: number;
  combinedKopeks: number;
  transferredToRegionalTotalKopeks: number; // manager aggregate (Club → regional)
};

/**
 * Full cash picture for a Club + ИП. Manager UI shows clubBalanceKopeks +
 * transferredToRegionalTotalKopeks; strategic/accounting UI shows the regional
 * breakdown and combined total. Internal transfers never change combinedKopeks.
 */
export async function getClubCashBreakdown(clubId: string, legalEntityId: string): Promise<ClubCashBreakdown> {
  const club = await getClubWallet(clubId, legalEntityId);
  const regionalWallets = await prisma.cashWallet.findMany({ where: { clubId, legalEntityId, type: WALLET_REGIONAL, isActive: true }, select: { id: true, holderUserId: true } });

  const clubBalanceKopeks = club ? await walletBalanceKopeks(club.id) : 0;
  const regional = await Promise.all(regionalWallets.map(async (w) => ({ walletId: w.id, holderUserId: w.holderUserId, balanceKopeks: await walletBalanceKopeks(w.id) })));
  const regionalTotalKopeks = regional.reduce((s, r) => s + r.balanceKopeks, 0);

  const hasOpeningBalance = club
    ? (await prisma.cashMovement.count({ where: { toWalletId: club.id, type: MOVEMENT.OPENING, status: MSTATUS.CONFIRMED } })) > 0
    : false;

  // Aggregate money moved from the Club wallet to regional wallets (confirmed).
  const transferredToRegional = club
    ? await prisma.cashMovement.aggregate({
        where: { fromWalletId: club.id, type: MOVEMENT.TRANSFER, status: MSTATUS.CONFIRMED, toWallet: { type: WALLET_REGIONAL } },
        _sum: { amountKopeks: true },
      })
    : { _sum: { amountKopeks: 0 } };

  return {
    clubWalletId: club?.id ?? null,
    hasOpeningBalance,
    clubBalanceKopeks,
    regional,
    regionalTotalKopeks,
    combinedKopeks: clubBalanceKopeks + regionalTotalKopeks,
    transferredToRegionalTotalKopeks: transferredToRegional._sum.amountKopeks ?? 0,
  };
}

// --- Movement creation (idempotent by sourceType+sourceId) -----------------

/** Try to create a movement; on unique (sourceType,sourceId) clash, no-op. */
async function createIdempotent(db: Db, data: Prisma.CashMovementUncheckedCreateInput): Promise<boolean> {
  try {
    await db.cashMovement.create({ data });
    return true;
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") return false; // already recorded
    throw e;
  }
}

/**
 * Record the CONFIRMED outgoing `expense` movement when an Expense is verified.
 * Idempotent per Expense (unique source) — never reduces cash twice. Resolves
 * the expense's wallet, creating the club_cash wallet if the expense predates
 * wallet assignment (defensive). Cancelled-before-verify creates no movement.
 */
export async function recordExpenseMovement(expense: {
  id: string; companyId: string; clubId: string; legalEntityId: string | null;
  amountKopeks: number; expenseDate: Date; cashWalletId: string | null;
}, db: Db = prisma): Promise<void> {
  if (!expense.legalEntityId || expense.amountKopeks <= 0) return;
  const walletId = expense.cashWalletId ?? (await ensureClubCashWallet(expense.companyId, expense.clubId, expense.legalEntityId, db));
  const created = await createIdempotent(db, {
    companyId: expense.companyId, clubId: expense.clubId, legalEntityId: expense.legalEntityId,
    type: MOVEMENT.EXPENSE, amountKopeks: expense.amountKopeks, fromWalletId: walletId, toWalletId: null,
    status: MSTATUS.CONFIRMED, occurredAt: expense.expenseDate, confirmedAt: new Date(),
    sourceType: "expense", sourceId: expense.id,
  });
  if (created) {
    await recordAudit({ action: "cash.expense_movement", entityType: "Expense", entityId: expense.id, companyId: expense.companyId, clubId: expense.clubId, metadata: { amountKopeks: expense.amountKopeks, walletId } });
  }
}

/** Set a one-time confirmed opening balance for a Club wallet. Idempotent. */
export async function setOpeningBalance(opts: {
  companyId: string; clubId: string; legalEntityId: string; amountKopeks: number; actorUserId: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isInteger(opts.amountKopeks) || opts.amountKopeks < 0) return { ok: false, error: "Начальный остаток должен быть неотрицательным." };
  const walletId = await ensureClubCashWallet(opts.companyId, opts.clubId, opts.legalEntityId);
  const created = await createIdempotent(prisma, {
    companyId: opts.companyId, clubId: opts.clubId, legalEntityId: opts.legalEntityId,
    type: MOVEMENT.OPENING, amountKopeks: opts.amountKopeks, toWalletId: walletId, fromWalletId: null,
    status: MSTATUS.CONFIRMED, occurredAt: new Date(), createdByUserId: opts.actorUserId, confirmedByUserId: opts.actorUserId, confirmedAt: new Date(),
    sourceType: "opening", sourceId: walletId,
  });
  if (created) {
    await recordAudit({ action: "cash.opening_balance_set", entityType: "CashWallet", entityId: walletId, companyId: opts.companyId, clubId: opts.clubId, userId: opts.actorUserId, metadata: { amountKopeks: opts.amountKopeks } });
    return { ok: true };
  }
  return { ok: false, error: "Начальный остаток уже задан." };
}

export type MovementResult = { ok: true; movementId: string } | { ok: false; error: string };

/**
 * Create a PENDING internal transfer between two wallets of the SAME Club + ИП.
 * Requires sufficient confirmed source balance. The receiving holder confirms it
 * later (confirmTransfer), which atomically debits source + credits target in one
 * confirmed row — the combined Club total never changes.
 */
export async function createInternalTransfer(opts: {
  companyId: string; clubId: string; legalEntityId: string;
  fromWalletId: string; toWalletId: string; amountKopeks: number; actorUserId: string; comment?: string | null;
}): Promise<MovementResult> {
  if (!Number.isInteger(opts.amountKopeks) || opts.amountKopeks <= 0) return { ok: false, error: "Сумма должна быть больше нуля." };
  if (opts.fromWalletId === opts.toWalletId) return { ok: false, error: "Кошельки совпадают." };
  const [from, to] = await Promise.all([
    prisma.cashWallet.findUnique({ where: { id: opts.fromWalletId }, select: { clubId: true, legalEntityId: true, isActive: true } }),
    prisma.cashWallet.findUnique({ where: { id: opts.toWalletId }, select: { clubId: true, legalEntityId: true, isActive: true } }),
  ]);
  // Both wallets must belong to the SAME Club + ИП (regional money never mixes).
  if (!from || !to || !from.isActive || !to.isActive) return { ok: false, error: "Кошелёк не найден." };
  if (from.clubId !== opts.clubId || to.clubId !== opts.clubId || from.legalEntityId !== opts.legalEntityId || to.legalEntityId !== opts.legalEntityId) {
    return { ok: false, error: "Кошельки принадлежат разным клубам или ИП." };
  }
  if ((await walletBalanceKopeks(opts.fromWalletId)) < opts.amountKopeks) return { ok: false, error: "Недостаточно средств в кошельке-источнике." };

  const m = await prisma.cashMovement.create({
    data: {
      companyId: opts.companyId, clubId: opts.clubId, legalEntityId: opts.legalEntityId,
      type: MOVEMENT.TRANSFER, amountKopeks: opts.amountKopeks, fromWalletId: opts.fromWalletId, toWalletId: opts.toWalletId,
      status: MSTATUS.PENDING, occurredAt: new Date(), createdByUserId: opts.actorUserId, comment: opts.comment?.slice(0, 300) ?? null,
      sourceType: "transfer", sourceId: randomUUID(),
    },
  });
  await recordAudit({ action: "cash.transfer_created", entityType: "CashMovement", entityId: m.id, companyId: opts.companyId, clubId: opts.clubId, userId: opts.actorUserId, metadata: { amountKopeks: opts.amountKopeks, fromWalletId: opts.fromWalletId, toWalletId: opts.toWalletId } });
  return { ok: true, movementId: m.id };
}

/** Confirm a pending transfer (receiver). Re-checks source balance. Idempotent. */
export async function confirmInternalTransfer(movementId: string, actorUserId: string): Promise<{ ok: boolean; error?: string }> {
  const m = await prisma.cashMovement.findUnique({ where: { id: movementId } });
  if (!m || m.type !== MOVEMENT.TRANSFER) return { ok: false, error: "Перевод не найден." };
  if (m.status === MSTATUS.CONFIRMED) return { ok: true }; // idempotent
  if (m.status !== MSTATUS.PENDING) return { ok: false, error: "Перевод недоступен для подтверждения." };
  if (!m.fromWalletId) return { ok: false, error: "Некорректный перевод." };
  if ((await walletBalanceKopeks(m.fromWalletId)) < m.amountKopeks) return { ok: false, error: "Недостаточно средств в кошельке-источнике." };
  const res = await prisma.cashMovement.updateMany({ where: { id: movementId, status: MSTATUS.PENDING }, data: { status: MSTATUS.CONFIRMED, confirmedByUserId: actorUserId, confirmedAt: new Date() } });
  if (res.count === 1) {
    await recordAudit({ action: "cash.transfer_confirmed", entityType: "CashMovement", entityId: movementId, companyId: m.companyId, clubId: m.clubId, userId: actorUserId, metadata: { amountKopeks: m.amountKopeks } });
  }
  return { ok: true }; // concurrent confirm → idempotent
}

/**
 * Create a PENDING «Приход Иное» (external cash added to the Club — NOT a Sale,
 * NOT revenue). The recipient confirms it, creating a confirmed other_cash_income
 * into the Club wallet. Duplicate confirmation is idempotent.
 */
export async function createOtherCashIncome(opts: {
  companyId: string; clubId: string; legalEntityId: string; amountKopeks: number; occurredAt: Date; actorUserId: string; comment: string;
}): Promise<MovementResult> {
  if (!Number.isInteger(opts.amountKopeks) || opts.amountKopeks <= 0) return { ok: false, error: "Сумма должна быть больше нуля." };
  if (!opts.comment.trim()) return { ok: false, error: "Укажите комментарий." };
  const walletId = await ensureClubCashWallet(opts.companyId, opts.clubId, opts.legalEntityId);
  const m = await prisma.cashMovement.create({
    data: {
      companyId: opts.companyId, clubId: opts.clubId, legalEntityId: opts.legalEntityId,
      type: MOVEMENT.OTHER_INCOME, amountKopeks: opts.amountKopeks, toWalletId: walletId, fromWalletId: null,
      status: MSTATUS.PENDING, occurredAt: opts.occurredAt, createdByUserId: opts.actorUserId, comment: opts.comment.slice(0, 300),
      sourceType: "other_income", sourceId: randomUUID(),
    },
  });
  await recordAudit({ action: "cash.other_income_created", entityType: "CashMovement", entityId: m.id, companyId: opts.companyId, clubId: opts.clubId, userId: opts.actorUserId, metadata: { amountKopeks: opts.amountKopeks } });
  return { ok: true, movementId: m.id };
}

/** Confirm «Приход Иное» (recipient) → increases Club wallet once. Idempotent. */
export async function confirmOtherCashIncome(movementId: string, actorUserId: string): Promise<{ ok: boolean; error?: string }> {
  const m = await prisma.cashMovement.findUnique({ where: { id: movementId } });
  if (!m || m.type !== MOVEMENT.OTHER_INCOME) return { ok: false, error: "Приход не найден." };
  if (m.status === MSTATUS.CONFIRMED) return { ok: true };
  if (m.status !== MSTATUS.PENDING) return { ok: false, error: "Приход недоступен для подтверждения." };
  const res = await prisma.cashMovement.updateMany({ where: { id: movementId, status: MSTATUS.PENDING }, data: { status: MSTATUS.CONFIRMED, confirmedByUserId: actorUserId, confirmedAt: new Date() } });
  if (res.count === 1) {
    await recordAudit({ action: "cash.other_income_confirmed", entityType: "CashMovement", entityId: movementId, companyId: m.companyId, clubId: m.clubId, userId: actorUserId, metadata: { amountKopeks: m.amountKopeks } });
  }
  return { ok: true };
}

/** Confirmed other_cash_income into a Club wallet for [start,end). (Card 3) */
export async function otherIncomeForClub(clubId: string, legalEntityId: string, start: Date, end: Date): Promise<number> {
  const club = await getClubWallet(clubId, legalEntityId);
  if (!club) return 0;
  const r = await prisma.cashMovement.aggregate({
    where: { toWalletId: club.id, type: MOVEMENT.OTHER_INCOME, status: MSTATUS.CONFIRMED, occurredAt: { gte: start, lt: end } },
    _sum: { amountKopeks: true },
  });
  return r._sum.amountKopeks ?? 0;
}
