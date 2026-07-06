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
import { safeBackLink } from "@/lib/strategic-return";
import { getExpenseAttachments, isExpenseDocumentsEditable } from "@/lib/expense-attachments";
import { ExpenseEditForm } from "./_components/ExpenseEditForm";
import { ExpenseAttachments } from "./_components/ExpenseAttachments";
import { CancelExpenseForm } from "./_components/CancelExpenseForm";

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("expenses");
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};
  const back = safeBackLink(sp, { path: "/expenses", label: "К списку" });

  const ctx = await getCurrentAccessContext();
  if (!ctx) notFound();

  const expense = await getExpenseForContext(ctx, id);
  if (!expense) notFound();

  const canCancel = canCreateOperational(ctx.effectiveRoles) && isExpenseCancelable(expense.status);
  const isCanceled = expense.status === "canceled" || expense.status === "import_reverted";

  // Normalized attachments (legacy single file + new ExpenseDocument rows).
  const attach = await getExpenseAttachments(expense);
  const docsEditable = isExpenseDocumentsEditable(expense) && canCreateOperational(ctx.effectiveRoles);
  const canDownloadDocs = canDownloadDocuments(ctx.effectiveRoles);
  const attachmentsView = [
    ...(attach.legacy ? [{
      key: "legacy", kind: "legacy" as const, id: null,
      filename: attach.legacy.filename, typeLabel: "Документ", sizeText: null, createdText: null,
      previewHref: attach.legacy.previewHref, downloadHref: attach.legacy.downloadHref,
      canPreview: attach.legacy.canPreview, canRemove: false,
    }] : []),
    ...attach.documents.map((d) => ({
      key: d.id, kind: "document" as const, id: d.id,
      filename: d.filename, typeLabel: d.documentTypeLabel, sizeText: sizeText(d.sizeBytes),
      createdText: dateFmt.format(d.createdAt),
      previewHref: d.previewHref, downloadHref: canDownloadDocs ? d.downloadHref : d.previewHref,
      canPreview: d.canPreview, canRemove: docsEditable,
    })),
  ];

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
          href={back.href}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          {back.label}
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

      <ExpenseAttachments expenseId={expense.id} attachments={attachmentsView} editable={docsEditable} />

      {canCancel ? (
        <div className="mt-6 rounded-lg border border-rose-200 bg-white p-4 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-slate-700">Отмена расхода</div>
          <CancelExpenseForm expenseId={expense.id} />
        </div>
      ) : null}
    </div>
  );
}
