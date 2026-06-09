import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import {
  requirePageAccess,
  getCurrentAccessContext,
} from "@/lib/access";
import {
  getInvoiceForContext,
  availableInvoiceActions,
  canEditInvoice,
  INVOICE_ACTION_LABELS,
  INVOICE_STATUS_LABELS,
  INVOICE_CONFIDENCE_LABELS,
} from "@/lib/invoices";
import { EXPENSE_CATEGORY_OPTIONS } from "@/lib/expenses";
import { InvoiceEditForm } from "./_components/InvoiceEditForm";
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
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("invoices");
  const { id } = await params;

  const ctx = await getCurrentAccessContext();
  if (!ctx) notFound();

  const invoice = await getInvoiceForContext(ctx, id);
  if (!invoice) notFound();

  const isManagerOnly = ctx.effectiveRoles.includes("manager") && !ctx.effectiveRoles.some((r) => ["regional_director", "general_director", "owner", "accountant"].includes(r));
  const canCancel =
    ctx.effectiveRoles.some((r) => CANCEL_ROLES.includes(r)) &&
    INVOICE_CANCELABLE.includes(invoice.status) &&
    !(isManagerOnly && invoice.status === "paid");

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
    invoiceNumber: invoice.invoiceNumber ?? "",
    invoiceDate: isoDay(invoice.invoiceDate),
    dueDate: isoDay(invoice.dueDate),
    notes: invoice.notes ?? "",
    status: invoice.status,
    confidence: invoice.confidence,
    clubName: invoice.club.name,
    hasFile: Boolean(invoice.originalFileStorageKey),
    originalFileName: invoice.originalFileName ?? "",
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
          href="/invoices"
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          К списку
        </Link>
      </div>

      <InvoiceEditForm
        invoice={view}
        categories={EXPENSE_CATEGORY_OPTIONS}
        availableActions={availableInvoiceActions(invoice.status, ctx.effectiveRoles)}
        actionLabels={INVOICE_ACTION_LABELS}
        statusLabel={INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}
        canEdit={canEditInvoice(invoice.status, ctx.effectiveRoles)}
      />

      {canCancel ? (
        <div className="mt-6 rounded-lg border border-rose-200 bg-white p-4 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-slate-700">Отмена счёта</div>
          <CancelInvoiceForm invoiceId={invoice.id} />
        </div>
      ) : null}
    </div>
  );
}
