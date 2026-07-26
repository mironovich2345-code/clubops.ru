import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";
import { canReviewPayrollChange } from "@/lib/payroll/access";
import {
  STATUS_LABEL,
  REQUEST_TYPE_LABEL,
  FIELD_TYPE_LABEL,
  OPEN_BLOCKING_STATUSES,
  allowedFieldsForScheme,
  formatFieldValue,
  type HistoryEvent,
  type FieldUnit,
} from "@/lib/payroll/change-request";
import { PayrollNav } from "../../_components/PayrollNav";
import { ReviewActions, AuthorActions, MaterializeButton } from "../../_components/ChangeRequestActions";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const dtFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const toneCls: Record<string, string> = {
  amber: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  sky: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  emerald: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  rose: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  slate: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
};

export default async function ChangeRequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return <NoCompanyState title="Заявка на изменение" description="Согласование зарплаты" />;
  const companyId = ctx.selectedCompanyId;
  const { id } = await params;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);

  const req = await prisma.payrollChangeRequest.findUnique({ where: { id } });
  if (!req || req.companyId !== companyId || !clubIds.includes(req.clubId)) notFound();

  const [employee, calc, requester, reviewer] = await Promise.all([
    req.employeeId ? prisma.clubEmployee.findUnique({ where: { id: req.employeeId }, select: { fullName: true } }) : Promise.resolve(null),
    req.payrollCalculationId ? prisma.payrollCalculation.findUnique({ where: { id: req.payrollCalculationId }, select: { id: true, schemeSnapshotJson: true, payrollPeriodId: true, paidKopeks: true, netPayableKopeks: true } }) : Promise.resolve(null),
    prisma.user.findUnique({ where: { id: req.requestedById }, select: { name: true, email: true } }),
    req.reviewedById ? prisma.user.findUnique({ where: { id: req.reviewedById }, select: { name: true, email: true } }) : Promise.resolve(null),
  ]);

  const clubName = clubs.find((c) => c.id === req.clubId)?.name ?? req.clubId;
  const schemeType = (() => { try { return calc?.schemeSnapshotJson ? (JSON.parse(calc.schemeSnapshotJson) as { schemeType?: string }).schemeType ?? "" : ""; } catch { return ""; } })();
  const spec = req.targetField ? allowedFieldsForScheme(schemeType).find((f) => f.key === req.targetField) : undefined;
  const unit: FieldUnit = req.fieldType === "one_time_bonus" ? "kopeks" : spec?.unit ?? "kopeks";
  const parseJson = (s: string | null) => { if (!s) return undefined; try { return JSON.parse(s); } catch { return undefined; } };
  const oldVal = parseJson(req.oldValueJson);
  const newVal = parseJson(req.proposedValueJson);

  const st = STATUS_LABEL[req.status] ?? { label: req.status, tone: "slate" as const };
  const isOpen = OPEN_BLOCKING_STATUSES.has(req.status);
  const canReview = canReviewPayrollChange(ctx.effectiveRoles) && isOpen && req.requestedById !== user.id;
  const isAuthor = req.requestedById === user.id;
  const canCancel = isAuthor && (req.status === "submitted" || req.status === "under_review" || req.status === "returned_for_revision" || req.status === "draft");
  const canResubmit = isAuthor && req.status === "returned_for_revision";
  // STAGE 12: an approved future scheme change whose version materialization failed can be
  // retried by a reviewer (GD/owner).
  const canMaterialize = canReviewPayrollChange(ctx.effectiveRoles) && req.requestType === "future_scheme_change" && req.status === "approved_pending_scheme_creation";

  const impactSummary = req.impactUncomputable
    ? "Влияние на начисление рассчитать невозможно (нет базы)."
    : req.calculatedImpactKopeks != null
      ? `Влияние на начисление: ${req.calculatedImpactKopeks >= 0 ? "+" : "−"}${formatKopeks(Math.abs(req.calculatedImpactKopeks))}`
      : "Влияние не рассчитано.";

  // Overpay warning (§17): if the calc is already partly paid and the new total drops below
  // what was paid, flag it — do NOT auto-reverse.
  const overpayWarning =
    req.requestType === "period_adjustment" && !req.impactUncomputable && req.calculatedImpactKopeks != null && req.calculatedImpactKopeks < 0 && calc && calc.paidKopeks > 0 && calc.netPayableKopeks + req.calculatedImpactKopeks < calc.paidKopeks;

  const history: HistoryEvent[] = (() => { const h = parseJson(req.historyJson); return Array.isArray(h) ? h : []; })();

  return (
    <div className="mx-auto max-w-[840px]">
      <div className="mb-4">
        <Link href="/payroll/change-requests" className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">← Все согласования</Link>
      </div>
      <PageHeader title={employee?.fullName ?? "Заявка на изменение"} description={`${clubName} · ${REQUEST_TYPE_LABEL[req.requestType] ?? req.requestType}`} />

      <div className={`mb-4 p-5 ${CARD}`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className={`rounded-full px-3 py-1 text-sm font-medium ${toneCls[st.tone]}`}>{st.label}</span>
          <span className="text-xs text-slate-400">Заявка от {dateFmt.format(req.createdAt)}{req.revision > 1 ? ` · редакция ${req.revision}` : ""}</span>
        </div>

        {/* Before / after */}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Параметр">{FIELD_TYPE_LABEL[req.fieldType] ?? req.fieldType}{spec ? ` · ${spec.labelRu}` : ""}</Field>
          <Field label="Было">{req.fieldType === "one_time_bonus" ? "—" : formatFieldValue(unit, oldVal)}</Field>
          <Field label="Станет">{formatFieldValue(unit, newVal)}</Field>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Влияние на начисление">
            {req.impactUncomputable ? (
              <span className="text-amber-600">Невозможно рассчитать влияние</span>
            ) : req.calculatedImpactKopeks != null ? (
              <span className={req.calculatedImpactKopeks >= 0 ? "text-emerald-600" : "text-rose-600"}>{req.calculatedImpactKopeks >= 0 ? "+" : "−"}{formatKopeks(Math.abs(req.calculatedImpactKopeks))}</span>
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </Field>
          {req.effectiveFrom ? <Field label="Действует с">{dateFmt.format(req.effectiveFrom)}</Field> : null}
        </div>

        {overpayWarning ? (
          <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
            Внимание: новое начисление окажется ниже уже выплаченной суммы — возникнет переплата. Автоматического возврата не будет, урегулируйте вручную.
          </div>
        ) : null}

        <div className="mt-4 space-y-2 text-sm">
          <Field label="Причина / обоснование">{req.reason}</Field>
          {req.regionalComment ? <Field label="Комментарий регионала">{req.regionalComment}</Field> : null}
          {req.reviewerComment ? <Field label="Комментарий согласующего">{req.reviewerComment}</Field> : null}
        </div>

        <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-400">
          <span>Автор: {requester?.name ?? requester?.email ?? "—"}</span>
          {reviewer ? <span>Согласующий: {reviewer.name ?? reviewer.email}</span> : null}
          {calc ? <Link href={`/payroll/periods/${calc.payrollPeriodId}/employees/${calc.id}`} className="text-brand-700 hover:underline dark:text-brand-300">→ к расчёту</Link> : null}
        </div>
      </div>

      {/* Actions */}
      {canReview ? (
        <div className={`mb-4 p-5 ${CARD}`}>
          <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Решение</div>
          <ReviewActions requestId={req.id} impactSummary={impactSummary} />
        </div>
      ) : null}

      {(canCancel || canResubmit) ? (
        <div className={`mb-4 p-5 ${CARD}`}>
          <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{canResubmit ? "Доработка" : "Управление заявкой"}</div>
          <AuthorActions requestId={req.id} canResubmit={canResubmit} />
        </div>
      ) : null}

      {canMaterialize ? (
        <div className={`mb-4 p-5 ${CARD}`}>
          <div className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">Создание версии схемы</div>
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">Изменение согласовано, но новая версия схемы ещё не создана. Повторите создание — операция идемпотентна (второй версии не появится).</p>
          <MaterializeButton requestId={req.id} />
        </div>
      ) : null}

      {/* Audit trail */}
      {history.length > 0 ? (
        <div className={`p-5 ${CARD}`}>
          <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">История</div>
          <ol className="space-y-2">
            {history.map((h, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="text-slate-400">{h.at ? dtFmt.format(new Date(h.at)) : ""}</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{ACTION_LABEL[h.action] ?? h.action}</span>
                {h.revision ? <span className="text-slate-400">ред. {h.revision}</span> : null}
                {h.comment ? <span className="text-slate-500">— {h.comment}</span> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  submitted: "Отправлено на согласование",
  resubmitted: "Повторно отправлено",
  returned: "Возвращено на доработку",
  rejected: "Отклонено",
  approved: "Согласовано и применено",
  cancelled: "Отменено",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-sm text-slate-800 dark:text-slate-200">{children}</div>
    </div>
  );
}
