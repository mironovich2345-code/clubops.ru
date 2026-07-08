import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { canCreateOperational } from "@/lib/auth";
import { getRefundForContext, getActiveRefundDocuments } from "@/lib/refunds";
import { isRefundDocumentSetComplete, hasCompleteRequisites, REFUND_RETURN_TYPE_LABELS, type RefundReturnType } from "@/lib/refund-documents";
import { fromDate, diffDays } from "@/lib/refund-membership";
import { MembershipCalcForm } from "../../../_components/MembershipCalcForm";

export const dynamic = "force-dynamic";

const iso = (dt: Date) => { const v = fromDate(dt); return `${v.y}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`; };

export default async function RefundDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess("refunds");
  const { id } = await params;
  const ctx = await getCurrentAccessContext();
  if (!ctx) redirect("/login");

  const refund = await getRefundForContext(ctx, id);
  if (!refund || refund.entryVersion !== 2 || refund.status !== "draft") redirect(refund ? `/refunds/${id}` : "/refunds");
  const isCreator = refund.createdByUserId === ctx.user.id;
  const isRegional = ctx.effectiveRoles.includes("regional_director");
  if (!canCreateOperational(ctx.effectiveRoles) || (!isCreator && !isRegional)) redirect("/refunds");

  const backHref = `/refunds/new/${id}`;

  // Personal training: dedicated stub (no membership form).
  if (refund.returnType === "personal_training") {
    return (
      <div>
        <PageHeader title="Расчёт возврата" description="Персональные тренировки" />
        <div className="mt-4 max-w-2xl rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
          <p>Расчёт возврата по персональным тренировкам будет доступен после реализации следующего этапа.</p>
          <div className="mt-4"><Link href={backHref} className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Назад к документам</Link></div>
        </div>
      </div>
    );
  }
  if (refund.returnType !== "membership") redirect(backHref);

  // Prerequisites: full document set + valid requisites.
  const active = await getActiveRefundDocuments(id);
  const docsComplete = isRefundDocumentSetComplete("membership", active.map((d) => d.documentType));
  const requisitesOk = hasCompleteRequisites(refund);
  if (!docsComplete || !requisitesOk) {
    return (
      <div>
        <PageHeader title="Расчёт возврата по абонементу" description="Черновик" />
        <div className="mt-4 max-w-2xl rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800 shadow-sm">
          <p>{!docsComplete ? "Загружены не все обязательные документы." : "Банковские реквизиты заполнены не полностью."}</p>
          <div className="mt-4"><Link href={backHref} className="rounded-md border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100">Вернуться к предыдущему шагу</Link></div>
        </div>
      </div>
    );
  }

  const defaults = {
    serviceStartDate: refund.serviceStartDate ? iso(refund.serviceStartDate) : "",
    serviceEndDate: refund.serviceEndDate ? iso(refund.serviceEndDate) : "",
    applicationDate: refund.applicationDate ? iso(refund.applicationDate) : "",
    contractAmountRub: refund.contractAmountKopeks != null ? (refund.contractAmountKopeks / 100).toFixed(2) : "",
    serviceNotProvided: refund.serviceNotProvided,
  };

  // Server-derived result card (from stored values — reproducible, never client).
  let result = null as null | {
    mode: "formula" | "before_start" | "not_provided"; durationDays: number; refundableDays: number | null;
    contractAmountKopeks: number; dayPriceKopeksApprox: number; preRoundKopeks: number; resultAmountKopeks: number;
    baseDate: string | null; plannedDate: string | null; adjustmentReason: string | null; durationWarning: boolean; zeroRemaining: boolean;
  };
  if (refund.calculationVersion && refund.refundResultAmountKopeks != null && refund.contractAmountKopeks != null && refund.serviceStartDate && refund.serviceEndDate && refund.applicationDate) {
    const T = refund.serviceDurationDays ?? diffDays(fromDate(refund.serviceEndDate), fromDate(refund.serviceStartDate));
    const appBeforeStart = diffDays(fromDate(refund.serviceStartDate), fromDate(refund.applicationDate)) > 0;
    const mode = refund.serviceNotProvided ? "not_provided" : appBeforeStart ? "before_start" : "formula";
    const P = refund.refundableDays;
    const preRound = mode === "formula" && P != null && T > 0 ? Math.round((refund.contractAmountKopeks * P) / T) : refund.contractAmountKopeks;
    result = {
      mode, durationDays: T, refundableDays: P,
      contractAmountKopeks: refund.contractAmountKopeks,
      dayPriceKopeksApprox: T > 0 ? Math.round(refund.contractAmountKopeks / T) : 0,
      preRoundKopeks: preRound, resultAmountKopeks: refund.refundResultAmountKopeks,
      baseDate: refund.baseRefundDueDate ? iso(refund.baseRefundDueDate) : null,
      plannedDate: refund.plannedRefundDate ? iso(refund.plannedRefundDate) : null,
      adjustmentReason: refund.dueDateAdjustmentReason,
      durationWarning: !(T === 30 || T === 31),
      zeroRemaining: mode === "formula" && refund.refundResultAmountKopeks === 0,
    };
  }

  return (
    <div>
      <PageHeader title="Расчёт возврата по абонементу" description="Черновик" />
      <MembershipCalcForm
        refundId={id}
        expectedUpdatedAt={refund.updatedAt.toISOString()}
        info={{ clientName: refund.clientName ?? "—", clubName: refund.club.name, returnTypeLabel: REFUND_RETURN_TYPE_LABELS[refund.returnType as RefundReturnType], docsComplete, requisitesOk }}
        defaults={defaults}
        result={result}
        backHref={backHref}
      />
    </div>
  );
}
