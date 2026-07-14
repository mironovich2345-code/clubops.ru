import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { getInvoicesView, type InvoicesView } from "@/lib/invoice-view";
import { INVOICE_STATUS_LABELS, formatExpensePeriod } from "@/lib/invoices";
import { EXPENSE_CATEGORY_OPTIONS, expenseCategoryLabel } from "@/lib/expenses";
import { getClubLegalEntities, normalizeEntityType } from "@/lib/legal-entities";
import { InvoiceUpload } from "./_components/InvoiceUpload";
import { HistoricalInvoiceForm } from "./_components/HistoricalInvoiceForm";
import { InvoiceFilters } from "./_components/InvoiceFilters";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const CARD = "rounded-lg border border-slate-200 bg-white shadow-sm";

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams?: Promise<{ year?: string; month?: string; city?: string; clubId?: string }>;
}) {
  await requirePageAccess("invoices");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) {
    return <NoCompanyState title="Счета" description="Загрузка и распознавание счетов" />;
  }

  const sp = searchParams ? await searchParams : {};
  // The ONE data source for this page — cards, list, debts, categories, filters
  // and permissions all come from here. No second full invoice query.
  const view = await getInvoicesView(ctx, sp);
  const isManager = view.roleView === "manager";
  const monthLabel = formatExpensePeriod(`${view.effectivePeriod.year}-${String(view.effectivePeriod.month).padStart(2, "0")}`);

  // Either the upload form (manager/regional) or the add-paid form (accountant/
  // chief) needs the accessible clubs + their legal entities. These are DISJOINT
  // role sets, so fetch this club/legal-entity metadata (NOT an invoice query)
  // whenever EITHER form may be shown.
  const needClubs = view.permissions.canUploadInvoice || view.permissions.canAddPaidInvoice;
  let formClubs: Array<{ id: string; name: string; city: string }> = [];
  let legalEntitiesByClub: Record<string, Array<{ id: string; name: string; type: string; inn: string | null; kpp: string | null; bankName: string | null; accountNumber: string | null }>> = {};
  let companyName = "";
  if (needClubs && view.availableClubs.length > 0) {
    formClubs = view.availableClubs;
    const [lists, company] = await Promise.all([
      Promise.all(formClubs.map((c) => getClubLegalEntities(c.id))),
      prisma.company.findUnique({ where: { id: ctx.selectedCompanyId }, select: { name: true } }),
    ]);
    companyName = company?.name ?? "";
    formClubs.forEach((c, i) => {
      legalEntitiesByClub[c.id] = lists[i].map((e) => ({
        id: e.id, name: e.name, type: normalizeEntityType(e.type) ?? e.type,
        inn: e.inn, kpp: e.kpp, bankName: e.bankName, accountNumber: e.accountNumber,
      }));
    });
  }

  return (
    <div>
      {/* 1–2. Title + subtitle */}
      <PageHeader title="Счета" description="Загрузка, распознавание и учёт счетов" />

      {/* 3. Regular invoice upload — TOP for a MANAGER (creating is their main job).
          A regional director mainly APPROVES, so their upload block is moved BELOW
          the lists (see the "regional upload" block near the bottom). */}
      {view.permissions.canUploadInvoice && isManager && formClubs.length > 0 ? (
        <div className="mt-4">
          <InvoiceUpload clubs={formClubs} categories={EXPENSE_CATEGORY_OPTIONS} companyName={companyName} legalEntitiesByClub={legalEntitiesByClub} />
        </div>
      ) : null}

      {/* 4. Period + filters — only when the role may use them. */}
      {isManager ? (
        <div className="mt-4 text-sm font-medium text-slate-600">{monthLabel}</div>
      ) : (
        <div className="mt-4">
          <InvoiceFilters
            year={view.effectivePeriod.year}
            month={view.effectivePeriod.month}
            monthLabel={monthLabel}
            canNavigateMonths={view.canNavigateMonths}
            canFilterByCity={view.canFilterByCity}
            canFilterByClub={view.canFilterByClub}
            availableCities={view.availableCities}
            availableClubs={view.availableClubs}
            selectedCity={view.selectedCity}
            selectedClub={view.selectedClub}
          />
        </div>
      )}

      {/* 5. Summary cards */}
      <div className="mt-4">{isManager ? <ManagerCards view={view} /> : <ElevatedCards view={view} />}</div>

      {/* 5b. Active review queue — above analytics/history, month-independent. */}
      {view.showReviewQueue ? <ReviewQueue view={view} /> : null}

      {/* 6. Analytics — categories (+ by-club for elevated) */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <CategoryBlock view={view} />
        {!isManager && !view.selectedClub ? <ByClubBlock view={view} /> : null}
        <UpcomingBlock view={view} />
      </div>

      {/* 7. Carried overdue debts */}
      <CarriedOverdue view={view} />

      {/* 8. Main invoice list */}
      <MainList view={view} />

      {/* 8b. Regional director's invoice upload — BELOW the lists (they mainly
          approve; the ability to add a invoice is kept, just not at the top). */}
      {view.permissions.canUploadInvoice && !isManager && formClubs.length > 0 ? (
        <div className="mt-6">
          <InvoiceUpload clubs={formClubs} categories={EXPENSE_CATEGORY_OPTIONS} companyName={companyName} legalEntitiesByClub={legalEntitiesByClub} />
        </div>
      ) : null}

      {/* 9. Add a historical PAID invoice — accountant / chief only. */}
      {view.permissions.canAddPaidInvoice && formClubs.length > 0 ? (
        <div className="mt-6">
          <HistoricalInvoiceForm
            clubs={formClubs.map((c) => ({ id: c.id, name: c.name }))}
            categories={EXPENSE_CATEGORY_OPTIONS}
            legalEntitiesByClub={legalEntitiesByClub}
            defaultClubId={view.selectedClub ?? formClubs[0].id}
          />
        </div>
      ) : null}
    </div>
  );
}

// --- Summary cards ----------------------------------------------------------

function Stat({ label, value, accent, sub }: { label: string; value: string; accent?: string; sub?: string }) {
  return (
    <div className={`p-4 ${CARD}`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 truncate text-lg font-semibold ${accent ?? "text-slate-900"}`}>{value}</div>
      {sub ? <div className="text-[11px] text-slate-400">{sub}</div> : null}
    </div>
  );
}

/** Manager sees EXACTLY three cards — nothing else is even computed for them. */
function ManagerCards({ view }: { view: InvoicesView }) {
  const s = view.summary;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <Stat label="Ожидает оплаты" value={formatKopeks(s.pendingPaymentAmountKopeks)} accent="text-amber-700" />
      <Stat label="Просрочено" value={formatKopeks(s.overdueAmountKopeks)} accent={s.overdueAmountKopeks > 0 ? "text-rose-700" : undefined} sub="включая старые долги" />
      <Stat label="Всего счетов отправлено" value={String(s.sentCount)} sub="за текущий месяц" />
    </div>
  );
}

function ElevatedCards({ view }: { view: InvoicesView }) {
  const s = view.summary;
  const total = "totalInvoiceAmountKopeks" in s ? s.totalInvoiceAmountKopeks : 0;
  const paid = "paidAmountKopeks" in s ? s.paidAmountKopeks : 0;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <Stat label="Сумма счетов" value={formatKopeks(total)} />
      <Stat label="Оплачено" value={formatKopeks(paid)} accent="text-emerald-700" />
      <Stat label="Ожидает оплаты" value={formatKopeks(s.pendingPaymentAmountKopeks)} accent="text-amber-700" />
      <Stat label="Просрочено" value={formatKopeks(s.overdueAmountKopeks)} accent={s.overdueAmountKopeks > 0 ? "text-rose-700" : undefined} />
      <Stat label="Счетов" value={String(view.currentPeriodInvoices.length)} />
    </div>
  );
}

// --- Analytics blocks -------------------------------------------------------

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={`overflow-hidden ${CARD}`}>
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">{title}</div>
      {children}
    </div>
  );
}

function CategoryBlock({ view }: { view: InvoicesView }) {
  const total = view.categoryDistribution.reduce((s, c) => s + c.amountKopeks, 0);
  return (
    <Panel title="По статьям">
      {view.categoryDistribution.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-slate-500">Нет счетов по статьям за текущий месяц</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {view.categoryDistribution.map((c) => {
            const pct = total > 0 ? (c.amountKopeks / total) * 100 : 0;
            return (
              <li key={c.category} className="px-4 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm text-slate-700">{c.category === "—" ? "Без статьи" : expenseCategoryLabel(c.category)}</span>
                  <span className="text-sm font-medium text-slate-900">{formatKopeks(c.amountKopeks)}</span>
                </div>
                <div className="mt-1 text-right text-[11px] text-slate-400">{pct.toFixed(1)}%</div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** «По клубам» — elevated only, from the same scoped current-period rows. */
function ByClubBlock({ view }: { view: InvoicesView }) {
  const byClub = new Map<string, { name: string; amountKopeks: number }>();
  for (const r of view.currentPeriodInvoices) {
    const cur = byClub.get(r.clubId) ?? { name: r.clubName, amountKopeks: 0 };
    cur.amountKopeks += r.amountKopeks;
    byClub.set(r.clubId, cur);
  }
  const rows = [...byClub.values()].sort((a, b) => b.amountKopeks - a.amountKopeks);
  const total = rows.reduce((s, r) => s + r.amountKopeks, 0);
  return (
    <Panel title="По клубам">
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-slate-500">Нет данных за выбранный период</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((r) => {
            const pct = total > 0 ? (r.amountKopeks / total) * 100 : 0;
            return (
              <li key={r.name} className="px-4 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm text-slate-700">{r.name}</span>
                  <span className="text-sm font-medium text-slate-900">{formatKopeks(r.amountKopeks)}</span>
                </div>
                <div className="mt-1 text-right text-[11px] text-slate-400">{pct.toFixed(1)}%</div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** Upcoming payments — server-computed in getInvoicesView (only unpaid
 * obligations awaiting payment, no paidAt, with a due date, nearest first).
 * Rendered verbatim; no client-side status/payment filtering. */
function UpcomingBlock({ view }: { view: InvoicesView }) {
  const upcoming = view.upcomingPayments;
  return (
    <Panel title="Ближайшие платежи">
      {upcoming.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-slate-500">Нет ближайших платежей</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {upcoming.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm text-slate-800">{r.counterpartyName ?? r.invoiceNumber ?? "Счёт"}</div>
                <div className="text-xs text-slate-500">{r.clubName}{r.dueDate ? ` · до ${dateFmt.format(new Date(r.dueDate))}` : ""}</div>
              </div>
              <span className="whitespace-nowrap text-sm font-medium text-slate-900">{formatKopeks(r.amountKopeks)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// --- Carried overdue --------------------------------------------------------

function daysOverdue(dueISO: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(dueISO).getTime()) / 86400000));
}

function CarriedOverdue({ view }: { view: InvoicesView }) {
  if (view.carriedOverdueInvoices.length === 0) return null;
  return (
    <div className={`mt-6 overflow-hidden ${CARD}`}>
      <div className="border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-800">
        Просроченные долги прошлых периодов
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr><Th>Контрагент</Th><Th className="text-right">Сумма</Th><Th>Срок оплаты</Th><Th>Просрочка</Th><Th>Статус</Th><Th>Действия</Th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {view.carriedOverdueInvoices.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <Td>
                  <div className="font-medium text-slate-900">{r.counterpartyName ?? "— без контрагента —"}</div>
                  <div className="mt-0.5 inline-flex rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700">Долг прошлого периода</div>
                </Td>
                <Td className="whitespace-nowrap text-right font-medium text-slate-900">{formatKopeks(r.amountKopeks)}</Td>
                <Td className="whitespace-nowrap text-slate-600">{r.dueDate ? dateFmt.format(new Date(r.dueDate)) : "—"}</Td>
                <Td className="whitespace-nowrap text-rose-700">{r.dueDate ? `просрочено с ${dateFmt.format(new Date(r.dueDate))} (${daysOverdue(r.dueDate)} дн.)` : "—"}</Td>
                <Td className="whitespace-nowrap">{INVOICE_STATUS_LABELS[r.status] ?? r.status}</Td>
                <Td><OpenLink id={r.id} /></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Active regional review queue (month-independent) -----------------------

function ReviewQueue({ view }: { view: InvoicesView }) {
  const rows = view.regionalReviewQueue;
  return (
    <div className={`mt-4 overflow-hidden ${CARD}`}>
      <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-4 py-3">
        <span className="text-sm font-semibold text-amber-900">Ожидают проверки</span>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-slate-500">Нет счетов, ожидающих проверки</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr><Th>Контрагент</Th><Th className="text-right">Сумма</Th><Th>Управляющий</Th><Th>Клуб</Th><Th>Отправлен</Th><Th>Срок оплаты</Th><Th>Действия</Th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <Td>
                    <div className="font-medium text-slate-900">{r.counterpartyName ?? "— без контрагента —"}</div>
                    {r.invoiceNumber ? <div className="text-xs text-slate-500">№ {r.invoiceNumber}</div> : null}
                  </Td>
                  <Td className="whitespace-nowrap text-right font-medium text-slate-900">{formatKopeks(r.amountKopeks)}</Td>
                  <Td className="whitespace-nowrap text-slate-600">{r.createdByName}</Td>
                  <Td className="whitespace-nowrap text-slate-600">{r.clubName}</Td>
                  <Td className="whitespace-nowrap text-slate-500">{dateFmt.format(new Date(r.submittedAt ?? r.createdAt))}</Td>
                  <Td className="whitespace-nowrap text-slate-500">{r.dueDate ? dateFmt.format(new Date(r.dueDate)) : "—"}</Td>
                  <Td><OpenLink id={r.id} /></Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Main list --------------------------------------------------------------

function MainList({ view }: { view: InvoicesView }) {
  const rows = view.currentPeriodInvoices;
  return (
    <div className={`mt-6 overflow-hidden ${CARD}`}>
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">Счета за период</div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr><Th>Контрагент</Th><Th className="text-right">Сумма</Th><Th>Статья</Th><Th>Статус</Th><Th>Клуб</Th><Th>Срок / Оплачен</Th><Th>Действия</Th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-slate-500">Нет счетов в выбранном месяце.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <Td>
                    <div className="font-medium text-slate-900">{r.counterpartyName ?? "— без контрагента —"}</div>
                    {r.invoiceNumber ? <div className="text-xs text-slate-500">№ {r.invoiceNumber}</div> : null}
                  </Td>
                  <Td className="whitespace-nowrap text-right font-medium text-slate-900">{formatKopeks(r.amountKopeks)}</Td>
                  <Td>{expenseCategoryLabel(r.expenseCategory)}</Td>
                  <Td className="whitespace-nowrap">{INVOICE_STATUS_LABELS[r.status] ?? r.status}{r.overdue ? <span className="ml-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700">просрочен</span> : null}</Td>
                  <Td className="whitespace-nowrap text-slate-600">{r.clubName}</Td>
                  <Td className="whitespace-nowrap text-slate-500">{r.status === "paid" ? (r.paidAt ? `оплачен ${dateFmt.format(new Date(r.paidAt))}` : "оплачен") : r.dueDate ? `до ${dateFmt.format(new Date(r.dueDate))}` : "—"}</Td>
                  <Td><OpenLink id={r.id} label={r.status === "draft" ? "Продолжить заполнение" : "Открыть"} /></Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OpenLink({ id, label = "Открыть" }: { id: string; label?: string }) {
  return (
    <Link href={`/invoices/${id}`} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
      {label}
    </Link>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th scope="col" className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className ?? ""}`}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
