import Link from "next/link";
import { NoCompanyState } from "@/components/NoCompanyState";
import { CompactPageHeader, MobileDataCard, EmptyState } from "@/components/mobile/density";
import { StatusBadge, type StatusTone } from "@/components/mobile/StatusBadge";
import { FilterSheet } from "@/components/mobile/FilterSheet";
import {
  requirePageAccess,
  getCurrentAccessContext,
  getCurrentCompanyAndClub,
  getClubsInScope,
  getCompanyMembers,
} from "@/lib/access";
import {
  getActivityLog,
  ACTIVITY_TYPES,
  ACTIVITY_RANGES,
  type ActivityRange,
  type ActivityTypeKey,
  type ActivityFilters,
} from "@/lib/activity";

export const dynamic = "force-dynamic";

const dtFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const RESULT_TONE: Record<string, string> = {
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  reject: "bg-rose-50 text-rose-700 ring-rose-200",
  neutral: "bg-slate-100 text-slate-600 ring-slate-200",
};

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    from?: string;
    to?: string;
    userId?: string;
    clubId?: string;
    type?: string;
    page?: string;
  }>;
}) {
  const user = await requirePageAccess("activity");
  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="История действий" description="Журнал действий пользователей" />;
  }
  const ctx = await getCurrentAccessContext();
  if (!ctx) {
    return <NoCompanyState title="История действий" description="Журнал действий пользователей" />;
  }

  const sp = await searchParams;
  const range: ActivityRange = ACTIVITY_RANGES.some((r) => r.key === sp.range)
    ? (sp.range as ActivityRange)
    : "month";
  const type: ActivityTypeKey = ACTIVITY_TYPES.some((t) => t.key === sp.type)
    ? (sp.type as ActivityTypeKey)
    : "all";
  const page = Math.max(1, Number(sp.page) || 1);

  const filters: ActivityFilters = {
    range,
    from: parseDate(sp.from),
    to: parseDate(sp.to),
    userId: sp.userId || undefined,
    clubId: sp.clubId || undefined,
    type,
  };

  const [clubs, members, result] = await Promise.all([
    getClubsInScope(scope),
    getCompanyMembers(scope.company.id),
    getActivityLog(ctx, scope.company.name, filters, page),
  ]);

  // Distinct users for the "by user" filter.
  const userOptions = [...new Map(members.map((m) => [m.user.id, m.user])).values()].sort((a, b) =>
    a.name.localeCompare(b.name, "ru"),
  );

  // Preserve current filters when paging.
  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    params.set("range", range);
    if (sp.from) params.set("from", sp.from);
    if (sp.to) params.set("to", sp.to);
    if (filters.userId) params.set("userId", filters.userId);
    if (filters.clubId) params.set("clubId", filters.clubId);
    params.set("type", type);
    params.set("page", String(p));
    return `/activity?${params.toString()}`;
  };

  const from = result.total === 0 ? 0 : (result.page - 1) * result.pageSize + 1;
  const to = Math.min(result.page * result.pageSize, result.total);

  const rangeLabel = ACTIVITY_RANGES.find((r) => r.key === range)?.label ?? range;
  const typeLabel = ACTIVITY_TYPES.find((t) => t.key === type)?.label ?? type;
  const activeUserName = userOptions.find((u) => u.id === filters.userId)?.name;
  const activeClubName = clubs.find((c) => c.id === filters.clubId)?.name;
  const chips = [
    { label: `Период: ${rangeLabel}` },
    ...(sp.from ? [{ label: `с ${sp.from}` }] : []),
    ...(sp.to ? [{ label: `по ${sp.to}` }] : []),
    ...(activeUserName ? [{ label: activeUserName }] : []),
    ...(activeClubName ? [{ label: activeClubName }] : []),
    ...(type !== "all" ? [{ label: typeLabel }] : []),
  ];

  const resultTone: Record<string, StatusTone> = { ok: "success", reject: "danger", neutral: "neutral" };

  // Filter fields, shared between the desktop form and the mobile sheet form.
  const filterFields = (
    <>
      <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Период</span>
        <select name="range" defaultValue={range} className="input w-full">{ACTIVITY_RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></label>
      <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">С даты</span>
        <input type="date" name="from" defaultValue={sp.from ?? ""} className="input w-full" /></label>
      <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">По дату</span>
        <input type="date" name="to" defaultValue={sp.to ?? ""} className="input w-full" /></label>
      <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Пользователь</span>
        <select name="userId" defaultValue={filters.userId ?? ""} className="input w-full"><option value="">Все</option>{userOptions.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
      <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Клуб</span>
        <select name="clubId" defaultValue={filters.clubId ?? ""} className="input w-full"><option value="">Все</option>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Тип</span>
        <select name="type" defaultValue={type} className="input w-full">{ACTIVITY_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
    </>
  );

  return (
    <div>
      <CompactPageHeader title="История действий" subtitle="Кто, что и когда сделал" />

      {/* Mobile: compact filter bar → sheet + active chips + count (§17) */}
      <div className="mb-4">
        <FilterSheet formId="activity-filters-mobile" chips={chips}>
          <form id="activity-filters-mobile" method="get" className="grid grid-cols-1 gap-3">
            {filterFields}
            <Link href="/activity" className="text-center text-sm font-medium text-slate-600 hover:text-slate-800">Сбросить фильтры</Link>
          </form>
        </FilterSheet>
        <div className="mt-1 text-xs text-slate-500">{result.total === 0 ? "Нет записей" : `Найдено: ${result.total}`}</div>
      </div>

      {/* Desktop filters (≥lg) */}
      <form method="get" className="mb-5 hidden grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm lg:grid lg:grid-cols-6">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Период</span>
          <select name="range" defaultValue={range} className="input w-full">
            {ACTIVITY_RANGES.map((r) => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">С даты</span>
          <input type="date" name="from" defaultValue={sp.from ?? ""} className="input w-full" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">По дату</span>
          <input type="date" name="to" defaultValue={sp.to ?? ""} className="input w-full" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Пользователь</span>
          <select name="userId" defaultValue={filters.userId ?? ""} className="input w-full">
            <option value="">Все</option>
            {userOptions.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Клуб</span>
          <select name="clubId" defaultValue={filters.clubId ?? ""} className="input w-full">
            <option value="">Все</option>
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Тип</span>
          <select name="type" defaultValue={type} className="input w-full">
            {ACTIVITY_TYPES.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
        </label>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-6">
          <button type="submit" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700">
            Применить
          </button>
          <Link href="/activity" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            Сбросить
          </Link>
        </div>
      </form>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
          <span className="text-sm font-semibold text-slate-700">Журнал действий</span>
          <span className="text-xs text-slate-500">
            {result.total === 0 ? "Нет записей" : `${from}–${to} из ${result.total}`}
          </span>
        </div>
        <div className="hidden overflow-x-auto lg:block">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>Дата и время</Th>
                <Th>Пользователь</Th>
                <Th>Роль</Th>
                <Th>Компания</Th>
                <Th>Клуб</Th>
                <Th>Действие</Th>
                <Th>Объект</Th>
                <Th>Результат</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {result.rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-sm text-slate-500">
                    Записи не найдены.
                  </td>
                </tr>
              ) : (
                result.rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <Td className="whitespace-nowrap text-slate-600">{dtFormatter.format(row.createdAt)}</Td>
                    <Td className="whitespace-nowrap font-medium text-slate-900">{row.userName}</Td>
                    <Td className="whitespace-nowrap">{row.roleLabel}</Td>
                    <Td className="whitespace-nowrap">{row.companyName}</Td>
                    <Td className="whitespace-nowrap">{row.clubName}</Td>
                    <Td>{row.actionLabel}</Td>
                    <Td className="whitespace-nowrap">{row.objectLabel}</Td>
                    <Td>
                      <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${RESULT_TONE[row.result.tone]}`}>
                        {row.result.label}
                      </span>
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {/* Mobile cards — dense (§18/§19); technical fields collapsed. Desktop table above. */}
        <div className="space-y-3 p-3 lg:hidden">
          {result.rows.length === 0 ? (
            <EmptyState>Записи не найдены.</EmptyState>
          ) : (
            result.rows.map((row) => (
              <MobileDataCard
                key={row.id}
                title={row.actionLabel}
                badge={<StatusBadge tone={resultTone[row.result.tone] ?? "neutral"}>{row.result.label}</StatusBadge>}
                rows={[
                  { label: "Когда", value: dtFormatter.format(row.createdAt), tone: "muted" },
                  { label: "Кто", value: row.userName, strong: true },
                  { label: "Роль", value: row.roleLabel },
                  { label: "Клуб", value: row.clubName },
                ]}
                details={<div className="break-anywhere text-slate-600">Объект: {row.objectLabel}</div>}
              />
            ))
          )}
        </div>
        {result.totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3">
            <span className="text-xs text-slate-500">Стр. {result.page} из {result.totalPages}</span>
            <div className="flex gap-2">
              {result.page > 1 ? (
                <Link href={pageHref(result.page - 1)} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                  Назад
                </Link>
              ) : (
                <span className="rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-400">Назад</span>
              )}
              {result.page < result.totalPages ? (
                <Link href={pageHref(result.page + 1)} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                  Вперёд
                </Link>
              ) : (
                <span className="rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-400">Вперёд</span>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
