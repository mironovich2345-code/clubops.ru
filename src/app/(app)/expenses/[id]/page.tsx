import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { canCreateOperational, canDownloadDocuments, canMutateOperationalRecords } from "@/lib/auth";
import {
  getExpenseForContext,
  expenseStatusLabel,
  isExpenseCancelable,
  EXPENSE_CATEGORY_OPTIONS,
  EXPENSE_TYPE_LABELS,
} from "@/lib/expenses";
import { ExpenseEditForm } from "./_components/ExpenseEditForm";
import { CancelExpenseForm } from "./_components/CancelExpenseForm";

export const dynamic = "force-dynamic";

function isoDay(date: Date | null): string {
  if (!date) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseItems(json: string | null): string {
  if (!json) return "";
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.join("\n") : "";
  } catch {
    return "";
  }
}

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("expenses");
  const { id } = await params;

  const ctx = await getCurrentAccessContext();
  if (!ctx) notFound();

  const expense = await getExpenseForContext(ctx, id);
  if (!expense) notFound();

  const canCancel = canCreateOperational(ctx.effectiveRoles) && isExpenseCancelable(expense.status);
  const isCanceled = expense.status === "canceled" || expense.status === "import_reverted";

  const view = {
    id: expense.id,
    type: expense.type,
    category: expense.category,
    vendorName: expense.vendorName ?? "",
    recipientName: expense.recipientName ?? "",
    transferComment: expense.transferComment ?? "",
    amount: (expense.amountKopeks / 100).toString(),
    currency: expense.currency,
    purchaseDate: isoDay(expense.expenseDate),
    address: expense.address ?? "",
    items: parseItems(expense.itemsJson),
    notes: expense.notes ?? "",
    clubName: expense.club.name,
    hasFile: Boolean(expense.originalFileStorageKey),
    originalFileName: expense.originalFileName ?? "",
    // Accounting contour only: explicit download (attachment). Others view inline.
    canDownload: canDownloadDocuments(ctx.effectiveRoles),
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <PageHeader
          title="Расход"
          description={`${view.clubName} · ${EXPENSE_TYPE_LABELS[view.type] ?? view.type}`}
        />
        <Link
          href="/expenses"
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          К списку
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-slate-500">Статус:</span>
        <span
          className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${
            isCanceled
              ? "bg-slate-100 text-slate-500 ring-slate-200"
              : expense.status === "waiting_budget_approval"
                ? "bg-amber-50 text-amber-800 ring-amber-200"
                : "bg-emerald-50 text-emerald-700 ring-emerald-200"
          }`}
        >
          {expenseStatusLabel(expense.status)}
        </span>
      </div>

      <ExpenseEditForm expense={view} categories={EXPENSE_CATEGORY_OPTIONS} readOnly={!canMutateOperationalRecords(ctx.effectiveRoles)} />

      {canCancel ? (
        <div className="mt-6 rounded-lg border border-rose-200 bg-white p-4 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-slate-700">Отмена расхода</div>
          <CancelExpenseForm expenseId={expense.id} />
        </div>
      ) : null}
    </div>
  );
}
