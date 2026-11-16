import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext } from "@/lib/access";
import { getExpenseForContext } from "@/lib/expenses";
import { getRefundForContext } from "@/lib/refunds";
import { refundSlots } from "@/lib/refund-documents";
import { isDemo } from "./config";
import { demoReceiptPdf } from "./document";

/** Explicit safe alternative to real uploads. Ordinary object/author ACL applies.
 * Only this visitor's manager can fill a still-editable synthetic record.
 */
export async function prepareDemoDocuments(kind: string, id: string) {
  if (!isDemo()) return { ok: false, error: "Деморежим отключён" };
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || !ctx.effectiveRoles.includes("manager")) return { ok: false, error: "Нет доступа" };
  const visit = await prisma.demoVisit.findUnique({ where: { companyId: ctx.selectedCompanyId } });
  if (!visit || visit.expiresAt <= new Date() || JSON.parse(visit.usersJson).manager !== ctx.user.id) return { ok: false, error: "Демосеанс истёк" };
  const record = kind === "expense" ? await getExpenseForContext(ctx, id) : kind === "refund" ? await getRefundForContext(ctx, id) : null;
  if (!record || record.createdByUserId !== ctx.user.id || record.entryVersion !== 2 || !["draft", "needs_correction"].includes(record.status)) return { ok: false, error: "Запись недоступна для изменения" };
  const pdf = demoReceiptPdf();
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const scope = { companyId: record.companyId, clubId: record.clubId };
  const doc = { ...scope, originalFilename: "SYNTHETIC-DEMO.pdf", safeFilename: "SYNTHETIC-DEMO.pdf", mimeType: "application/pdf", sizeBytes: pdf.length, sha256, uploadedByUserId: ctx.user.id, storageProvider: "local", verificationStatus: "verified", verifiedAt: new Date() };
  return prisma.$transaction(async tx => {
    if (kind === "expense") {
      const locked = await tx.expense.updateMany({ where: { id, ...scope, createdByUserId: ctx.user.id, status: { in: ["draft", "needs_correction"] } }, data: { updatedAt: new Date() } });
      if (!locked.count) return { ok: false, error: "Статус изменился" };
      if (!await tx.expenseDocument.count({ where: { expenseId: id, removedAt: null } })) await tx.expenseDocument.create({ data: { ...doc, expenseId: id, storageKey: `expense-docs/dede${createHash("sha256").update(id).digest("hex").slice(4)}.pdf` } });
    } else {
      const locked = await tx.refund.updateMany({ where: { id, ...scope, createdByUserId: ctx.user.id, status: { in: ["draft", "needs_correction"] } }, data: {
        clientName: "Демо Клиент (вымышленный)", bankRecipientName: "Демо Получатель (вымышленный)", bankName: "Несуществующий банк (демо)", bankBik: "000000000", bankAccount: "00000000000000000000", bankCorrAccount: "00000000000000000000",
      } });
      if (!locked.count) return { ok: false, error: "Статус изменился" };
      const refund = await tx.refund.findUniqueOrThrow({ where: { id } });
      for (const slot of refundSlots(refund.returnType ?? "")) {
        const activeSlotKey = `${id}:${slot.key}`;
        const storageKey = `refund-docs/dede${createHash("sha256").update(activeSlotKey).digest("hex").slice(4)}.pdf`;
        const slotPdf = demoReceiptPdf(storageKey);
        await tx.refundDocument.upsert({ where: { activeSlotKey }, update: {}, create: { ...doc, sizeBytes: slotPdf.length, sha256: createHash("sha256").update(slotPdf).digest("hex"), refundId: id, documentType: slot.key, activeSlotKey, storageKey } });
      }
    }
    return { ok: true };
  });
}
