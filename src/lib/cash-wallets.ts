// Centralized cash-wallet + movement service (server-only). A wallet balance is
// derived ONLY from CONFIRMED CashMovement rows — never from mutable manual
// fields. All money is integer kopeks. This is the single source of cash truth;
// page components must not compute balances from unrelated tables.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/access";
import { monthClosedError } from "@/lib/month-close";

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

/**
 * Set the ONE-TIME confirmed opening balance for a Club's club_cash wallet
 * (never a regional wallet). Zero is allowed (explicitly "no cash"); negative is
 * rejected. Concurrency- and repeat-safe: the @@unique(sourceType, sourceId) on
 * ("opening", walletId) guarantees exactly one opening balance per club wallet —
 * a losing parallel request gets a clean "уже задан" error, not a raw Prisma
 * error. Balance stays derived from movements (no manual `balance` field).
 */
export async function setOpeningBalance(opts: {
  companyId: string; clubId: string; legalEntityId: string; amountKopeks: number;
  occurredAt: Date; comment: string; actorUserId: string;
}): Promise<{ ok: boolean; error?: string; walletId?: string; movementId?: string; balanceKopeks?: number }> {
  if (!Number.isInteger(opts.amountKopeks) || opts.amountKopeks < 0) return { ok: false, error: "Начальный остаток должен быть неотрицательным целым числом копеек." };
  const comment = opts.comment.trim();
  if (!comment) return { ok: false, error: "Укажите комментарий." };
  const walletId = await ensureClubCashWallet(opts.companyId, opts.clubId, opts.legalEntityId);

  let movementId: string;
  try {
    const created = await prisma.cashMovement.create({
      data: {
        companyId: opts.companyId, clubId: opts.clubId, legalEntityId: opts.legalEntityId,
        type: MOVEMENT.OPENING, amountKopeks: opts.amountKopeks, toWalletId: walletId, fromWalletId: null,
        status: MSTATUS.CONFIRMED, occurredAt: opts.occurredAt, createdByUserId: opts.actorUserId,
        confirmedByUserId: opts.actorUserId, confirmedAt: new Date(), comment: comment.slice(0, 300),
        sourceType: "opening", sourceId: walletId,
      },
      select: { id: true },
    });
    movementId = created.id;
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") {
      return { ok: false, error: "Начальный остаток уже задан." }; // repeat / parallel conflict
    }
    throw e;
  }

  await recordAudit({
    action: "cash.opening_balance_created", entityType: "CashMovement", entityId: movementId,
    companyId: opts.companyId, clubId: opts.clubId, userId: opts.actorUserId,
    metadata: { legalEntityId: opts.legalEntityId, walletId, cashMovementId: movementId, amountKopeks: opts.amountKopeks, effectiveDate: opts.occurredAt.toISOString() },
  });
  const balanceKopeks = await walletBalanceKopeks(walletId);
  return { ok: true, walletId, movementId, balanceKopeks };
}

export type OpeningBalanceInfo = {
  movementId: string; walletId: string; legalEntityId: string;
  amountKopeks: number; occurredAt: Date; comment: string | null; createdByUserId: string | null;
};

/** The confirmed opening balance for a Club's club_cash wallet, or null. */
export async function getClubOpeningBalance(clubId: string, legalEntityId: string): Promise<OpeningBalanceInfo | null> {
  const club = await getClubWallet(clubId, legalEntityId);
  if (!club) return null;
  const m = await prisma.cashMovement.findFirst({
    where: { toWalletId: club.id, type: MOVEMENT.OPENING, status: MSTATUS.CONFIRMED },
    orderBy: { createdAt: "asc" },
    select: { id: true, amountKopeks: true, occurredAt: true, comment: true, createdByUserId: true, legalEntityId: true },
  });
  if (!m) return null;
  return { movementId: m.id, walletId: club.id, legalEntityId: m.legalEntityId, amountKopeks: m.amountKopeks, occurredAt: m.occurredAt, comment: m.comment, createdByUserId: m.createdByUserId };
}

export type MovementResult = { ok: true; movementId: string } | { ok: false; error: string };

// Regional_cash negative-balance alert thresholds (integer kopeks; strictly
// "more negative than" — exactly on the threshold does NOT fire).
export const REGIONAL_NEG_THRESHOLD_1 = -5_000_000; // −50 000,00 ₽ → chief_accountant
export const REGIONAL_NEG_THRESHOLD_2 = -10_000_000; // −100 000,00 ₽ → chief_accountant + owner
const THRESHOLDS: Array<{ th: number; roles: string[]; message: string }> = [
  { th: REGIONAL_NEG_THRESHOLD_1, roles: ["chief_accountant"], message: "Баланс регионального директора по клубу стал отрицательным и превысил 50 000 ₽. Проверьте передачу личных денежных средств." },
  { th: REGIONAL_NEG_THRESHOLD_2, roles: ["chief_accountant", "owner"], message: "Баланс регионального директора по клубу стал отрицательным и превысил 100 000 ₽. Требуется проверка собственником и главным бухгалтером." },
];

/**
 * Create a PENDING internal transfer between two wallets of the SAME Club + ИП.
 * Overdraft is refused ONLY when the source is club_cash (a club may never go
 * negative). regional_cash MAY go negative (a regional director may front
 * personal cash) — no funds check for that source. The receiving party confirms
 * it later; confirmation flips ONE row to confirmed, atomically moving money on
 * both wallets. The combined Club total is unchanged by the transfer.
 */
export async function createInternalTransfer(opts: {
  companyId: string; clubId: string; legalEntityId: string; direction?: string;
  fromWalletId: string; toWalletId: string; amountKopeks: number; actorUserId: string; recipientUserId?: string | null; comment?: string | null;
}): Promise<MovementResult> {
  if (!Number.isInteger(opts.amountKopeks) || opts.amountKopeks <= 0) return { ok: false, error: "Сумма должна быть больше нуля." };
  if (opts.fromWalletId === opts.toWalletId) return { ok: false, error: "Кошельки совпадают." };
  const [from, to] = await Promise.all([
    prisma.cashWallet.findUnique({ where: { id: opts.fromWalletId }, select: { clubId: true, legalEntityId: true, isActive: true, type: true } }),
    prisma.cashWallet.findUnique({ where: { id: opts.toWalletId }, select: { clubId: true, legalEntityId: true, isActive: true, type: true } }),
  ]);
  // Both wallets must belong to the SAME Club + ИП (regional money never mixes).
  if (!from || !to || !from.isActive || !to.isActive) return { ok: false, error: "Кошелёк не найден." };
  if (from.clubId !== opts.clubId || to.clubId !== opts.clubId || from.legalEntityId !== opts.legalEntityId || to.legalEntityId !== opts.legalEntityId) {
    return { ok: false, error: "Кошельки принадлежат разным клубам или ИП." };
  }
  // Only club_cash must stay non-negative; regional_cash may go negative.
  if (from.type === WALLET_CLUB && (await walletBalanceKopeks(opts.fromWalletId)) < opts.amountKopeks) {
    return { ok: false, error: "Недостаточно денег в кассе клуба." };
  }

  const m = await prisma.cashMovement.create({
    data: {
      companyId: opts.companyId, clubId: opts.clubId, legalEntityId: opts.legalEntityId,
      type: MOVEMENT.TRANSFER, amountKopeks: opts.amountKopeks, fromWalletId: opts.fromWalletId, toWalletId: opts.toWalletId,
      status: MSTATUS.PENDING, occurredAt: new Date(), createdByUserId: opts.actorUserId, comment: opts.comment?.slice(0, 300) ?? null,
      sourceType: "transfer", sourceId: randomUUID(),
    },
  });
  await recordAudit({ action: "cash.transfer_created", entityType: "CashMovement", entityId: m.id, companyId: opts.companyId, clubId: opts.clubId, userId: opts.actorUserId, metadata: { direction: opts.direction ?? null, amountKopeks: opts.amountKopeks, fromWalletId: opts.fromWalletId, toWalletId: opts.toWalletId, recipientUserId: opts.recipientUserId ?? null, cashMovementId: m.id } });
  return { ok: true, movementId: m.id };
}

export type ConfirmTransferResult =
  | { ok: true; already?: boolean; fromKopeks?: number; toKopeks?: number }
  | { ok: false; error: string };

/**
 * Confirm a pending transfer in ONE transaction: re-check status + (for a
 * club_cash source only) sufficient funds, then flip the single row
 * PENDING→CONFIRMED via a conditional update — so a repeat or two parallel
 * confirms yield exactly ONE effect (idempotent, concurrency-safe). Closed-month
 * (by financial date) is blocked. After a confirmed Директор→Клуб (regional
 * source) it evaluates negative-balance thresholds. Authorization of WHO may
 * confirm is enforced by the caller (action layer).
 */
export async function confirmInternalTransfer(movementId: string, actorUserId: string): Promise<ConfirmTransferResult> {
  const m = await prisma.cashMovement.findUnique({
    where: { id: movementId },
    include: { fromWallet: { select: { type: true, holderUserId: true } }, toWallet: { select: { type: true, holderUserId: true } } },
  });
  if (!m || m.type !== MOVEMENT.TRANSFER) return { ok: false, error: "Перевод не найден." };
  if (m.status === MSTATUS.CONFIRMED) return { ok: true, already: true }; // idempotent
  if (m.status === MSTATUS.CANCELLED || m.status === MSTATUS.REJECTED) return { ok: false, error: "Перевод отменён." };
  if (m.status !== MSTATUS.PENDING) return { ok: false, error: "Перевод недоступен для подтверждения." };
  if (!m.fromWalletId || !m.toWalletId) return { ok: false, error: "Некорректный перевод." };
  const closed = await monthClosedError(m.companyId, m.clubId, m.occurredAt);
  if (closed) return { ok: false, error: closed };

  const fromWalletId = m.fromWalletId, amount = m.amountKopeks, clubSource = m.fromWallet?.type === WALLET_CLUB;

  const outcome = await prisma.$transaction(async (tx) => {
    const cur = await tx.cashMovement.findUnique({ where: { id: movementId }, select: { status: true } });
    if (!cur) return "not_found" as const;
    if (cur.status === MSTATUS.CONFIRMED) return "already" as const;
    if (cur.status !== MSTATUS.PENDING) return "not_pending" as const;
    // A club_cash source must not be overdrawn (regional_cash may go negative).
    if (clubSource && (await walletBalanceKopeks(fromWalletId, tx)) < amount) return "insufficient" as const;
    const upd = await tx.cashMovement.updateMany({ where: { id: movementId, status: MSTATUS.PENDING }, data: { status: MSTATUS.CONFIRMED, confirmedByUserId: actorUserId, confirmedAt: new Date() } });
    return upd.count === 1 ? ("applied" as const) : ("already" as const);
  });

  if (outcome === "not_found") return { ok: false, error: "Перевод не найден." };
  if (outcome === "insufficient") return { ok: false, error: "Недостаточно денег в кассе клуба." };
  if (outcome === "already") return { ok: true, already: true }; // concurrent confirm → single effect
  if (outcome === "not_pending") return { ok: false, error: "Перевод недоступен для подтверждения." };

  await recordAudit({ action: "cash.transfer_confirmed", entityType: "CashMovement", entityId: movementId, companyId: m.companyId, clubId: m.clubId, userId: actorUserId, metadata: { direction: m.fromWallet?.type === WALLET_REGIONAL ? "to_club" : "to_regional", cashMovementId: movementId, amountKopeks: amount, confirmedByUserId: actorUserId, confirmedAt: new Date().toISOString() } });

  // Thresholds only apply to Директор→Клуб (the regional wallet is the source).
  if (m.fromWallet?.type === WALLET_REGIONAL) {
    await evaluateRegionalNegativeThresholds({
      companyId: m.companyId, clubId: m.clubId, walletId: fromWalletId,
      regionalDirectorId: m.fromWallet.holderUserId ?? null, amountApplied: amount, actorUserId, movementId,
    });
  }

  const [fromKopeks, toKopeks] = await Promise.all([walletBalanceKopeks(fromWalletId), walletBalanceKopeks(m.toWalletId)]);
  return { ok: true, fromKopeks, toKopeks };
}

/**
 * After a confirmed regional-source transfer, create a persistent notification +
 * audit for each threshold crossed DOWNWARD by this confirmation. Crossing is
 * detected from prev→new balance (prev = new + amountApplied), so a further drop
 * within the same threshold does NOT re-notify, while a recovery-then-drop (a new
 * movement) can. dedupeKey makes it idempotent per (wallet, threshold, role,
 * movement) against repeats/parallel confirms.
 */
async function evaluateRegionalNegativeThresholds(opts: {
  companyId: string; clubId: string; walletId: string; regionalDirectorId: string | null;
  amountApplied: number; actorUserId: string; movementId: string;
}): Promise<void> {
  const newBalance = await walletBalanceKopeks(opts.walletId);
  const prevBalance = newBalance + opts.amountApplied; // this confirm removed `amountApplied`
  for (const t of THRESHOLDS) {
    const crossedDown = prevBalance >= t.th && newBalance < t.th;
    if (!crossedDown) continue;
    await recordAudit({
      action: "cash.regional_negative_threshold_crossed", entityType: "CashWallet", entityId: opts.walletId,
      companyId: opts.companyId, clubId: opts.clubId, userId: opts.actorUserId,
      metadata: { clubId: opts.clubId, regionalDirectorId: opts.regionalDirectorId, walletId: opts.walletId, balanceKopeks: newBalance, thresholdKopeks: t.th, recipientRoles: t.roles },
    });
    for (const role of t.roles) {
      const dedupeKey = `${opts.walletId}:${t.th}:${role}:${opts.movementId}`;
      try {
        await prisma.cashNotification.create({
          data: {
            companyId: opts.companyId, clubId: opts.clubId, walletId: opts.walletId, recipientRole: role,
            type: "regional_cash_negative_threshold", thresholdKopeks: t.th, balanceKopeks: newBalance,
            regionalDirectorId: opts.regionalDirectorId, title: "Отрицательный баланс регионального директора",
            message: t.message, linkPath: "/expenses/cash", dedupeKey,
          },
        });
      } catch (e) {
        if (!(e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002")) throw e; // dedupe
      }
    }
  }
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
