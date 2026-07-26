import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { getCurrentAccessContext, hasActiveRegionalApproverForClub, userHasClubRole } from "@/lib/access";
import { canAnyRoleAccessPage, canDownloadDocuments, canMutateOperationalRecords } from "@/lib/auth";
import { formatKopeks } from "@/lib/money";
import { formatUserDisplayName } from "@/lib/user-display";
import {
  getRefundForContext,
  getActiveRefundDocuments,
  getClubActiveLegalEntities,
  parseRefundDocuments,
  REFUND_DOC_TYPE_LABELS,
} from "@/lib/refunds";
import { RefundPayForm } from "../_components/RefundPayForm";
import {
  availableApprovalActions,
  canEditApproval,
  APPROVAL_ACTION_LABELS,
  APPROVAL_STATUS_LABELS,
} from "@/lib/approval";
import { REFUND_V2_STATUS_LABELS } from "@/lib/refund-workflow";
import { refundSlots, REFUND_RETURN_TYPE_LABELS, type RefundReturnType } from "@/lib/refund-documents";
import { fromDate, formatDateOnly } from "@/lib/refund-membership";
import { PT_METHOD_LABELS } from "@/lib/refund-personal-training";
import { safeBackLink } from "@/lib/strategic-return";
import { RefundEditForm } from "./_components/RefundEditForm";
import { RegionalReview } from "../_components/RefundWorkflow";

export const dynamic = "force-dynamic";

function isoDay(date: Date | null): string {
  if (!date) return "";
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, "0"), d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
const fmtD = (dt: Date | null) => (dt ? formatDateOnly(fromDate(dt)) : "—");

export default async function RefundDetailPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};
  const ctx = await getCurrentAccessContext();
  if (!ctx) notFound();
  if (!canAnyRoleAccessPage(ctx.effectiveRoles, "refunds") && !canAnyRoleAccessPage(ctx.effectiveRoles, "analytics")) notFound();

  const refund = await getRefundForContext(ctx, id);
  if (!refund) notFound();
  const back = safeBackLink(sp, { path: "/refunds", label: "К списку" });

  // ---------- v2 review view (read-only + role workflow actions) ----------
  if (refund.entryVersion === 2) {
    const rt = (refund.returnType ?? "membership") as RefundReturnType;
    const active = await getActiveRefundDocuments(id);
    const byType = new Map(active.map((d) => [d.documentType, d]));
    const slots = refundSlots(rt).map((s) => ({ label: s.label, doc: byType.get(s.key) ?? null }));
    const [isRegionalForClub, reviewer, submitter] = await Promise.all([
      userHasClubRole(ctx.user.id, refund.clubId, ["regional_director"]),
      refund.regionalReviewedByUserId ? getUserName(refund.regionalReviewedByUserId) : Promise.resolve(null),
      refund.submittedByManagerId ? getUserName(refund.submittedByManagerId) : Promise.resolve(null),
    ]);
    const isManagerAuthor = ctx.effectiveRoles.includes("manager") && refund.createdByUserId === ctx.user.id;
    const statusLabel = REFUND_V2_STATUS_LABELS[refund.status] ?? refund.status;

    // The accounting contour (accountant/chief) marks an approved refund paid.
    const canPay = ctx.effectiveRoles.includes("accountant") && refund.status === "accounting_in_progress";
    const legalEntities = canPay ? await getClubActiveLegalEntities(refund.clubId, refund.companyId) : [];
    // Paid summary (any viewer in scope): who paid, when, from which legal entity.
    const [paidByName, paidLegalEntity] = refund.status === "paid"
      ? await Promise.all([
          refund.paidByUserId ? getUserName(refund.paidByUserId) : Promise.resolve(null),
          refund.legalEntityId ? getLegalEntityName(refund.legalEntityId) : Promise.resolve(null),
        ])
      : [null, null];

    return (
      <div className="max-w-3xl">
        <div className="mb-4 flex items-center justify-between gap-4">
          <PageHeader title="Возврат" description={`${refund.club.name} · ${statusLabel}`} />
          <Link href={back.href} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">{back.label}</Link>
        </div>

        {sp.submitted === "1" ? (
          <div className="mb-4 rounded-md bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
            Возврат создан и отправлен региональному директору на проверку.
          </div>
        ) : null}

        {/* needs_correction banner for the author */}
        {refund.status === "needs_correction" ? (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            <div className="font-semibold">Региональный директор вернул возврат на исправление</div>
            {refund.regionalCorrectionComment ? <p className="mt-1 whitespace-pre-wrap">{refund.regionalCorrectionComment}</p> : null}
            <p className="mt-1 text-xs text-amber-700">{reviewer ? `Вернул: ${reviewer}` : ""}{refund.regionalReviewedAt ? ` · ${fmtD(refund.regionalReviewedAt)}` : ""}</p>
            {isManagerAuthor ? <div className="mt-3"><Link href={`/refunds/new/${id}`} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Продолжить исправление</Link></div> : null}
          </div>
        ) : null}

        <Section title="Общая информация">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
            <Row label="Клиент" value={refund.clientName ?? "—"} />
            <Row label="Клуб" value={refund.club.name} />
            <Row label="Тип возврата" value={REFUND_RETURN_TYPE_LABELS[rt]} />
            <Row label="Статус" value={statusLabel} />
            <Row label="Отправил" value={submitter ?? "—"} />
            <Row label="Дата отправки" value={fmtD(refund.regionalReviewRequestedAt)} />
            {refund.regionalReviewedAt ? <Row label="Согласовал/вернул" value={reviewer ?? "—"} /> : null}
            {refund.accountingStartedAt ? <Row label="Передан в бухгалтерию" value={fmtD(refund.accountingStartedAt)} /> : null}
          </dl>
        </Section>

        <Section title="Документы">
          <ul className="divide-y divide-slate-100">
            {slots.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="text-slate-700">{s.label}</span>
                {s.doc ? (
                  <a href={`/api/refunds/${id}/file?key=${encodeURIComponent(s.doc.storageKey)}`} target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:text-brand-700">{s.doc.originalFilename} · Открыть</a>
                ) : <span className="text-rose-600">не загружен</span>}
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Реквизиты для возврата">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
            <Row label="ФИО получателя" value={refund.bankRecipientName ?? "—"} />
            <Row label="Банк" value={refund.bankName ?? "—"} />
            <Row label="БИК" value={refund.bankBik ?? "—"} />
            <Row label="Расчётный счёт" value={refund.bankAccount ?? "—"} />
            <Row label="Корреспондентский счёт" value={refund.bankCorrAccount ?? "—"} />
          </dl>
        </Section>

        <Section title="Расчёт">
          {rt === "membership" ? (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
              <Row label="Дата начала" value={fmtD(refund.serviceStartDate)} />
              <Row label="Дата окончания" value={fmtD(refund.serviceEndDate)} />
              <Row label="Дата заявления" value={fmtD(refund.applicationDate)} />
              <Row label="Сумма договора" value={money(refund.contractAmountKopeks)} />
              <Row label="Общий срок" value={refund.serviceDurationDays != null ? `${refund.serviceDurationDays} дн.` : "—"} />
              <Row label="Оставшиеся дни" value={refund.refundableDays != null ? `${refund.refundableDays} дн.` : "—"} />
              <Row label="Плановая дата возврата" value={fmtD(refund.plannedRefundDate)} />
              {refund.dueDateAdjustmentReason ? <Row label="Перенос" value={refund.dueDateAdjustmentReason} /> : null}
            </dl>
          ) : (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
              <Row label="Тренер" value={refund.ptTrainerNameSnapshot ?? "—"} />
              <Row label="Дата заявления" value={fmtD(refund.applicationDate)} />
              <Row label="Сумма договора" value={money(refund.contractAmountKopeks)} />
              <Row label="Куплено тренировок" value={refund.ptContractSessionCount != null ? String(refund.ptContractSessionCount) : "—"} />
              <Row label="Проведено" value={refund.ptUsedSessionCount != null ? String(refund.ptUsedSessionCount) : "—"} />
              <Row label="Стоимость при расторжении" value={money(refund.ptTerminationSessionPriceKopeks)} />
              <Row label="Способ расчёта" value={refund.ptCalculationMethod ? (PT_METHOD_LABELS[refund.ptCalculationMethod as keyof typeof PT_METHOD_LABELS] ?? refund.ptCalculationMethod) : "—"} />
              <Row label="Плановая дата возврата" value={fmtD(refund.plannedRefundDate)} />
              {refund.ptAlternativeCalculationReason ? <Row label="Обоснование" value={refund.ptAlternativeCalculationReason} /> : null}
              {refund.dueDateAdjustmentReason ? <Row label="Перенос" value={refund.dueDateAdjustmentReason} /> : null}
            </dl>
          )}
          {refund.ptRefundUnavailableReason ? (
            <div className="mt-3 rounded-md border border-rose-300 bg-rose-50 p-3">
              <div className="text-sm font-semibold text-rose-800">Возврат не принимается</div>
              {refund.ptRefusalDraftText ? <p className="mt-1 whitespace-pre-wrap text-sm text-rose-700">{refund.ptRefusalDraftText}</p> : null}
            </div>
          ) : (
            <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2">
              <div className="text-xs text-emerald-700">Итоговая сумма возврата</div>
              <div className="text-xl font-semibold text-emerald-800">{money(refund.refundResultAmountKopeks ?? refund.amountKopeks)}</div>
            </div>
          )}
        </Section>

        {/* Regional decision (only a regional director of this club, only while pending). */}
        {refund.status === "pending_regional_review" && isRegionalForClub ? <RegionalReview refundId={id} /> : null}

        {/* Accountant pays; everyone else in scope sees the awaiting-payment notice. */}
        {refund.status === "accounting_in_progress" && canPay ? (
          <RefundPayForm
            refundId={id}
            amountLabel={money(refund.refundResultAmountKopeks ?? refund.amountKopeks)}
            legalEntities={legalEntities}
            todayIso={isoDay(new Date())}
          />
        ) : refund.status === "accounting_in_progress" ? (
          <div className="mt-6 rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            Возврат согласован и ожидает оплаты бухгалтером.
          </div>
        ) : null}

        {/* Paid summary (read-only) — visible to any viewer in scope. */}
        {refund.status === "paid" ? (
          <Section title="Оплата">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
              <Row label="Статус" value="Оплачено" />
              <Row label="Дата оплаты" value={fmtD(refund.paidAt)} />
              <Row label="Юридическое лицо" value={paidLegalEntity ?? "—"} />
              <Row label="Отметил оплату" value={paidByName ?? "—"} />
              {refund.paymentComment ? <Row label="Комментарий" value={refund.paymentComment} /> : null}
            </dl>
          </Section>
        ) : null}
      </div>
    );
  }

  // ---------- legacy (v1) view ----------
  const documents = parseRefundDocuments(refund.documentsJson).map((d) => ({
    storageKey: d.storageKey, fileName: d.fileName, typeLabel: REFUND_DOC_TYPE_LABELS[d.type] ?? d.type,
  }));
  const view = {
    id: refund.id, clientName: refund.clientName ?? "", clientPhone: refund.clientPhone ?? "",
    amount: (refund.amountKopeks / 100).toString(), currency: refund.currency, reason: refund.reason ?? "",
    contractNumber: refund.contractNumber ?? "", refundDate: isoDay(refund.refundDate),
    bankRecipientName: refund.bankRecipientName ?? "", bankName: refund.bankName ?? "", bankBik: refund.bankBik ?? "",
    bankAccount: refund.bankAccount ?? "", notes: refund.notes ?? "", clubName: refund.club.name, documents,
    canDownload: canDownloadDocuments(ctx.effectiveRoles),
  };
  const hasActiveRegional = await hasActiveRegionalApproverForClub(refund.companyId, refund.clubId);
  const approvalOpts = { hasActiveRegional, isCreator: refund.createdByUserId === ctx.user.id };
  const expectedApprover = refund.status === "needs_review" ? (hasActiveRegional ? "Ожидает согласования регионального директора" : "Региональный директор не назначен — ожидает главного бухгалтера") : null;
  const canEdit = canMutateOperationalRecords(ctx.effectiveRoles) && canEditApproval(refund.status, ctx.effectiveRoles);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <PageHeader title="Возврат" description={`${view.clubName} · ${APPROVAL_STATUS_LABELS[refund.status] ?? refund.status}`} />
        <Link href={back.href} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">{back.label}</Link>
      </div>
      {expectedApprover ? <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">{expectedApprover}</div> : null}
      <RefundEditForm
        refund={view}
        availableActions={availableApprovalActions(refund.status, ctx.effectiveRoles, approvalOpts)}
        actionLabels={APPROVAL_ACTION_LABELS}
        statusLabel={APPROVAL_STATUS_LABELS[refund.status] ?? refund.status}
        canEdit={canEdit}
      />
    </div>
  );
}

async function getUserName(userId: string): Promise<string | null> {
  const { prisma } = await import("@/lib/prisma");
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, firstName: true, lastName: true, deletedAt: true } });
  return u ? formatUserDisplayName(u) : null;
}
async function getLegalEntityName(legalEntityId: string): Promise<string | null> {
  const { prisma } = await import("@/lib/prisma");
  const le = await prisma.legalEntity.findUnique({ where: { id: legalEntityId }, select: { name: true, shortName: true } });
  return le ? (le.shortName || le.name) : null;
}
const money = (k: number | null | undefined) => (k != null ? formatKopeks(k) : "—");

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2 text-sm font-semibold text-slate-700">{title}</div>
      {children}
    </div>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return <div><dt className="inline text-slate-500">{label}: </dt><dd className="inline text-slate-800">{value}</dd></div>;
}
