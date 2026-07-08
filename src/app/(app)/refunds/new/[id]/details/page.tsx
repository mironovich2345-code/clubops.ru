import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { canCreateOperational } from "@/lib/auth";
import { getRefundForContext, getActiveRefundDocuments, getClubTrainers } from "@/lib/refunds";
import { isRefundDocumentSetComplete, hasCompleteRequisites, REFUND_RETURN_TYPE_LABELS, type RefundReturnType } from "@/lib/refund-documents";
import { fromDate, diffDays } from "@/lib/refund-membership";
import { refundSubmissionReadiness } from "@/lib/refund-workflow";
import { prisma } from "@/lib/prisma";
import { formatUserDisplayName } from "@/lib/user-display";
import { MembershipCalcForm } from "../../../_components/MembershipCalcForm";
import { PtCalcForm } from "../../../_components/PtCalcForm";
import { SubmitToRegional } from "../../../_components/RefundWorkflow";

export const dynamic = "force-dynamic";

const iso = (dt: Date) => { const v = fromDate(dt); return `${v.y}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`; };
const rub = (k: number | null | undefined) => (k != null ? (k / 100).toFixed(2) : "");

export default async function RefundDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess("refunds");
  const { id } = await params;
  const ctx = await getCurrentAccessContext();
  if (!ctx) redirect("/login");

  const refund = await getRefundForContext(ctx, id);
  if (!refund || refund.entryVersion !== 2) redirect(refund ? `/refunds/${id}` : "/refunds");
  // Editable calculation step only while draft or returned for correction; once
  // sent/approved it opens read-only in the record view.
  if (refund.status !== "draft" && refund.status !== "needs_correction") redirect(`/refunds/${id}`);
  const isCreator = refund.createdByUserId === ctx.user.id;
  const isRegional = ctx.effectiveRoles.includes("regional_director");
  if (!canCreateOperational(ctx.effectiveRoles) || (!isCreator && !isRegional)) redirect("/refunds");

  const backHref = `/refunds/new/${id}`;
  const rt = refund.returnType;
  if (rt !== "membership" && rt !== "personal_training") redirect(backHref);

  // Correction banner (regional returned it) + submit bar (manager-author only).
  const correctionReviewer = refund.status === "needs_correction" && refund.regionalReviewedByUserId
    ? await prisma.user.findUnique({ where: { id: refund.regionalReviewedByUserId }, select: { name: true, firstName: true, lastName: true, deletedAt: true } })
    : null;
  const correctionBanner = refund.status === "needs_correction" ? (
    <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="font-semibold">Региональный директор вернул возврат на исправление</div>
      {refund.regionalCorrectionComment ? <p className="mt-1 whitespace-pre-wrap">{refund.regionalCorrectionComment}</p> : null}
      <p className="mt-1 text-xs text-amber-700">
        {correctionReviewer ? `Вернул: ${formatUserDisplayName(correctionReviewer)}` : ""}
        {refund.regionalReviewedAt ? ` · ${refund.regionalReviewedAt.toLocaleDateString("ru-RU")}` : ""}
      </p>
    </div>
  ) : null;

  // Shared prerequisites: full document set (per type) + valid requisites.
  const active = await getActiveRefundDocuments(id);
  const docsComplete = isRefundDocumentSetComplete(rt, active.map((d) => d.documentType));
  const requisitesOk = hasCompleteRequisites(refund);
  const title = rt === "membership" ? "Расчёт возврата по абонементу" : "Расчёт возврата по персональным тренировкам";
  if (!docsComplete || !requisitesOk) {
    return (
      <div>
        <PageHeader title={title} description="Черновик" />
        {correctionBanner}
        <div className="mt-4 max-w-2xl rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800 shadow-sm">
          <p>{!docsComplete ? "Загружены не все обязательные документы." : "Банковские реквизиты заполнены не полностью."}</p>
          <div className="mt-4"><Link href={backHref} className="rounded-md border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100">Вернуться к предыдущему шагу</Link></div>
        </div>
      </div>
    );
  }

  const info = { clientName: refund.clientName ?? "—", clubName: refund.club.name, returnTypeLabel: REFUND_RETURN_TYPE_LABELS[rt as RefundReturnType], docsComplete, requisitesOk };
  // Submit bar — only the manager-author sees it; readiness re-checked on the server.
  const isManagerAuthor = ctx.effectiveRoles.includes("manager") && isCreator;
  const ready = refundSubmissionReadiness(refund, active.map((d) => d.documentType));
  const submitBar = isManagerAuthor ? <SubmitToRegional refundId={id} ready={ready.ok} readyError={ready.ok ? null : ready.error} /> : null;

  // ---- Personal training ----
  if (rt === "personal_training") {
    const trainers = (await getClubTrainers(refund.clubId)).map((t) => ({ id: t.id, fullName: t.fullName, dismissed: t.status === "dismissed" }));
    const ptDefaults = {
      applicationDate: refund.applicationDate ? iso(refund.applicationDate) : "",
      contractAmountRub: rub(refund.contractAmountKopeks),
      terminationPriceRub: rub(refund.ptTerminationSessionPriceKopeks),
      contractSessions: refund.ptContractSessionCount != null ? String(refund.ptContractSessionCount) : "",
      usedSessions: refund.ptUsedSessionCount != null ? String(refund.ptUsedSessionCount) : "",
      serviceNotProvided: refund.serviceNotProvided,
      calculationMethod: refund.ptCalculationMethod === "average_rate" ? "average_rate" : "contract_rate",
      alternativeReason: refund.ptAlternativeCalculationReason ?? "",
      trainerEmployeeId: refund.ptTrainerEmployeeId ?? "",
    };
    let ptResult: null | {
      mode: "not_provided" | "contract_rate" | "average_rate"; unavailable: boolean;
      contractAmountKopeks: number; trainerName: string; contractSessions: number; usedSessions: number;
      perSessionKopeks: number; usedAmountKopeks: number; preRoundKopeks: number; resultAmountKopeks: number | null;
      baseDate: string | null; plannedDate: string | null; adjustmentReason: string | null;
      reasonComment: string | null; refusalDraftText: string | null; unavailableReason: string | null; zeroRemaining: boolean;
    } = null;
    if ((refund.calculationVersion ?? "").startsWith("pt_")) {
      const mode = (refund.ptCalculationMethod ?? "contract_rate") as "not_provided" | "contract_rate" | "average_rate";
      const unavailable = refund.ptRefundUnavailableReason != null;
      const X = refund.contractAmountKopeks ?? 0, N = refund.ptContractSessionCount ?? 0, E = refund.ptUsedSessionCount ?? 0, V = refund.ptTerminationSessionPriceKopeks ?? 0;
      const raw = refund.ptRawResultKopeks ?? 0;
      ptResult = {
        mode, unavailable,
        contractAmountKopeks: X, trainerName: refund.ptTrainerNameSnapshot ?? "—",
        contractSessions: N, usedSessions: E,
        perSessionKopeks: mode === "average_rate" ? (N > 0 ? Math.floor(X / N) : 0) : V,
        usedAmountKopeks: mode === "contract_rate" ? V * E : X - raw,
        preRoundKopeks: raw,
        resultAmountKopeks: refund.refundResultAmountKopeks,
        baseDate: refund.baseRefundDueDate ? iso(refund.baseRefundDueDate) : null,
        plannedDate: refund.plannedRefundDate ? iso(refund.plannedRefundDate) : null,
        adjustmentReason: refund.dueDateAdjustmentReason,
        reasonComment: refund.ptAlternativeCalculationReason,
        refusalDraftText: refund.ptRefusalDraftText,
        unavailableReason: refund.ptRefundUnavailableReason,
        zeroRemaining: !unavailable && refund.refundResultAmountKopeks === 0,
      };
    }
    return (
      <div>
        <PageHeader title={title} description="Черновик" />
        {correctionBanner}
        <PtCalcForm refundId={id} expectedUpdatedAt={refund.updatedAt.toISOString()} info={info} trainers={trainers} defaults={ptDefaults} result={ptResult} backHref={backHref} />
        {submitBar}
      </div>
    );
  }

  // ---- Membership ----
  const defaults = {
    serviceStartDate: refund.serviceStartDate ? iso(refund.serviceStartDate) : "",
    serviceEndDate: refund.serviceEndDate ? iso(refund.serviceEndDate) : "",
    applicationDate: refund.applicationDate ? iso(refund.applicationDate) : "",
    contractAmountRub: rub(refund.contractAmountKopeks),
    serviceNotProvided: refund.serviceNotProvided,
  };
  let result = null as null | {
    mode: "formula" | "before_start" | "not_provided"; durationDays: number; refundableDays: number | null;
    contractAmountKopeks: number; dayPriceKopeksApprox: number; preRoundKopeks: number; resultAmountKopeks: number;
    baseDate: string | null; plannedDate: string | null; adjustmentReason: string | null; durationWarning: boolean; zeroRemaining: boolean;
  };
  if (refund.calculationVersion === "membership_v1" && refund.refundResultAmountKopeks != null && refund.contractAmountKopeks != null && refund.serviceStartDate && refund.serviceEndDate && refund.applicationDate) {
    const T = refund.serviceDurationDays ?? diffDays(fromDate(refund.serviceEndDate), fromDate(refund.serviceStartDate));
    const appBeforeStart = diffDays(fromDate(refund.serviceStartDate), fromDate(refund.applicationDate)) > 0;
    const mode = refund.serviceNotProvided ? "not_provided" : appBeforeStart ? "before_start" : "formula";
    const P = refund.refundableDays;
    const preRound = mode === "formula" && P != null && T > 0 ? Math.round((refund.contractAmountKopeks * P) / T) : refund.contractAmountKopeks;
    result = {
      mode, durationDays: T, refundableDays: P, contractAmountKopeks: refund.contractAmountKopeks,
      dayPriceKopeksApprox: T > 0 ? Math.round(refund.contractAmountKopeks / T) : 0,
      preRoundKopeks: preRound, resultAmountKopeks: refund.refundResultAmountKopeks,
      baseDate: refund.baseRefundDueDate ? iso(refund.baseRefundDueDate) : null,
      plannedDate: refund.plannedRefundDate ? iso(refund.plannedRefundDate) : null,
      adjustmentReason: refund.dueDateAdjustmentReason, durationWarning: !(T === 30 || T === 31),
      zeroRemaining: mode === "formula" && refund.refundResultAmountKopeks === 0,
    };
  }
  return (
    <div>
      <PageHeader title={title} description="Черновик" />
      {correctionBanner}
      <MembershipCalcForm refundId={id} expectedUpdatedAt={refund.updatedAt.toISOString()} info={info} defaults={defaults} result={result} backHref={backHref} />
      {submitBar}
    </div>
  );
}
