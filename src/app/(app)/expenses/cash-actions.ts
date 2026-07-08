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

/** Create an internal transfer: club→regional (manager) or regional→club (RD). */
export async function createTransferAction(_p: State | undefined, formData: FormData): Promise<State> {
  const c = await clubContext();
  if ("error" in c) return { ok: false, error: c.error };
  if (!canCreateOperational(c.ctx.effectiveRoles)) return { ok: false, error: "Нет прав." };
  const amount = parseAmount(String(formData.get("amount") ?? ""));
  if (amount === null) return { ok: false, error: "Укажите сумму." };
  const direction = String(formData.get("direction") ?? "");
  const closed = await monthClosedError(c.companyId, c.clubId, new Date());
  if (closed) return { ok: false, error: closed };

  const clubWalletId = await ensureClubCashWallet(c.companyId, c.clubId, c.legalEntityId);
  let fromWalletId: string, toWalletId: string;
  if (direction === "to_regional") {
    const holder = String(formData.get("regionalUserId") ?? "").trim();
    if (!holder) return { ok: false, error: "Выберите регионального директора." };
    fromWalletId = clubWalletId;
    toWalletId = await ensureRegionalCashWallet(c.companyId, c.clubId, c.legalEntityId, holder);
  } else if (direction === "to_club") {
    // The acting regional director returns cash from their own wallet.
    const isRegional = await userHasClubRole(c.ctx.user.id, c.clubId, ["regional_director"]);
    if (!isRegional) return { ok: false, error: "Только региональный директор может вернуть наличные в клуб." };
    fromWalletId = await ensureRegionalCashWallet(c.companyId, c.clubId, c.legalEntityId, c.ctx.user.id);
    toWalletId = clubWalletId;
  } else {
    return { ok: false, error: "Неверное направление." };
  }
  const res = await createInternalTransfer({ companyId: c.companyId, clubId: c.clubId, legalEntityId: c.legalEntityId, fromWalletId, toWalletId, amountKopeks: amount, actorUserId: c.ctx.user.id, comment: String(formData.get("comment") ?? "") });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/expenses/cash");
  return { ok: true };
}

export async function confirmTransferAction(formData: FormData): Promise<void> {
  const c = await clubContext();
  if ("error" in c) return;
  if (!canCreateOperational(c.ctx.effectiveRoles)) return;
  const id = String(formData.get("movementId") ?? "").trim();
  const m = await prisma.cashMovement.findUnique({ where: { id }, select: { clubId: true } });
  if (!m || m.clubId !== c.clubId) return;
  await confirmInternalTransfer(id, c.ctx.user.id);
  revalidatePath("/expenses/cash");
}
