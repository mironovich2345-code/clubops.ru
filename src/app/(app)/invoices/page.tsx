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
import { canCreateOperational, isStrategicRole } from "@/lib/auth";
import { resolveStrategicGroups } from "@/lib/strategic-pages";
import { StrategicScopeFilter } from "../dashboard/_components/StrategicScopeFilter";
import { openStrategicInvoice } from "../dashboard/strategic-actions";
import { buildReturnTo } from "@/lib/strategic-return";
import {
  getInvoicesForScope,
  INVOICE_STATUS_LABELS,
  INVOICE_CONFIDENCE_LABELS,
} from "@/lib/invoices";
import { EXPENSE_CATEGORY_OPTIONS, expenseCategoryLabel } from "@/lib/expenses";
import { getClubLegalEntities, normalizeEntityType } from "@/lib/legal-entities";
import { InvoiceUpload } from "./_components/InvoiceUpload";
import { HistoricalInvoiceForm } from "./_components/HistoricalInvoiceForm";
import { InvoiceAnalytics } from "./_components/InvoiceAnalytics";

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

type InvoiceRow = Awaited<ReturnType<typeof getInvoicesForScope>>[number] & { companyName?: string };

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams?: Promise<{ scopeMode?: string; companyId?: string; city?: string; clubId?: string }>;
}) {
  const user = await requirePageAccess("invoices");

  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Счета" description="Загрузка и распознавание счетов" />;
  }

  const sp = searchParams ? await searchParams : {};
  const ctx = await getCurrentAccessContext();
  // Strategic owner/GD: read-only invoice analytics across ALL filtered Companies.
  const strategic = ctx ? isStrategicRole(ctx.effectiveRoles) : false;
  const groups = strategic && ctx ? await resolveStrategicGroups(ctx, sp) : null;

  let clubs: Awaited<ReturnType<typeof getClubsInScope>>;
  let invoices: InvoiceRow[];
  if (groups) {
    const perCompany = await Promise.all(
      groups.byCompany.map((g) =>
        getInvoicesForScope({ company: { id: g.companyId, name: g.companyName }, club: null, clubIds: g.clubIds }).then(
          (rows) => rows.map((r) => ({ ...r, companyName: g.companyName })),
        ),
      ),
    );
    invoices = perCompany.flat();
    clubs = [];
  } else {
    [clubs, invoices] = await Promise.all([getClubsInScope(scope), getInvoicesForScope(scope)]);
  }
  const canCreate = ctx ? canCreateOperational(ctx.effectiveRoles) : false;
  const multiCompany = groups?.multiCompany ?? false;
  const returnQuery = groups ? buildReturnTo("invoices", sp as Record<string, string | undefined>) : "";

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
      </div>

      {groups && groups.scope.accessibleClubs.length > 0 ? (
        <div className="mt-3">
          <StrategicScopeFilter
            companies={groups.scope.accessibleCompanies}
            clubs={groups.scope.accessibleClubs}
            mode={groups.scope.mode}
            companyId={groups.scope.selectedCompanyId}
            city={groups.scope.selectedCity}
            clubId={groups.scope.selectedClubId}
            month=""
            basePath="/invoices"
          />
        </div>
      ) : null}

      {/* Read-only invoice analytics (totals / category / club / company / upcoming). */}
      {invoices.length > 0 ? (
        <InvoiceAnalytics
          todayISO={new Date().toISOString()}
          showCompany={multiCompany}
          rows={invoices.map((i) => ({
            status: i.status,
            amountKopeks: i.amountKopeks,
            expenseCategory: i.expenseCategory,
            companyName: i.companyName ?? scope.company!.name,
            clubName: i.club.name,
            dueDate: i.dueDate ? i.dueDate.toISOString() : null,
            paidAt: i.paidAt ? i.paidAt.toISOString() : null,
            invoiceNumber: i.invoiceNumber,
            counterpartyName: i.counterpartyName,
          }))}
        />
      ) : null}

      {canCreate ? (
        clubs.length > 0 ? (
          <>
            <InvoiceUpload clubs={clubs} categories={EXPENSE_CATEGORY_OPTIONS} companyName={scope.company.name} legalEntitiesByClub={legalEntitiesByClub} />
            {/* Historical paid-invoice quick entry (past months) */}
            <HistoricalInvoiceForm
              clubs={clubs.map((c) => ({ id: c.id, name: c.name }))}
              categories={EXPENSE_CATEGORY_OPTIONS}
              legalEntitiesByClub={legalEntitiesByClub}
              defaultClubId={scope.club?.id ?? clubs[0].id}
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
                  <Td className="whitespace-nowrap text-slate-600">
                    {multiCompany && invoice.companyName ? <span className="text-xs text-slate-400">{invoice.companyName} · </span> : null}
                    {invoice.club.name}
                  </Td>
                  <Td className="whitespace-nowrap text-slate-500">
                    {dateFormatter.format(invoice.createdAt)}
                  </Td>
                  <Td>
                    {groups ? (
                      <form action={openStrategicInvoice}>
                        <input type="hidden" name="companyId" value={invoice.companyId} />
                        <input type="hidden" name="objectId" value={invoice.id} />
                        <input type="hidden" name="returnTo" value={returnQuery} />
                        <button type="submit" className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                          Открыть
                        </button>
                      </form>
                    ) : (
                      <Link
                        href={`/invoices/${invoice.id}`}
                        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Открыть
                      </Link>
                    )}
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
