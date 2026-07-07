"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, userHasCompanyRole, userHasClubRole } from "@/lib/access";
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

/** Set the one-time opening balance (chief accountant or owner only). */
export async function setOpeningBalanceAction(_p: State | undefined, formData: FormData): Promise<State> {
  const c = await clubContext();
  if ("error" in c) return { ok: false, error: c.error };
  const isChief = await userHasClubRole(c.ctx.user.id, c.clubId, ["chief_accountant"]);
  const isOwner = await userHasCompanyRole(c.ctx.user.id, c.companyId, ["owner"]);
  if (!isChief && !isOwner) return { ok: false, error: "Задать начальный остаток может главный бухгалтер или собственник." };
  const amount = parseAmount(String(formData.get("amount") ?? ""));
  if (amount === null) return { ok: false, error: "Укажите сумму." };
  const res = await setOpeningBalance({ companyId: c.companyId, clubId: c.clubId, legalEntityId: c.legalEntityId, amountKopeks: amount, actorUserId: c.ctx.user.id });
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
