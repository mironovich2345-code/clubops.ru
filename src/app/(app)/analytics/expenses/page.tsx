import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";
import { requirePageAccess, getCurrentAccessContext, getCurrentCompanyAndClub, getClubsInScope } from "@/lib/access";
import { isStrategicRole, type Role } from "@/lib/auth";
import { expenseCategoryLabel } from "@/lib/expenses";
import { resolveStrategicGroups } from "@/lib/strategic-pages";
import { StrategicScopeFilter } from "../../dashboard/_components/StrategicScopeFilter";
import {
  loadCategoryExpenseRows,
  filterDrillRows,
  summarizeDrill,
  DRILL_SOURCE_LABELS,
  type DrillRow,
} from "@/lib/expense-drilldown";

export const dynamic = "force-dynamic";

const FINANCIAL_ROLES = new Set<Role>(["owner", "general_director", "regional_director", "accountant"]);
const dayFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const monthFmt = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });

type DrillRowX = DrillRow & { companyName?: string };

type SP = {
  category?: string; from?: string; to?: string; club?: string; entity?: string; pay?: string; source?: string;
  scopeMode?: string; companyId?: string; city?: string; clubId?: string;
};

// Parse "YYYY-MM-DD" to LOCAL midnight so the bounds match the analytics period
// Dates exactly (which are built with new Date(y, m, d)).
function parseDay(v: string | undefined): Date | null {
  const m = v?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export default async function ExpenseDrilldownPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePageAccess("analytics");
  const ctx = await getCurrentAccessContext();
  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company || !ctx) {
    return <NoCompanyState title="Расходы по статье" description="Детализация расходов" />;
  }
  // Expenses drilldown is for financial roles only (manager/marketer forbidden).
  if (!ctx.effectiveRoles.some((r) => FINANCIAL_ROLES.has(r))) notFound();

  const sp = await searchParams;
  const category = (sp.category ?? "").trim();
  if (!category) notFound();
  const companyId = scope.company.id;

  // Period: from/to (exclusive end), default current month.
  const now = new Date();
  const start = parseDay(sp.from) ?? new Date(now.getFullYear(), now.getMonth(), 1);
  const end = parseDay(sp.to) ?? new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const monthLabel = monthFmt.format(start);

  // Strategic owner/GD: aggregate the drilldown across ALL filtered Companies
  // (one scoped query per Company; rows tagged with Company). Non-strategic roles
  // keep the single-Company drilldown.
  const strategic = isStrategicRole(ctx.effectiveRoles);
  const groups = strategic ? await resolveStrategicGroups(ctx, sp) : null;

  const clubs = groups ? groups.scope.accessibleClubs.map((c) => ({ id: c.id, name: c.name })) : await getClubsInScope(scope);
  const entityCompanyIds = groups ? groups.filteredCompanyIds : [companyId];
  const entities = entityCompanyIds.length
    ? await prisma.legalEntity.findMany({ where: { companyId: { in: entityCompanyIds }, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];
  let allRows: DrillRowX[];
  if (groups) {
    const perCompany = await Promise.all(
      groups.byCompany.map((g) =>
        loadCategoryExpenseRows({ companyId: g.companyId, clubIds: g.clubIds, category, start, end }).then((rows) =>
          rows.map((r) => ({ ...r, companyName: g.companyName })),
        ),
      ),
    );
    allRows = perCompany.flat();
  } else {
    allRows = await loadCategoryExpenseRows({ companyId, clubIds: scope.clubIds, category, start, end });
  }

  const accessibleClubIds = groups ? new Set(groups.scope.accessibleClubs.map((c) => c.id)) : new Set(scope.clubIds);
  const wantClub = sp.club && accessibleClubIds.has(sp.club) ? sp.club : undefined;
  const wantEntity = sp.entity && entities.some((e) => e.id === sp.entity) ? sp.entity : undefined;
  const pay = ["cash", "noncash", "all"].includes(sp.pay ?? "") ? sp.pay! : "all";
  const source = ["expense", "invoice", "refund", "all"].includes(sp.source ?? "") ? sp.source! : "all";

  const rows = filterDrillRows(allRows, { pay, source, entity: wantEntity, club: wantClub }) as DrillRowX[];
  const summary = summarizeDrill(rows);
  const showCompany = groups?.multiCompany ?? false;
  const cashRows = rows.filter((r) => r.cash).sort(byDateDesc);
  const nonCashRows = rows.filter((r) => !r.cash).sort(byDateDesc);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <PageHeader title={`Расходы: ${expenseCategoryLabel(category)}`} description={monthLabel} />
        <div className="flex items-center gap-2 pt-1">
          <Link href="/analytics" className="text-sm font-medium text-brand-600 hover:text-brand-700">← К аналитике</Link>
        </div>
      </div>

      {groups && groups.scope.accessibleClubs.length > 0 ? (
        <div className="mb-4">
          <StrategicScopeFilter
            companies={groups.scope.accessibleCompanies}
            clubs={groups.scope.accessibleClubs}
            mode={groups.scope.mode}
            companyId={groups.scope.selectedCompanyId}
            city={groups.scope.selectedCity}
            clubId={groups.scope.selectedClubId}
            month=""
            basePath="/analytics/expenses"
            extra={{ category, from: sp.from ?? "", to: sp.to ?? "", pay, source }}
          />
        </div>
      ) : null}

      {/* Part 2: top cards */}
      <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Card label="Всего" value={formatKopeks(summary.totalKopeks)} />
        <Card label="Наличные" value={formatKopeks(summary.cashKopeks)} accent="text-amber-700" />
        <Card label="Безналичные" value={formatKopeks(summary.nonCashKopeks)} accent="text-sky-700" />
        <Card label="Количество" value={String(summary.count)} />
      </div>

      {/* Part 7: filters */}
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <input type="hidden" name="category" value={category} />
        <input type="hidden" name="from" value={sp.from ?? ""} />
        <input type="hidden" name="to" value={sp.to ?? ""} />
        <Select name="pay" label="Тип оплаты" value={pay} options={[{ value: "all", label: "Все" }, { value: "cash", label: "Наличные" }, { value: "noncash", label: "Безналичные" }]} />
        <Select name="source" label="Источник" value={source} options={[{ value: "all", label: "Все" }, { value: "expense", label: "Расход" }, { value: "invoice", label: "Счёт" }, { value: "refund", label: "Возврат" }]} />
        <Select name="club" label="Клуб" value={wantClub ?? ""} options={[{ value: "", label: "Все" }, ...clubs.map((c) => ({ value: c.id, label: c.name }))]} />
        <Select name="entity" label="Юрлицо" value={wantEntity ?? ""} options={[{ value: "", label: "Все" }, ...entities.map((e) => ({ value: e.id, label: e.name }))]} />
        <button type="submit" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700">Показать</button>
      </form>

      <Section title="Наличные расходы" rows={cashRows} showCompany={showCompany} />
      <Section title="Безналичные расходы" rows={nonCashRows} showCompany={showCompany} />
    </div>
  );
}

function byDateDesc(a: DrillRow, b: DrillRow): number {
  return (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0);
}

function Section({ title, rows, showCompany = false }: { title: string; rows: DrillRowX[]; showCompany?: boolean }) {
  const total = rows.reduce((s, r) => s + r.amountKopeks, 0);
  return (
    <div className="mb-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
        <span className="text-sm font-semibold text-slate-700">{title}</span>
        <span className="text-sm font-medium text-slate-900">{formatKopeks(total)}</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">Нет записей.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>Дата</Th>
                {showCompany ? <Th>Сеть</Th> : null}
                <Th>Клуб</Th>
                <Th>Юрлицо</Th>
                <Th>Контрагент</Th>
                <Th>Комментарий</Th>
                <Th className="text-right">Сумма</Th>
                <Th>Источник</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.map((r) => (
                <tr key={`${r.source}-${r.id}`} className="hover:bg-slate-50">
                  <Td className="whitespace-nowrap">{r.date ? dayFmt.format(r.date) : "—"}</Td>
                  {showCompany ? <Td className="whitespace-nowrap text-slate-500">{r.companyName ?? "—"}</Td> : null}
                  <Td className="whitespace-nowrap">{r.clubName}</Td>
                  <Td className="whitespace-nowrap">{r.legalEntityName ?? "—"}</Td>
                  <Td>{r.counterparty ?? "—"}</Td>
                  <Td className="max-w-[18rem] truncate text-slate-500">{r.comment ?? "—"}</Td>
                  <Td className="whitespace-nowrap text-right font-medium text-slate-900">{formatKopeks(r.amountKopeks)}</Td>
                  <Td className="whitespace-nowrap">
                    <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200">{DRILL_SOURCE_LABELS[r.source]}</span>
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    <Link href={r.href} className="text-xs font-medium text-brand-600 hover:text-brand-700">Открыть</Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Card({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 truncate text-xl font-semibold ${accent ?? "text-slate-900"}`}>{value}</div>
    </div>
  );
}

function Select({ name, label, value, options }: { name: string; label: string; value: string; options: { value: string; label: string }[] }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      <select name={name} defaultValue={value} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500">
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th scope="col" className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className ?? ""}`}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
