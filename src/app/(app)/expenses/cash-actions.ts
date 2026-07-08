"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, userHasClubRole } from "@/lib/access";
import { canCreateOperational } from "@/lib/auth";
import { monthClosedError } from "@/lib/month-close";
import { resolveActiveIpForClub } from "@/lib/expense-simplified";
import {
  ensureClubCashWallet, ensureRegionalCashWallet, setOpeningBalance,
  createOtherCashIncome, confirmOtherCashIncome, createInternalTransfer, confirmInternalTransfer,
  MOVEMENT, WALLET_CLUB, WALLET_REGIONAL,
} from "@/lib/cash-wallets";

type State = { ok: boolean; error?: string };

// Resolve the selected Club + its single active ИП from server context only.
async function clubContext() {
  const ctx = await getCurrentAccessContext();
  if (!ctx) return { error: "Нет доступа." as const };
  const companyId = ctx.selectedCompanyId;
  const clubId = ctx.selectedClubId ?? (ctx.allowedClubIds.length === 1 ? ctx.allowedClubIds[0] : null);
  if (!companyId || !clubId || !ctx.allowedClubIds.includes(clubId)) return { error: "Выберите клуб." as const };
  const ip = await resolveActiveIpForClub(clubId);
  if (!ip.ok) return { error: ip.error };
  return { ctx, companyId, clubId, legalEntityId: ip.legalEntityId };
}

function parseAmount(v: string): number | null {
  const n = Number(v.trim().replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

// Opening balance may be exactly 0 (explicit "no cash"). Rejects negatives and
// malformed input; converts rubles → integer kopeks (no float storage).
function parseAmountAllowZero(v: string): number | null {
  const s = v.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null; // digits only → no negatives, ≤2 decimals
  return Math.round(Number(s) * 100);
}

// Server-side re-validation of a chosen ИП (never trust the client id): it must
// be an ACTIVE legal entity of type ИП that is actively linked to THIS club.
async function validateClubIp(clubId: string, legalEntityId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const le = await prisma.legalEntity.findUnique({ where: { id: legalEntityId }, select: { type: true, isActive: true } });
  if (!le) return { ok: false, error: "ИП не найдено." };
  if (!(le.type === "ip" || le.type === "ИП")) return { ok: false, error: "В этом поле можно выбрать только ИП (ООО недопустимо)." };
  if (!le.isActive) return { ok: false, error: "ИП неактивно." };
  const link = await prisma.clubLegalEntity.findFirst({ where: { clubId, legalEntityId, isActive: true }, select: { id: true } });
  if (!link) return { ok: false, error: "ИП не связано с этим клубом." };
  return { ok: true };
}

/**
 * Set the one-time opening cash balance for a club_cash wallet. ONLY a regional
 * director WITH access to the selected club may do this — never manager /
 * accountant / chief_accountant / owner / general_director / system_admin.
 * Company/Club come from server scope; the ИП is re-validated server-side.
 */
export async function setOpeningBalanceAction(_p: State | undefined, formData: FormData): Promise<State> {
  const ctx = await getCurrentAccessContext();
  if (!ctx) return { ok: false, error: "Нет доступа." };
  const companyId = ctx.selectedCompanyId;
  const clubId = ctx.selectedClubId ?? (ctx.allowedClubIds.length === 1 ? ctx.allowedClubIds[0] : null);
  if (!companyId || !clubId || !ctx.allowedClubIds.includes(clubId)) return { ok: false, error: "Выберите клуб." };

  // Strict role gate: regional director of THIS club (club- or company-level).
  const isRegional = await userHasClubRole(ctx.user.id, clubId, ["regional_director"]);
  if (!isRegional) return { ok: false, error: "Задать начальный остаток может только региональный директор с доступом к клубу." };

  // ИП: use the submitted id (re-validated) or auto-resolve the single active ИП.
  let legalEntityId = String(formData.get("legalEntityId") ?? "").trim();
  if (!legalEntityId) {
    const ip = await resolveActiveIpForClub(clubId);
    if (!ip.ok) return { ok: false, error: ip.error };
    legalEntityId = ip.legalEntityId;
  }
  const ipCheck = await validateClubIp(clubId, legalEntityId);
  if (!ipCheck.ok) return { ok: false, error: ipCheck.error };

  const amount = parseAmountAllowZero(String(formData.get("amount") ?? ""));
  if (amount === null) return { ok: false, error: "Укажите корректную сумму (0 или больше, без минуса)." };

  const dateRaw = String(formData.get("occurredAt") ?? "").trim();
  const m = dateRaw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { ok: false, error: "Укажите дату." };
  const occurredAt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  // No 7-day backdating limit here — this is NOT an expense. Future is forbidden.
  if (occurredAt.getTime() > todayStart.getTime()) return { ok: false, error: "Дата не может быть в будущем." };
  const closed = await monthClosedError(companyId, clubId, occurredAt);
  if (closed) return { ok: false, error: closed };

  const comment = String(formData.get("comment") ?? "").trim();
  if (!comment) return { ok: false, error: "Укажите комментарий." };

  const res = await setOpeningBalance({ companyId, clubId, legalEntityId, amountKopeks: amount, occurredAt, comment, actorUserId: ctx.user.id });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/expenses/cash");
  return { ok: true };
}

/** Create «Приход Иное» (external cash into the Club). Recipient confirms later. */
export async function createOtherIncomeAction(_p: State | undefined, formData: FormData): Promise<State> {
  const c = await clubContext();
  if ("error" in c) return { ok: false, error: c.error };
  if (!canCreateOperational(c.ctx.effectiveRoles)) return { ok: false, error: "Нет прав." };
  const amount = parseAmount(String(formData.get("amount") ?? ""));
  if (amount === null) return { ok: false, error: "Укажите сумму." };
  const comment = String(formData.get("comment") ?? "").trim();
  if (!comment) return { ok: false, error: "Укажите комментарий." };
  const closed = await monthClosedError(c.companyId, c.clubId, new Date());
  if (closed) return { ok: false, error: closed };
  const res = await createOtherCashIncome({ companyId: c.companyId, clubId: c.clubId, legalEntityId: c.legalEntityId, amountKopeks: amount, occurredAt: new Date(), actorUserId: c.ctx.user.id, comment });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/expenses/cash");
  return { ok: true };
}

export async function confirmOtherIncomeAction(formData: FormData): Promise<void> {
  const c = await clubContext();
  if ("error" in c) return;
  if (!canCreateOperational(c.ctx.effectiveRoles)) return;
  const id = String(formData.get("movementId") ?? "").trim();
  const m = await prisma.cashMovement.findUnique({ where: { id }, select: { clubId: true } });
  if (!m || m.clubId !== c.clubId) return; // scope check
  await confirmOtherCashIncome(id, c.ctx.user.id);
  revalidatePath("/expenses/cash");
}

/**
 * Create a two-way transfer.
 *   direction=to_regional  «Клуб → Директор» — creatable by a manager OR a
 *     regional director of the club; recipient is a chosen regional director.
 *   direction=to_club      «Директор → Клуб» — creatable ONLY by a regional
 *     director of the club; recipient is the club (may go negative for RD).
 * Company/Club/ИП and every wallet id come from the server context — never trust
 * clubId/regionalDirectorId/walletId from the client.
 */
export async function createTransferAction(_p: State | undefined, formData: FormData): Promise<State> {
  const c = await clubContext();
  if ("error" in c) return { ok: false, error: c.error };
  const amount = parseAmount(String(formData.get("amount") ?? ""));
  if (amount === null) return { ok: false, error: "Сумма должна быть больше нуля." };
  const direction = String(formData.get("direction") ?? "");
  const comment = String(formData.get("comment") ?? "");
  const closed = await monthClosedError(c.companyId, c.clubId, new Date());
  if (closed) return { ok: false, error: closed };

  const [isManager, isRegional] = await Promise.all([
    userHasClubRole(c.ctx.user.id, c.clubId, ["manager"]),
    userHasClubRole(c.ctx.user.id, c.clubId, ["regional_director"]),
  ]);
  const clubWalletId = await ensureClubCashWallet(c.companyId, c.clubId, c.legalEntityId);

  if (direction === "to_regional") {
    if (!isManager && !isRegional) return { ok: false, error: "Недостаточно прав для создания перевода." };
    const recipientId = String(formData.get("regionalUserId") ?? "").trim();
    if (!recipientId) return { ok: false, error: "Выберите директора." };
    // The recipient must be a regional director actually tied to THIS club.
    if (!(await userHasClubRole(recipientId, c.clubId, ["regional_director"]))) return { ok: false, error: "Региональный директор не связан с клубом." };
    const toWalletId = await ensureRegionalCashWallet(c.companyId, c.clubId, c.legalEntityId, recipientId);
    const res = await createInternalTransfer({ companyId: c.companyId, clubId: c.clubId, legalEntityId: c.legalEntityId, direction, fromWalletId: clubWalletId, toWalletId, amountKopeks: amount, actorUserId: c.ctx.user.id, recipientUserId: recipientId, comment });
    if (!res.ok) return { ok: false, error: res.error };
  } else if (direction === "to_club") {
    if (!isRegional) return { ok: false, error: "Создать перевод «Директор → Клуб» может только региональный директор." };
    const fromWalletId = await ensureRegionalCashWallet(c.companyId, c.clubId, c.legalEntityId, c.ctx.user.id);
    const res = await createInternalTransfer({ companyId: c.companyId, clubId: c.clubId, legalEntityId: c.legalEntityId, direction, fromWalletId, toWalletId: clubWalletId, amountKopeks: amount, actorUserId: c.ctx.user.id, recipientUserId: null, comment });
    if (!res.ok) return { ok: false, error: res.error };
  } else {
    return { ok: false, error: "Неверное направление." };
  }
  revalidatePath("/expenses/cash");
  return { ok: true };
}

/**
 * Confirm receipt of a transfer. Only the actual recipient may confirm:
 *   «Клуб → Директор» (to regional_cash) → only the target regional director;
 *   «Директор → Клуб» (to club_cash)     → only a manager of the club.
 * accountant / chief_accountant / owner / general_director / system_admin may
 * never stand in for the recipient. Re-validated server-side per request.
 */
export async function confirmTransferAction(_p: State | undefined, formData: FormData): Promise<State> {
  const c = await clubContext();
  if ("error" in c) return { ok: false, error: c.error };
  const id = String(formData.get("movementId") ?? "").trim();
  const m = await prisma.cashMovement.findUnique({
    where: { id },
    select: { type: true, companyId: true, clubId: true, toWallet: { select: { type: true, holderUserId: true } } },
  });
  if (!m || m.type !== MOVEMENT.TRANSFER) return { ok: false, error: "Перевод не найден." };
  if (m.companyId !== c.companyId) return { ok: false, error: "Перевод относится к другой компании." };
  if (m.clubId !== c.clubId) return { ok: false, error: "Перевод относится к другому клубу." };

  if (m.toWallet?.type === WALLET_REGIONAL) {
    // Клуб → Директор: only the addressed regional director.
    if (m.toWallet.holderUserId !== c.ctx.user.id || !(await userHasClubRole(c.ctx.user.id, c.clubId, ["regional_director"]))) {
      return { ok: false, error: "Подтвердить получение может только адресат перевода." };
    }
  } else if (m.toWallet?.type === WALLET_CLUB) {
    // Директор → Клуб: only a manager of THIS club (a regional cannot confirm).
    if (!(await userHasClubRole(c.ctx.user.id, c.clubId, ["manager"]))) {
      return { ok: false, error: "Подтвердить получение клубом может только управляющий." };
    }
  } else {
    return { ok: false, error: "Неверное направление." };
  }

  const res = await confirmInternalTransfer(id, c.ctx.user.id);
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/expenses/cash");
  return { ok: true };
}
