"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { canCreateOperational, canManageControlSnapshot, type Role } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { getActiveClubLegalEntities } from "@/lib/legal-entities";
import { runSyncNowForCompany } from "@/lib/ofd/daily";
import { validateAndStoreCashDocument, type StoredCashDocument, MIN_CASH_OPERATION_DOCUMENTS, MAX_CASH_OPERATION_DOCUMENTS } from "@/lib/cash-document-storage";
import { isUploadedFile } from "@/lib/uploaded-file";
import { getActiveSnapshotOnDate, isExplicitClubManager, getEligibleRegionalDirectorsForClub } from "@/lib/cash-transfers";

export type CashState = { ok: boolean; error?: string; notice?: string; sync?: { found: number; imported: number; skipped: number } };

function canReviewCollection(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "accountant" || r === "chief_accountant" || r === "owner" || r === "general_director");
}
// A control (opening) balance is the physical club cash count — managed via the shared
// canManageControlSnapshot role gate (manager / regional / owner / GD / accountant / chief);
// club/company scope is enforced separately by ctxForWrite.
const canSetOpeningBalance = canManageControlSnapshot;
function canReviewWithdrawal(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "accountant" || r === "chief_accountant" || r === "owner" || r === "general_director" || r === "regional_director");
}

async function ctxForWrite(clubId: string | null): Promise<
  | { ok: true; companyId: string; userId: string; roles: Role[]; clubIds: string[] }
  | { ok: false; error: string }
> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа." };
  if (clubId && !ctx.allowedClubIds.includes(clubId)) return { ok: false, error: "Клуб недоступен." };
  return { ok: true, companyId: ctx.selectedCompanyId, userId: ctx.user.id, roles: ctx.effectiveRoles, clubIds: ctx.allowedClubIds };
}

function parseAmountKopeks(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(String(raw).replace(",", ".").replace(/\s/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return rublesToKopeks(n);
}
function parseDate(raw: string | null): Date | null {
  const m = String(raw ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** Validate + store the supporting documents from the form (min..3). Pass min=0 for
 * operations where documents are optional (e.g. Приход «Иное»). */
async function collectDocuments(formData: FormData, min: number = MIN_CASH_OPERATION_DOCUMENTS): Promise<{ ok: true; docs: StoredCashDocument[] } | { ok: false; error: string }> {
  const files = formData.getAll("documents").filter(isUploadedFile);
  if (files.length < min) return { ok: false, error: "Прикрепите хотя бы один подтверждающий документ." };
  if (files.length > MAX_CASH_OPERATION_DOCUMENTS) return { ok: false, error: `Не более ${MAX_CASH_OPERATION_DOCUMENTS} документов.` };
  const stored: StoredCashDocument[] = [];
  for (const f of files) {
    const r = await validateAndStoreCashDocument(f);
    if (!r.ok) return { ok: false, error: "Файл не принят: допустимы JPG, PNG, WEBP, PDF до 10 МБ." };
    stored.push(r.doc);
  }
  return { ok: true, docs: stored };
}

/** Set a control (opening) cash balance for a club's ООО or ИП — a NEW BalanceSnapshot
 * checkpoint (never edits history). The fact balance is measured from the latest
 * checkpoint. Comment is required; a document is not required here. */
export async function setCashOpeningBalance(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  const clubId = String(formData.get("clubId") ?? "").trim() || null;
  const g = await ctxForWrite(clubId);
  if (!g.ok) return { ok: false, error: g.error };
  if (!canSetOpeningBalance(g.roles)) return { ok: false, error: "Недостаточно прав для контрольного остатка." };
  if (!clubId) return { ok: false, error: "Выберите клуб." };
  const entity = String(formData.get("entity") ?? "").trim();
  if (entity !== "ooo" && entity !== "ip") return { ok: false, error: "Выберите юрлицо (ООО или ИП)." };
  const amountRaw = String(formData.get("amount") ?? "").replace(",", ".").replace(/\s/g, "");
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: "Укажите корректную сумму." };
  const amountKopeks = rublesToKopeks(amount);
  const snapshotDate = parseDate(String(formData.get("snapshotDate") ?? ""));
  if (!snapshotDate) return { ok: false, error: "Укажите дату контрольного остатка." };
  // A physical cash count cannot be dated in the future.
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
  if (snapshotDate.getTime() > todayEnd.getTime()) return { ok: false, error: "Дата контрольного остатка не может быть в будущем." };
  const comment = String(formData.get("comment") ?? "").trim();
  if (!comment) return { ok: false, error: "Комментарий обязателен." };
  const { ooo, ip } = await getActiveClubLegalEntities(clubId);
  const target = entity === "ooo" ? ooo : ip;
  if (!target) return { ok: false, error: `У клуба нет активного ${entity === "ooo" ? "ООО" : "ИП"}.` };

  // Same-date guard (§11): at most ONE active point per (club, entity, date). A backdated
  // EARLIER date is allowed (it only fills the historical interval before the next point);
  // a plain duplicate on an existing date is refused — use «Скорректировать» instead.
  const clash = await getActiveSnapshotOnDate(clubId, target.id, snapshotDate);
  if (clash) return { ok: false, error: "На эту дату уже существует контрольная точка. Используйте корректировку." };

  const created = await prisma.balanceSnapshot.create({
    data: { companyId: g.companyId, clubId, legalEntityId: target.id, snapshotDate, actualBalanceKopeks: amountKopeks, comment: comment.slice(0, 500), createdById: g.userId, status: "active", version: 1 },
  });
  await recordAudit({ action: "cash.opening_balance_set", entityType: "BalanceSnapshot", entityId: created.id, companyId: g.companyId, clubId, userId: g.userId, metadata: { entity, amountKopeks, snapshotDate: snapshotDate.toISOString().slice(0, 10) } });
  revalidatePath("/collections");
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return { ok: true, notice: `Контрольная точка ${entity === "ooo" ? "ООО" : "ИП"} на ${snapshotDate.toISOString().slice(0, 10)} сохранена. Текущий остаток считается от последней применимой точки.` };
}

/** «Скорректировать контрольную точку» (§12): append-only correction. Creates a NEW
 *  version that supersedes the previous ACTIVE one on that date (old row flips to
 *  superseded — never edited), requires a reason, and keeps the full version chain. The
 *  balance always uses the latest active version for a date. Roles = as for setting one. */
export async function correctBalanceSnapshot(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  const snapshotId = String(formData.get("snapshotId") ?? "").trim();
  const g = await ctxForWrite(null);
  if (!g.ok) return { ok: false, error: g.error };
  if (!canSetOpeningBalance(g.roles)) return { ok: false, error: "Недостаточно прав для корректировки." };
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { ok: false, error: "Укажите причину корректировки." };
  const amountRaw = String(formData.get("amount") ?? "").replace(",", ".").replace(/\s/g, "");
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: "Укажите корректную сумму." };
  const amountKopeks = rublesToKopeks(amount);

  const old = await prisma.balanceSnapshot.findFirst({ where: { id: snapshotId, clubId: { in: g.clubIds }, status: "active" }, select: { id: true, companyId: true, clubId: true, legalEntityId: true, snapshotDate: true, version: true } });
  if (!old) return { ok: false, error: "Активная контрольная точка не найдена." };

  const created = await prisma.$transaction(async (tx) => {
    // Race-safe: only supersede a still-active row.
    const flip = await tx.balanceSnapshot.updateMany({ where: { id: old.id, status: "active" }, data: { status: "superseded" } });
    if (flip.count !== 1) throw new Error("superseded");
    return tx.balanceSnapshot.create({
      data: { companyId: old.companyId, clubId: old.clubId, legalEntityId: old.legalEntityId, snapshotDate: old.snapshotDate, actualBalanceKopeks: amountKopeks, comment: `Корректировка: ${reason}`.slice(0, 500), createdById: g.userId, status: "active", version: old.version + 1, supersedesSnapshotId: old.id, correctionReason: reason.slice(0, 500) },
    });
  }).catch(() => null);
  if (!created) return { ok: false, error: "Точка только что изменилась. Обновите страницу." };

  await recordAudit({ action: "cash.opening_balance_corrected", entityType: "BalanceSnapshot", entityId: created.id, companyId: created.companyId, clubId: created.clubId, userId: g.userId, metadata: { supersedes: old.id, version: created.version, amountKopeks } });
  revalidatePath("/collections");
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return { ok: true, notice: `Контрольная точка скорректирована (версия ${created.version}). Прежняя версия сохранена в истории.` };
}

/** «Отменить контрольную точку» (§10): make an active point non-applicable WITHOUT deleting
 *  it. Requires a reason; flips status active→cancelled and records who/when/why; amount + date
 *  are NEVER edited. After cancellation the resolver (status = active only) automatically uses
 *  the previous applicable point; later active points are untouched. No hard delete exists. */
export async function cancelBalanceSnapshot(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  const snapshotId = String(formData.get("snapshotId") ?? "").trim();
  const g = await ctxForWrite(null);
  if (!g.ok) return { ok: false, error: g.error };
  if (!canSetOpeningBalance(g.roles)) return { ok: false, error: "Недостаточно прав для отмены контрольной точки." };
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { ok: false, error: "Укажите причину отмены." };

  const old = await prisma.balanceSnapshot.findFirst({ where: { id: snapshotId, clubId: { in: g.clubIds }, status: "active" }, select: { id: true, companyId: true, clubId: true } });
  if (!old) return { ok: false, error: "Активная контрольная точка не найдена." };
  // Race-safe: only cancel a still-active row. amount/date untouched — append-only.
  const n = await prisma.balanceSnapshot.updateMany({ where: { id: old.id, status: "active" }, data: { status: "cancelled", cancelledById: g.userId, cancelledAt: new Date(), cancellationReason: reason.slice(0, 500) } });
  if (n.count === 0) return { ok: false, error: "Точка только что изменилась. Обновите страницу." };
  await recordAudit({ action: "cash.opening_balance_cancelled", entityType: "BalanceSnapshot", entityId: old.id, companyId: old.companyId, clubId: old.clubId, userId: g.userId, metadata: { reason: reason.slice(0, 200) } });
  revalidatePath("/collections");
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return { ok: true, notice: "Контрольная точка отменена. Расчёт выполняется от предыдущей действующей точки." };
}

/** Инкассация ООО — reduces the ООО fact balance immediately (pending). */
export async function createCashCollection(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  const clubId = String(formData.get("clubId") ?? "").trim() || null;
  const g = await ctxForWrite(clubId);
  if (!g.ok) return { ok: false, error: g.error };
  if (!canCreateOperational(g.roles)) return { ok: false, error: "Создавать инкассацию может управляющий или региональный директор." };
  if (!clubId) return { ok: false, error: "Выберите клуб." };
  const amountKopeks = parseAmountKopeks(String(formData.get("amount") ?? ""));
  if (!amountKopeks) return { ok: false, error: "Укажите сумму." };
  const operationDate = parseDate(String(formData.get("operationDate") ?? ""));
  if (!operationDate) return { ok: false, error: "Укажите дату инкассации." };
  const { ooo } = await getActiveClubLegalEntities(clubId);
  if (!ooo) return { ok: false, error: "У клуба нет активного ООО для инкассации." };
  const docs = await collectDocuments(formData);
  if (!docs.ok) return { ok: false, error: docs.error };

  const created = await prisma.$transaction(async (tx) => {
    const c = await tx.cashCollection.create({
      data: { companyId: g.companyId, clubId, legalEntityId: ooo.id, amountKopeks, operationDate, comment: String(formData.get("comment") ?? "").trim() || null, status: "pending_accountant_review", createdByUserId: g.userId },
    });
    await tx.cashOperationDocument.createMany({ data: docs.docs.map((d) => ({ collectionId: c.id, companyId: g.companyId, clubId, storageKey: d.storageKey, originalFilename: d.originalFilename, safeFilename: d.safeFilename, mimeType: d.mimeType, sizeBytes: d.sizeBytes, sha256: d.sha256, uploadedByUserId: g.userId })) });
    return c;
  });
  await recordAudit({ action: "cash.collection_created", entityType: "CashCollection", entityId: created.id, companyId: g.companyId, clubId, userId: g.userId, metadata: { amountKopeks, legalEntityType: "ooo", documents: docs.docs.length } });
  revalidatePath("/collections");
  revalidatePath("/dashboard");
  return { ok: true, notice: "Инкассация отправлена на проверку. Остаток ООО уменьшен." };
}

/** Изъятие ООО → ИП — reduces ООО and increases ИП fact balance immediately (pending). */
export async function createCashWithdrawal(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  const clubId = String(formData.get("clubId") ?? "").trim() || null;
  const g = await ctxForWrite(clubId);
  if (!g.ok) return { ok: false, error: g.error };
  if (!canCreateOperational(g.roles)) return { ok: false, error: "Создавать изъятие может управляющий или региональный директор." };
  if (!clubId) return { ok: false, error: "Выберите клуб." };
  const amountKopeks = parseAmountKopeks(String(formData.get("amount") ?? ""));
  if (!amountKopeks) return { ok: false, error: "Укажите сумму." };
  const operationDate = parseDate(String(formData.get("operationDate") ?? ""));
  if (!operationDate) return { ok: false, error: "Укажите дату изъятия." };
  const { ooo, ip } = await getActiveClubLegalEntities(clubId);
  if (!ooo) return { ok: false, error: "У клуба нет активного ООО." };
  if (!ip) return { ok: false, error: "У клуба нет активного ИП." };
  const docs = await collectDocuments(formData);
  if (!docs.ok) return { ok: false, error: docs.error };

  const created = await prisma.$transaction(async (tx) => {
    const w = await tx.cashWithdrawal.create({
      data: { companyId: g.companyId, clubId, fromLegalEntityId: ooo.id, toLegalEntityId: ip.id, amountKopeks, operationDate, comment: String(formData.get("comment") ?? "").trim() || null, status: "pending_review", createdByUserId: g.userId },
    });
    await tx.cashOperationDocument.createMany({ data: docs.docs.map((d) => ({ withdrawalId: w.id, companyId: g.companyId, clubId, storageKey: d.storageKey, originalFilename: d.originalFilename, safeFilename: d.safeFilename, mimeType: d.mimeType, sizeBytes: d.sizeBytes, sha256: d.sha256, uploadedByUserId: g.userId })) });
    return w;
  });
  await recordAudit({ action: "cash.withdrawal_created", entityType: "CashWithdrawal", entityId: created.id, companyId: g.companyId, clubId, userId: g.userId, metadata: { amountKopeks, documents: docs.docs.length } });
  revalidatePath("/collections");
  revalidatePath("/dashboard");
  return { ok: true, notice: "Изъятие отправлено на проверку. ООО уменьшен, ИП увеличен." };
}

async function reviewCollection(formData: FormData, toStatus: "approved" | "rejected", action: string): Promise<CashState> {
  const id = String(formData.get("id") ?? "").trim();
  const g = await ctxForWrite(null);
  if (!g.ok) return { ok: false, error: g.error };
  if (!canReviewCollection(g.roles)) return { ok: false, error: "Недостаточно прав." };
  const row = await prisma.cashCollection.findFirst({ where: { id, companyId: g.companyId, clubId: { in: g.clubIds } }, select: { id: true, clubId: true, amountKopeks: true } });
  if (!row) return { ok: false, error: "Инкассация не найдена." };
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 200) || null;
  const n = await prisma.cashCollection.updateMany({ where: { id, status: "pending_accountant_review" }, data: { status: toStatus, reviewedByUserId: g.userId, reviewedAt: new Date(), reviewReason: reason } });
  if (n.count === 0) return { ok: false, error: "Операция уже обработана." };
  await recordAudit({ action, entityType: "CashCollection", entityId: id, companyId: g.companyId, clubId: row.clubId, userId: g.userId, metadata: { amountKopeks: row.amountKopeks } });
  revalidatePath("/collections");
  revalidatePath("/dashboard");
  revalidatePath("/workspace");
  return { ok: true, notice: toStatus === "approved" ? "Инкассация подтверждена." : "Инкассация отклонена, остаток ООО возвращён." };
}
export async function approveCashCollection(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  return reviewCollection(formData, "approved", "cash.collection_approved");
}
export async function rejectCashCollection(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  return reviewCollection(formData, "rejected", "cash.collection_rejected");
}

async function reviewWithdrawal(formData: FormData, toStatus: "approved" | "rejected", action: string): Promise<CashState> {
  const id = String(formData.get("id") ?? "").trim();
  const g = await ctxForWrite(null);
  if (!g.ok) return { ok: false, error: g.error };
  if (!canReviewWithdrawal(g.roles)) return { ok: false, error: "Недостаточно прав." };
  const row = await prisma.cashWithdrawal.findFirst({ where: { id, companyId: g.companyId, clubId: { in: g.clubIds } }, select: { id: true, clubId: true, amountKopeks: true } });
  if (!row) return { ok: false, error: "Изъятие не найдено." };
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 200) || null;
  const n = await prisma.cashWithdrawal.updateMany({ where: { id, status: "pending_review" }, data: { status: toStatus, reviewedByUserId: g.userId, reviewedAt: new Date(), reviewReason: reason } });
  if (n.count === 0) return { ok: false, error: "Операция уже обработана." };
  await recordAudit({ action, entityType: "CashWithdrawal", entityId: id, companyId: g.companyId, clubId: row.clubId, userId: g.userId, metadata: { amountKopeks: row.amountKopeks } });
  revalidatePath("/collections");
  revalidatePath("/dashboard");
  revalidatePath("/workspace");
  return { ok: true, notice: toStatus === "approved" ? "Изъятие подтверждено." : "Изъятие отклонено, остатки возвращены." };
}
export async function approveCashWithdrawal(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  return reviewWithdrawal(formData, "approved", "cash.withdrawal_approved");
}
export async function rejectCashWithdrawal(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  return reviewWithdrawal(formData, "rejected", "cash.withdrawal_rejected");
}

// Soft-cancel: never a hard delete — the row stays in history as "cancelled" and
// stops affecting the fact balance. Reuses reviewedBy/reviewedAt/reviewReason to
// record who cancelled it and why (no schema change). Only draft / pending may be
// cancelled; an approved operation is refused with a clear message.
const CANCELABLE_COLLECTION = ["draft", "pending_accountant_review"];
const CANCELABLE_WITHDRAWAL = ["draft", "pending_review"];

/** Отмена инкассации ООО (soft-cancel → status "cancelled"). */
export async function cancelCashCollection(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  const id = String(formData.get("id") ?? "").trim();
  const g = await ctxForWrite(null);
  if (!g.ok) return { ok: false, error: g.error };
  const row = await prisma.cashCollection.findFirst({ where: { id, companyId: g.companyId, clubId: { in: g.clubIds } }, select: { id: true, clubId: true, amountKopeks: true, status: true, createdByUserId: true } });
  if (!row) return { ok: false, error: "Инкассация не найдена." };
  const isCreator = row.createdByUserId === g.userId;
  if (!isCreator && !canReviewCollection(g.roles)) return { ok: false, error: "Недостаточно прав для отмены." };
  if (row.status === "approved") return { ok: false, error: "Подтверждённую инкассацию нельзя удалить. Создайте корректировку или обратитесь к администратору." };
  if (!CANCELABLE_COLLECTION.includes(row.status)) return { ok: false, error: "Операция уже обработана и не может быть отменена." };
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 200) || null;
  const n = await prisma.cashCollection.updateMany({ where: { id, status: { in: CANCELABLE_COLLECTION } }, data: { status: "cancelled", reviewedByUserId: g.userId, reviewedAt: new Date(), reviewReason: reason } });
  if (n.count === 0) return { ok: false, error: "Операция уже обработана." };
  await recordAudit({ action: "cash.collection_cancelled", entityType: "CashCollection", entityId: id, companyId: g.companyId, clubId: row.clubId, userId: g.userId, metadata: { amountKopeks: row.amountKopeks, status: "cancelled", reason } });
  revalidatePath("/collections");
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return { ok: true, notice: "Инкассация отменена. Остаток ООО возвращён." };
}

/** Отмена изъятия ООО→ИП (soft-cancel → status "cancelled"). */
export async function cancelCashWithdrawal(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  const id = String(formData.get("id") ?? "").trim();
  const g = await ctxForWrite(null);
  if (!g.ok) return { ok: false, error: g.error };
  const row = await prisma.cashWithdrawal.findFirst({ where: { id, companyId: g.companyId, clubId: { in: g.clubIds } }, select: { id: true, clubId: true, amountKopeks: true, status: true, createdByUserId: true } });
  if (!row) return { ok: false, error: "Изъятие не найдено." };
  const isCreator = row.createdByUserId === g.userId;
  if (!isCreator && !canReviewWithdrawal(g.roles)) return { ok: false, error: "Недостаточно прав для отмены." };
  if (row.status === "approved") return { ok: false, error: "Подтверждённое изъятие нельзя удалить. Создайте корректировку или обратитесь к администратору." };
  if (!CANCELABLE_WITHDRAWAL.includes(row.status)) return { ok: false, error: "Операция уже обработана и не может быть отменена." };
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 200) || null;
  const n = await prisma.cashWithdrawal.updateMany({ where: { id, status: { in: CANCELABLE_WITHDRAWAL } }, data: { status: "cancelled", reviewedByUserId: g.userId, reviewedAt: new Date(), reviewReason: reason } });
  if (n.count === 0) return { ok: false, error: "Операция уже обработана." };
  await recordAudit({ action: "cash.withdrawal_cancelled", entityType: "CashWithdrawal", entityId: id, companyId: g.companyId, clubId: row.clubId, userId: g.userId, metadata: { amountKopeks: row.amountKopeks, status: "cancelled", reason } });
  revalidatePath("/collections");
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return { ok: true, notice: "Изъятие отменено. Остатки ООО и ИП возвращены." };
}

// --- Приход «Иное» — internal ИП cash top-up (regional/owner/GD/other) ------
// NOT a sale / OFD / revenue / инкассация / изъятие / expense — only increases the
// ИП fact balance. Same status machine as изъятие; pending counts immediately.
const OTHER_INCOME_SOURCES = ["regional", "owner", "general_director", "other"];
const CANCELABLE_OTHER_INCOME = ["draft", "pending_review"];

/** Создать «Приход Иное» в ИП. Комментарий обязателен; документы опциональны (0–3). */
export async function createCashOtherIncome(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  const clubId = String(formData.get("clubId") ?? "").trim() || null;
  const g = await ctxForWrite(clubId);
  if (!g.ok) return { ok: false, error: g.error };
  if (!canCreateOperational(g.roles)) return { ok: false, error: "Создавать приход «Иное» может управляющий или региональный директор." };
  if (!clubId) return { ok: false, error: "Выберите клуб." };
  const amountKopeks = parseAmountKopeks(String(formData.get("amount") ?? ""));
  if (!amountKopeks) return { ok: false, error: "Укажите сумму." };
  const operationDate = parseDate(String(formData.get("operationDate") ?? ""));
  if (!operationDate) return { ok: false, error: "Укажите дату поступления." };
  const source = OTHER_INCOME_SOURCES.includes(String(formData.get("source") ?? "")) ? String(formData.get("source")) : "other";
  const comment = String(formData.get("comment") ?? "").trim();
  if (!comment) return { ok: false, error: "Комментарий обязателен." };
  const { ip } = await getActiveClubLegalEntities(clubId);
  if (!ip) return { ok: false, error: "У клуба нет активного ИП." };
  // Приход «Иное» НЕ принимает подтверждающие документы: поле убрано из формы и любые
  // attachments из запроса игнорируются (сервер файла не ожидает). Исторические документы
  // прошлых операций остаются в БД и доступны read-only — здесь ничего не удаляется.
  const created = await prisma.cashOtherIncome.create({
    data: { companyId: g.companyId, clubId, legalEntityId: ip.id, amountKopeks, operationDate, source, comment: comment.slice(0, 500), status: "pending_review", createdByUserId: g.userId },
  });
  await recordAudit({ action: "cash.other_income_created", entityType: "CashOtherIncome", entityId: created.id, companyId: g.companyId, clubId, userId: g.userId, metadata: { amountKopeks, source, documents: 0 } });
  revalidatePath("/collections");
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return { ok: true, notice: "Приход «Иное» добавлен. Остаток ИП увеличен." };
}

async function reviewOtherIncome(formData: FormData, toStatus: "approved" | "rejected", action: string): Promise<CashState> {
  const id = String(formData.get("id") ?? "").trim();
  const g = await ctxForWrite(null);
  if (!g.ok) return { ok: false, error: g.error };
  if (!canReviewWithdrawal(g.roles)) return { ok: false, error: "Недостаточно прав." };
  const row = await prisma.cashOtherIncome.findFirst({ where: { id, companyId: g.companyId, clubId: { in: g.clubIds } }, select: { id: true, clubId: true, amountKopeks: true, source: true } });
  if (!row) return { ok: false, error: "Операция не найдена." };
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 200) || null;
  const n = await prisma.cashOtherIncome.updateMany({ where: { id, status: "pending_review" }, data: { status: toStatus, reviewedByUserId: g.userId, reviewedAt: new Date(), reviewReason: reason } });
  if (n.count === 0) return { ok: false, error: "Операция уже обработана." };
  await recordAudit({ action, entityType: "CashOtherIncome", entityId: id, companyId: g.companyId, clubId: row.clubId, userId: g.userId, metadata: { amountKopeks: row.amountKopeks, source: row.source } });
  revalidatePath("/collections");
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return { ok: true, notice: toStatus === "approved" ? "Приход «Иное» подтверждён." : "Приход «Иное» отклонён, остаток ИП возвращён." };
}
export async function approveCashOtherIncome(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  return reviewOtherIncome(formData, "approved", "cash.other_income_approved");
}
export async function rejectCashOtherIncome(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  return reviewOtherIncome(formData, "rejected", "cash.other_income_rejected");
}

// ===================== Передача региональному директору (§2–§5) =====================
// Internal cash movement: ИП cash physically handed from the club to a regional director.
// NOT a sale/revenue/expense/инкассация/изъятие. Only CONFIRMED (by the club manager)
// reduces the ИП fact balance. Return path is «Приход Иное» (source=regional) — no reverse op.

/** Create a transfer (pending_confirmation). Author = club manager OR a regional director
 *  with club access (same as other cash ops). Recipient must be an eligible active regional
 *  director. idempotencyKey blocks duplicate submits. */
export async function createRegionalTransfer(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  const clubId = String(formData.get("clubId") ?? "").trim() || null;
  const g = await ctxForWrite(clubId);
  if (!g.ok) return { ok: false, error: g.error };
  if (!canCreateOperational(g.roles)) return { ok: false, error: "Передать деньги регионалу может управляющий или региональный директор." };
  if (!clubId) return { ok: false, error: "Выберите клуб." };
  const amountKopeks = parseAmountKopeks(String(formData.get("amount") ?? ""));
  if (!amountKopeks) return { ok: false, error: "Укажите сумму." };
  const operationDate = parseDate(String(formData.get("operationDate") ?? ""));
  if (!operationDate) return { ok: false, error: "Укажите дату передачи." };
  const recipientId = String(formData.get("recipientRegionalDirectorId") ?? "").trim();
  if (!recipientId) return { ok: false, error: "Выберите получателя (регионального директора)." };
  const comment = String(formData.get("comment") ?? "").trim();
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "").trim() || randomUUID();

  const { ip } = await getActiveClubLegalEntities(clubId);
  if (!ip) return { ok: false, error: "У клуба нет активного ИП." };
  // Recipient must be an eligible ACTIVE regional director of this club/company — never an
  // arbitrary or archived user. The display name is snapshotted so history survives edits.
  const eligible = await getEligibleRegionalDirectorsForClub(g.companyId, clubId);
  const recipient = eligible.find((r) => r.id === recipientId);
  if (!recipient) return { ok: false, error: "Получатель не является активным региональным директором этого клуба." };

  try {
    const created = await prisma.cashRegionalTransfer.create({
      data: { companyId: g.companyId, clubId, legalEntityId: ip.id, amountKopeks, operationDate, recipientRegionalDirectorId: recipientId, recipientNameSnapshot: recipient.name, comment: comment.slice(0, 500) || null, status: "pending_confirmation", createdById: g.userId, idempotencyKey },
    });
    await recordAudit({ action: "cash.regional_transfer_created", entityType: "CashRegionalTransfer", entityId: created.id, companyId: g.companyId, clubId, userId: g.userId, metadata: { amountKopeks, recipientId } });
    revalidatePath("/collections");
    revalidatePath("/expenses");
    revalidatePath("/dashboard");
    return { ok: true, notice: "Передача создана. Ожидает подтверждения управляющего клуба." };
  } catch (e) {
    // Duplicate submit (same idempotencyKey) is a no-op success, not an error.
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") {
      return { ok: true, notice: "Передача уже создана (повторная отправка)." };
    }
    throw e;
  }
}

/** Confirm receipt (pending_confirmation → confirmed). ONLY an explicit manager of the
 *  transfer's club — a regional director cannot self-confirm; accountant/owner/GD/other-club
 *  users cannot stand in. Idempotent + transactional. Only confirmed affects the balance. */
export async function confirmRegionalTransfer(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  const id = String(formData.get("id") ?? "").trim();
  const g = await ctxForWrite(null);
  if (!g.ok) return { ok: false, error: g.error };
  const row = await prisma.cashRegionalTransfer.findFirst({ where: { id, companyId: g.companyId, clubId: { in: g.clubIds } }, select: { id: true, clubId: true, amountKopeks: true, status: true } });
  if (!row) return { ok: false, error: "Передача не найдена." };
  if (!(await isExplicitClubManager(g.userId, row.clubId))) {
    return { ok: false, error: "Подтвердить передачу может только управляющий этого клуба." };
  }
  const n = await prisma.cashRegionalTransfer.updateMany({ where: { id, status: "pending_confirmation" }, data: { status: "confirmed", confirmedById: g.userId, confirmedAt: new Date() } });
  if (n.count === 0) return { ok: false, error: "Передача уже обработана." };
  await recordAudit({ action: "cash.regional_transfer_confirmed", entityType: "CashRegionalTransfer", entityId: id, companyId: g.companyId, clubId: row.clubId, userId: g.userId, metadata: { amountKopeks: row.amountKopeks } });
  revalidatePath("/collections");
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return { ok: true, notice: "Передача подтверждена. Остаток ИП уменьшен." };
}

/** Cancel a still-pending transfer (pending_confirmation → cancelled). The author or an
 *  explicit club manager may cancel; a CONFIRMED transfer cannot be cancelled (return the
 *  money via «Приход Иное»). Never affects the balance. */
export async function cancelRegionalTransfer(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  const id = String(formData.get("id") ?? "").trim();
  const g = await ctxForWrite(null);
  if (!g.ok) return { ok: false, error: g.error };
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 200) || null;
  const row = await prisma.cashRegionalTransfer.findFirst({ where: { id, companyId: g.companyId, clubId: { in: g.clubIds } }, select: { id: true, clubId: true, createdById: true, status: true } });
  if (!row) return { ok: false, error: "Передача не найдена." };
  const isAuthor = row.createdById === g.userId;
  if (!isAuthor && !(await isExplicitClubManager(g.userId, row.clubId))) {
    return { ok: false, error: "Отменить может автор или управляющий клуба." };
  }
  const n = await prisma.cashRegionalTransfer.updateMany({ where: { id, status: "pending_confirmation" }, data: { status: "cancelled", cancelledById: g.userId, cancelledAt: new Date(), cancellationReason: reason } });
  if (n.count === 0) return { ok: false, error: "Подтверждённую передачу нельзя отменить — верните деньги через «Приход Иное»." };
  await recordAudit({ action: "cash.regional_transfer_cancelled", entityType: "CashRegionalTransfer", entityId: id, companyId: g.companyId, clubId: row.clubId, userId: g.userId, metadata: { reason } });
  revalidatePath("/collections");
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return { ok: true, notice: "Передача отменена." };
}

/** Отмена «Приход Иное» (soft-cancel → status "cancelled"). */
export async function cancelCashOtherIncome(_p: CashState | undefined, formData: FormData): Promise<CashState> {
  const id = String(formData.get("id") ?? "").trim();
  const g = await ctxForWrite(null);
  if (!g.ok) return { ok: false, error: g.error };
  const row = await prisma.cashOtherIncome.findFirst({ where: { id, companyId: g.companyId, clubId: { in: g.clubIds } }, select: { id: true, clubId: true, amountKopeks: true, source: true, status: true, createdByUserId: true } });
  if (!row) return { ok: false, error: "Операция не найдена." };
  const isCreator = row.createdByUserId === g.userId;
  if (!isCreator && !canReviewWithdrawal(g.roles)) return { ok: false, error: "Недостаточно прав для отмены." };
  if (row.status === "approved") return { ok: false, error: "Подтверждённый приход «Иное» нельзя удалить. Создайте корректировку или обратитесь к администратору." };
  if (!CANCELABLE_OTHER_INCOME.includes(row.status)) return { ok: false, error: "Операция уже обработана и не может быть отменена." };
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 200) || null;
  const n = await prisma.cashOtherIncome.updateMany({ where: { id, status: { in: CANCELABLE_OTHER_INCOME } }, data: { status: "cancelled", reviewedByUserId: g.userId, reviewedAt: new Date(), reviewReason: reason } });
  if (n.count === 0) return { ok: false, error: "Операция уже обработана." };
  await recordAudit({ action: "cash.other_income_cancelled", entityType: "CashOtherIncome", entityId: id, companyId: g.companyId, clubId: row.clubId, userId: g.userId, metadata: { amountKopeks: row.amountKopeks, source: row.source, status: "cancelled", reason } });
  revalidatePath("/collections");
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return { ok: true, notice: "Приход «Иное» отменён. Остаток ИП возвращён." };
}

/** Synchronize ИП/ООО cash from ОФД (reuses the safe company sync). Returns SAFE
 * aggregates only — never secrets, tokens, raw fiscal data or personal data. */
async function syncCash(action: "cash.ip_sync" | "cash.ooo_sync"): Promise<CashState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа." };
  const result = await runSyncNowForCompany(ctx.selectedCompanyId);
  await recordAudit({ action, entityType: "OfdConnection", companyId: ctx.selectedCompanyId, userId: ctx.user.id, metadata: { date: result.date, processedConnections: result.processedConnections, succeeded: result.succeeded, failed: result.failed, found: result.totals.foundReceipts, imported: result.totals.importedReceipts, skipped: result.totals.skippedReceipts } });
  revalidatePath("/collections");
  revalidatePath("/expenses");
  if (result.processedConnections === 0) return { ok: true, notice: "ОФД не подключено — синхронизировать нечего." };
  const t = result.totals;
  return { ok: true, notice: `Синхронизация завершена: найдено ${t.foundReceipts}, добавлено ${t.importedReceipts}, пропущено ${t.skippedReceipts}.`, sync: { found: t.foundReceipts, imported: t.importedReceipts, skipped: t.skippedReceipts } };
}
export async function syncIpCashAction(_p: CashState | undefined, _formData: FormData): Promise<CashState> {
  return syncCash("cash.ip_sync");
}
export async function syncOooCashAction(_p: CashState | undefined, _formData: FormData): Promise<CashState> {
  return syncCash("cash.ooo_sync");
}
