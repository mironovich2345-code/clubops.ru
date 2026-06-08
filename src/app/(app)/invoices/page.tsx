import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks } from "@/lib/money";
import {
  requirePageAccess,
  getCurrentCompanyAndClub,
  getClubsInScope,
  getCurrentAccessContext,
} from "@/lib/access";
import { canCreateOperational } from "@/lib/auth";
import {
  getInvoicesForScope,
  INVOICE_STATUS_LABELS,
  INVOICE_CONFIDENCE_LABELS,
} from "@/lib/invoices";
import { EXPENSE_CATEGORY_OPTIONS, expenseCategoryLabel } from "@/lib/expenses";
import { getClubLegalEntities, normalizeEntityType } from "@/lib/legal-entities";
import { InvoiceUpload } from "./_components/InvoiceUpload";
import { ExcelImportPanel } from "@/components/ExcelImportPanel";
import { importInvoices } from "./invoice-import-actions";
import { ExportButton } from "@/components/ExportButton";
import { canExport } from "@/lib/exports";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const CONFIDENCE_BADGE: Record<string, string> = {
  high: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  medium: "bg-amber-50 text-amber-800 ring-amber-200",
  low: "bg-slate-100 text-slate-600 ring-slate-200",
};

export default async function InvoicesPage() {
  const user = await requirePageAccess("invoices");

  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Счета" description="Загрузка и распознавание счетов" />;
  }

  const [clubs, invoices, ctx] = await Promise.all([
    getClubsInScope(scope),
    getInvoicesForScope(scope),
    getCurrentAccessContext(),
  ]);
  const canCreate = ctx ? canCreateOperational(ctx.effectiveRoles) : false;

  const legalEntitiesByClub: Record<string, Array<{ id: string; name: string; type: string; inn: string | null; kpp: string | null; bankName: string | null; accountNumber: string | null }>> = {};
  if (canCreate) {
    const lists = await Promise.all(clubs.map((c) => getClubLegalEntities(c.id)));
    clubs.forEach((c, i) => {
      legalEntitiesByClub[c.id] = lists[i].map((e) => ({
        id: e.id,
        name: e.name,
        type: normalizeEntityType(e.type) ?? e.type,
        inn: e.inn,
        kpp: e.kpp,
        bankName: e.bankName,
        accountNumber: e.accountNumber,
      }));
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="Счета" description="Загрузка, распознавание и учёт счетов" />
        {ctx && canExport(ctx.effectiveRoles, "invoices") ? <div className="pt-1"><ExportButton type="invoices" /></div> : null}
      </div>

      {canCreate ? (
        clubs.length > 0 ? (
          <>
            <InvoiceUpload clubs={clubs} categories={EXPENSE_CATEGORY_OPTIONS} companyName={scope.company.name} legalEntitiesByClub={legalEntitiesByClub} />
            {/* Excel import (additional input method; manual form + AI upload unchanged) */}
            <ExcelImportPanel
              title="Импорт счетов из Excel"
              description="Скачайте шаблон, заполните и загрузите. Счета импортируются со статусом «На согласовании» и не помечаются оплаченными."
              templateHref="/api/invoices/template"
              templateLabel="Скачать шаблон счетов"
              uploadLabel="Загрузить счета из Excel"
              action={importInvoices}
            />
          </>
        ) : (
          <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">
            Нет доступных клубов для создания счёта.
          </div>
        )
      ) : null}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th>Контрагент</Th>
              <Th className="text-right">Сумма</Th>
              <Th>Статья</Th>
              <Th>Статус</Th>
              <Th>Распознавание</Th>
              <Th>Клуб</Th>
              <Th>Создан</Th>
              <Th>Действия</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {invoices.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-slate-500">
                  Пока нет счетов. Загрузите документ, чтобы создать первый.
                </td>
              </tr>
            ) : (
              invoices.map((invoice) => (
                <tr key={invoice.id} className="hover:bg-slate-50">
                  <Td>
                    <div className="font-medium text-slate-900">
                      {invoice.counterpartyName ?? "— без контрагента —"}
                    </div>
                    {invoice.invoiceNumber ? (
                      <div className="text-xs text-slate-500">№ {invoice.invoiceNumber}</div>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-right font-medium text-slate-900">
                    {formatKopeks(invoice.amountKopeks)}
                  </Td>
                  <Td>{expenseCategoryLabel(invoice.expenseCategory)}</Td>
                  <Td className="whitespace-nowrap">
                    {INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}
                  </Td>
                  <Td>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                        CONFIDENCE_BADGE[invoice.confidence] ?? CONFIDENCE_BADGE.low
                      }`}
                    >
                      {INVOICE_CONFIDENCE_LABELS[invoice.confidence] ?? invoice.confidence}
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap text-slate-600">{invoice.club.name}</Td>
                  <Td className="whitespace-nowrap text-slate-500">
                    {dateFormatter.format(invoice.createdAt)}
                  </Td>
                  <Td>
                    <Link
                      href={`/invoices/${invoice.id}`}
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Открыть
                    </Link>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
