import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { getCurrentAccessContext, hasActiveRegionalApproverForClub } from "@/lib/access";
import { canAnyRoleAccessPage, canDownloadDocuments, canMutateOperationalRecords } from "@/lib/auth";
import {
  getInvoiceForContext,
  availableInvoiceActions,
  canEditInvoice,
  canReviewInvoiceData,
  isLowConfidence,
  parseInvoiceWarnings,
  invoiceExpensePeriod,
  formatExpensePeriod,
  INVOICE_ACTION_LABELS,
  INVOICE_STATUS_LABELS,
  INVOICE_CONFIDENCE_LABELS,
} from "@/lib/invoices";
import { prisma } from "@/lib/prisma";
import { resolveInvoiceFileStatus } from "@/lib/invoice-storage";
import { EXPENSE_CATEGORY_OPTIONS } from "@/lib/expenses";
import { safeBackLink } from "@/lib/strategic-return";
import { InvoiceEditForm } from "./_components/InvoiceEditForm";
import { InvoiceDataReview, type InvoiceReviewView } from "./_components/InvoiceDataReview";
import { CancelInvoiceForm } from "./_components/CancelInvoiceForm";

const INVOICE_CANCELABLE = ["draft", "needs_review", "approved_by_regional", "approved_by_owner", "paid"];
const CANCEL_ROLES = ["manager", "regional_director", "general_director", "owner", "accountant"];

export const dynamic = "force-dynamic";

function isoDay(date: Date | null): string {
  if (!date) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};
  const back = safeBackLink(sp, { path: "/invoices", label: "К списку" });

  const ctx = await getCurrentAccessContext();
  if (!ctx) notFound();
  // Viewable by anyone with invoices OR payments access (the payment calendar
  // links here). Scope is still enforced by getInvoiceForContext.
  if (!canAnyRoleAccessPage(ctx.effectiveRoles, "invoices") && !canAnyRoleAccessPage(ctx.effectiveRoles, "payments")) {
    notFound();
  }

  const invoice = await getInvoiceForContext(ctx, id);
  if (!invoice) notFound();

  // Document availability is resolved separately from the invoice — a missing or
  // never-attached file must NEVER 404 the card; it only changes the file block.
  const fileStatus = await resolveInvoiceFileStatus(invoice.originalFileStorageKey);

  const isManagerOnly = ctx.effectiveRoles.includes("manager") && !ctx.effectiveRoles.some((r) => ["regional_director", "general_director", "owner", "accountant"].includes(r));
  const canCancel =
    canMutateOperationalRecords(ctx.effectiveRoles) &&
    ctx.effectiveRoles.some((r) => CANCEL_ROLES.includes(r)) &&
    INVOICE_CANCELABLE.includes(invoice.status) &&
    !(isManagerOnly && invoice.status === "paid");

  // Approver routing (live): who is expected to approve, and the action context.
  const hasActiveRegional = await hasActiveRegionalApproverForClub(invoice.companyId, invoice.clubId);
  const approvalOpts = { hasActiveRegional, isCreator: invoice.createdByUserId === ctx.user.id };
  const expectedApprover =
    invoice.status === "needs_review"
      ? hasActiveRegional
        ? "Ожидает согласования регионального директора"
        : "Региональный директор не назначен — ожидает главного бухгалтера"
      : invoice.status === "needs_correction"
        ? "Возвращён управляющему на исправление"
        : null;
  const correctionRequestedAtLabel = invoice.correctionRequestedAt
    ? isoDay(invoice.correctionRequestedAt).split("-").reverse().join(".")
    : "";

  const view = {
    id: invoice.id,
    counterpartyName: invoice.counterpartyName ?? "",
    counterpartyInn: invoice.counterpartyInn ?? "",
    counterpartyKpp: invoice.counterpartyKpp ?? "",
    counterpartyBankName: invoice.counterpartyBankName ?? "",
    counterpartyBankBik: invoice.counterpartyBankBik ?? "",
    counterpartyAccount: invoice.counterpartyAccount ?? "",
    counterpartyCorrAccount: invoice.counterpartyCorrAccount ?? "",
    amount: (invoice.amountKopeks / 100).toString(),
    currency: invoice.currency,
    expenseCategory: invoice.expenseCategory ?? "",
    expensePeriod: invoiceExpensePeriod(invoice),
    expensePeriodLabel: formatExpensePeriod(invoiceExpensePeriod(invoice)),
    paidAtLabel: invoice.paidAt ? isoDay(invoice.paidAt).split("-").reverse().join(".") : "—",
    invoiceNumber: invoice.invoiceNumber ?? "",
    invoiceDate: isoDay(invoice.invoiceDate),
    dueDate: isoDay(invoice.dueDate),
    notes: invoice.notes ?? "",
    status: invoice.status,
    confidence: invoice.confidence,
    clubName: invoice.club.name,
    fileStatus,
    correctionComment: invoice.correctionComment ?? "",
    correctionRequestedAtLabel,
    originalFileName: invoice.originalFileName ?? "",
    // Accounting contour only: explicit download (attachment). Others view inline.
    canDownload: canDownloadDocuments(ctx.effectiveRoles),
  };

  // --- AI data review block ("Данные счёта") ---------------------------------
  // Low confidence + not yet reviewed → the low-confidence payment guard is armed:
  // the "Отметить оплачено" action is hidden here (and refused server-side).
  const reviewed = Boolean(invoice.aiDataReviewedAt);
  const isLow = isLowConfidence(invoice.confidence);
  const payBlocked = isLow && !reviewed;
  const canReviewData = canReviewInvoiceData(ctx.effectiveRoles);
  const reviewer = invoice.aiDataReviewedById
    ? await prisma.user.findUnique({ where: { id: invoice.aiDataReviewedById }, select: { name: true } })
    : null;
  const availableActions = availableInvoiceActions(invoice.status, ctx.effectiveRoles, approvalOpts).filter(
    (a) => !(a === "pay" && payBlocked),
  );

  const reviewView: InvoiceReviewView = {
    id: invoice.id,
    counterpartyName: view.counterpartyName,
    counterpartyInn: view.counterpartyInn,
    counterpartyKpp: view.counterpartyKpp,
    counterpartyBankName: view.counterpartyBankName,
    counterpartyBankBik: view.counterpartyBankBik,
    counterpartyAccount: view.counterpartyAccount,
    counterpartyCorrAccount: view.counterpartyCorrAccount,
    payerName: invoice.payerName ?? "",
    payerInn: invoice.payerInn ?? "",
    payerKpp: invoice.payerKpp ?? "",
    subject: invoice.subject ?? "",
    amount: view.amount,
    currency: view.currency,
    expenseCategory: view.expenseCategory,
    expensePeriod: view.expensePeriod,
    invoiceNumber: view.invoiceNumber,
    invoiceDate: view.invoiceDate,
    dueDate: view.dueDate,
    aiDataReviewNote: invoice.aiDataReviewNote ?? "",
    confidence: invoice.confidence,
    confidenceLabel: INVOICE_CONFIDENCE_LABELS[invoice.confidence] ?? invoice.confidence,
    isLowConfidence: isLow,
    warnings: parseInvoiceWarnings(invoice.rawExtractedJson),
    reviewedAtLabel: invoice.aiDataReviewedAt ? isoDay(invoice.aiDataReviewedAt).split("-").reverse().join(".") : "",
    reviewedByName: reviewer?.name ?? "",
    payBlocked,
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <PageHeader
          title="Счёт"
          description={`${view.clubName} · уверенность распознавания: ${
            INVOICE_CONFIDENCE_LABELS[view.confidence] ?? view.confidence
          }`}
        />
        <Link
          href={back.href}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          {back.label}
        </Link>
      </div>

      {expectedApprover ? (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {expectedApprover}
        </div>
      ) : null}

      {invoice.status === "needs_correction" && view.correctionComment ? (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <div className="font-semibold">Возвращён на исправление{view.correctionRequestedAtLabel ? ` · ${view.correctionRequestedAtLabel}` : ""}</div>
          <div className="mt-1 whitespace-pre-wrap">{view.correctionComment}</div>
        </div>
      ) : null}

      <InvoiceEditForm
        invoice={view}
        categories={EXPENSE_CATEGORY_OPTIONS}
        availableActions={availableActions}
        actionLabels={INVOICE_ACTION_LABELS}
        statusLabel={INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}
        canEdit={
          canMutateOperationalRecords(ctx.effectiveRoles) &&
          canEditInvoice(invoice.status, ctx.effectiveRoles) &&
          // Unpaid invoices: only the author edits fields (regional reviews, does
          // not edit). Paid invoices: the accountant edits (canEditInvoice above).
          (invoice.status === "paid" || invoice.createdByUserId === ctx.user.id)
        }
        // The author may (re)upload/replace the document only while the invoice is
        // a draft or was returned for correction — never in review/approved/paid.
        canReplaceFile={
          canMutateOperationalRecords(ctx.effectiveRoles) &&
          invoice.createdByUserId === ctx.user.id &&
          (invoice.status === "draft" || invoice.status === "needs_correction")
        }
      />

      <div className="mt-6">
        <InvoiceDataReview
          invoice={reviewView}
          categories={EXPENSE_CATEGORY_OPTIONS}
          canReview={canReviewData}
        />
      </div>

      {canCancel ? (
        <div className="mt-6 rounded-lg border border-rose-200 bg-white p-4 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-slate-700">Отмена счёта</div>
          <CancelInvoiceForm invoiceId={invoice.id} />
        </div>
      ) : null}
    </div>
  );
}
