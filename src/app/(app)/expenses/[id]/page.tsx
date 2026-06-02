import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import {
  getExpenseForContext,
  EXPENSE_CATEGORY_OPTIONS,
  EXPENSE_TYPE_LABELS,
} from "@/lib/expenses";
import { ExpenseEditForm } from "./_components/ExpenseEditForm";

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

  const view = {
    id: expense.id,
    type: expense.type,
    category: expense.category,
    vendorName: expense.vendorName ?? "",
    recipientName: expense.recipientName ?? "",
    amount: (expense.amountKopeks / 100).toString(),
    currency: expense.currency,
    purchaseDate: isoDay(expense.expenseDate),
    address: expense.address ?? "",
    items: parseItems(expense.itemsJson),
    notes: expense.notes ?? "",
    clubName: expense.club.name,
    hasFile: Boolean(expense.originalFileStorageKey),
    originalFileName: expense.originalFileName ?? "",
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

      <ExpenseEditForm expense={view} categories={EXPENSE_CATEGORY_OPTIONS} />
    </div>
  );
}
