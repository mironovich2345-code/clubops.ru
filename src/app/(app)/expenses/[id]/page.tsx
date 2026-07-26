import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess, getCurrentAccessContext, userHasCompanyRole, userHasClubRole } from "@/lib/access";
import { canCreateOperational, canDownloadDocuments, canMutateOperationalRecords } from "@/lib/auth";
import { formatKopeks } from "@/lib/money";
import {
  V2_STATUS_LABELS, canSubmitExpense, canApproveRegionalExpense, canApproveOwnerExpense,
  canVerifyExpense, canReturnExpenseForCorrection, canCancelExpense, canChangeExpenseDate,
} from "@/lib/expense-simplified";
import { WorkflowActions } from "./_components/WorkflowActions";
import {
  getExpenseForContext,
  expenseStatusLabel,
  isExpenseCancelable,
  EXPENSE_CATEGORY_OPTIONS,
  EXPENSE_TYPE_LABELS,
} from "@/lib/expenses";
import { safeBackLink } from "@/lib/strategic-return";
import { getExpenseAttachments, isExpenseDocumentsEditable } from "@/lib/expense-attachments";
import { MAX_SIMPLIFIED_EXPENSE_DOCUMENTS } from "@/lib/expense-document-storage";
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

  const isV2 = expense.entryVersion === 2;

  // Normalized attachments (legacy single file + new ExpenseDocument rows).
  const attach = await getExpenseAttachments(expense);

  // Simplified (v2) workflow: compute role-scoped action flags server-side.
  let flags = null as null | Record<string, boolean>;
  if (isV2) {
    const [companyOwner, regionalForClub] = await Promise.all([
      userHasCompanyRole(ctx.user.id, expense.companyId, ["owner"]),
      ctx.effectiveRoles.includes("regional_director") ? userHasClubRole(ctx.user.id, expense.clubId, ["regional_director"]) : Promise.resolve(false),
    ]);
    const actor = {
      userId: ctx.user.id, roles: ctx.effectiveRoles, allowedClubIds: ctx.allowedClubIds,
      companyOwner, regionalForClub,
      accountant: ctx.effectiveRoles.includes("accountant") || ctx.effectiveRoles.includes("chief_accountant"),
      manager: canCreateOperational(ctx.effectiveRoles),
    };
    const hasDoc = attach.activeCount > 0;
    flags = {
      canSubmit: canSubmitExpense(expense, actor) && hasDoc,
      canApproveRegional: canApproveRegionalExpense(expense, actor),
      canApproveOwner: canApproveOwnerExpense(expense, actor),
      canVerify: canVerifyExpense(expense, actor) && hasDoc,
      canReturn: canReturnExpenseForCorrection(expense, actor),
      canCancel: canCancelExpense(expense, actor),
      canChangeDate: canChangeExpenseDate(expense, actor),
    };
  }
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
      {sp.submitted === "1" ? (
        <div className="mb-4 rounded-md bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
          Расход создан и отправлен региональному директору на проверку.
        </div>
      ) : null}
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
          {isV2 ? (V2_STATUS_LABELS[expense.status] ?? expenseStatusLabel(expense.status)) : expenseStatusLabel(expense.status)}
        </span>
      </div>

      {isV2 && expense.status === "needs_correction" && expense.correctionReason ? (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Возвращено на исправление: {expense.correctionReason}
        </div>
      ) : null}

      {isV2 && expense.generatedTitle ? (
        <div className="mb-4 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <div className="font-semibold text-slate-900">{expense.generatedTitle}</div>
          <div className="mt-2 grid grid-cols-1 gap-1 text-slate-600 sm:grid-cols-2">
            <div>Сумма: <span className="font-medium text-slate-900">{formatKopeks(expense.amountKopeks)}</span></div>
            <div>Оплата: Наличные (ИП клуба)</div>
            <div>Дата: {isoDay(expense.expenseDate)}</div>
            <div>Статья: {EXPENSE_CATEGORY_OPTIONS.find((c) => c.key === expense.category)?.label ?? expense.category}</div>
          </div>
          {expense.comment ? <div className="mt-2 whitespace-pre-wrap text-slate-700">Комментарий: {expense.comment}</div> : null}
          {expense.shoppingListText ? <div className="mt-1 whitespace-pre-wrap text-slate-700">Список: {expense.shoppingListText}</div> : null}
          {expense.budgetApprovalLevel ? (
            <div className="mt-2 text-xs text-slate-500">
              Бюджет: {expense.budgetApprovalLevel === "within" ? "в рамках" : expense.budgetApprovalLevel === "regional" ? "перерасход ≤5% (согласование РД)" : "перерасход/без бюджета (согласование собственника)"}
              {expense.budgetOverrunKopeks ? ` · перерасход ${formatKopeks(expense.budgetOverrunKopeks)} (${((expense.budgetOverrunBasisPoints ?? 0) / 100).toFixed(1)}%)` : ""}
            </div>
          ) : null}
        </div>
      ) : (
        <ExpenseEditForm expense={view} categories={EXPENSE_CATEGORY_OPTIONS} readOnly={!canMutateOperationalRecords(ctx.effectiveRoles)} />
      )}

      <ExpenseAttachments expenseId={expense.id} attachments={attachmentsView} editable={docsEditable} maxDocuments={isV2 ? MAX_SIMPLIFIED_EXPENSE_DOCUMENTS : undefined} />

      {isV2 && flags ? (
        <WorkflowActions
          expenseId={expense.id}
          flags={{
            canSubmit: flags.canSubmit, canApproveRegional: flags.canApproveRegional, canApproveOwner: flags.canApproveOwner,
            canVerify: flags.canVerify, canReturn: flags.canReturn, canCancel: flags.canCancel, canChangeDate: flags.canChangeDate,
          }}
        />
      ) : null}

      {canCancel ? (
        <div className="mt-6 rounded-lg border border-rose-200 bg-white p-4 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-slate-700">Отмена расхода</div>
          <CancelExpenseForm expenseId={expense.id} />
        </div>
      ) : null}
    </div>
  );
}
