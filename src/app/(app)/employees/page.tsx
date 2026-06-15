import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import {
  canManageEmployees,
  getEmployeesForScope,
  employeePositionLabel,
  EMPLOYEE_POSITIONS,
  EMPLOYEE_POSITION_KEYS,
  EMPLOYEE_STATUS_FILTERS,
  type ClubEmployeeRow,
} from "@/lib/club-employees";
import { EmployeeForm } from "./_components/EmployeeForm";
import { DismissEmployeeButton } from "./_components/DismissEmployeeButton";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

type SearchParams = { club?: string; position?: string; status?: string };

export default async function EmployeesPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const user = await requirePageAccess("employees");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) {
    return <NoCompanyState title="Сотрудники" description="Управляющие, администраторы и тренеры клубов" />;
  }
  const companyId = ctx.selectedCompanyId;
  const params = (await searchParams) ?? {};

  // Role-correct accessible clubs (not narrowed by the topbar club cookie):
  // owner / GD see every company club, regional its assigned clubs, manager own.
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);

  const statusFilter = params.status === "active" || params.status === "dismissed" || params.status === "all"
    ? params.status
    : "active";
  const positionFilter = params.position && EMPLOYEE_POSITION_KEYS.has(params.position) ? params.position : "";
  const clubFilter = params.club && clubIds.includes(params.club) ? params.club : "";

  const rows = await getEmployeesForScope(companyId, clubIds, {
    clubId: clubFilter || undefined,
    position: positionFilter || undefined,
    status: statusFilter === "all" ? undefined : statusFilter,
  });

  const canManage = canManageEmployees(ctx.effectiveRoles);
  const showClubColumn = clubs.length > 1;

  // Group by position, preserving the canonical position order.
  const byPosition = new Map<string, ClubEmployeeRow[]>();
  for (const r of rows) {
    const list = byPosition.get(r.position) ?? [];
    list.push(r);
    byPosition.set(r.position, list);
  }
  const orderedPositions = [
    ...EMPLOYEE_POSITIONS.map((p) => p.key as string),
    ...[...byPosition.keys()].filter((k) => !EMPLOYEE_POSITION_KEYS.has(k)),
  ].filter((k) => byPosition.has(k));

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Сотрудники" description="Управляющие, администраторы и тренеры клубов" />

      {canManage ? (
        <div className={`mb-6 p-5 ${CARD}`}>
          <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Добавить сотрудника</div>
          {clubs.length === 0 ? (
            <div className="text-sm text-slate-500 dark:text-slate-400">Нет доступных клубов.</div>
          ) : (
            <EmployeeForm clubs={clubs} />
          )}
        </div>
      ) : (
        <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Доступен только просмотр списка сотрудников.
        </div>
      )}

      {/* Filters (GET form — keeps state in the URL) */}
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3">
        {showClubColumn ? (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Клуб</span>
            <select name="club" defaultValue={clubFilter} className="input">
              <option value="">Все клубы</option>
              {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        ) : null}
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Должность</span>
          <select name="position" defaultValue={positionFilter} className="input">
            <option value="">Все должности</option>
            {EMPLOYEE_POSITIONS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Статус</span>
          <select name="status" defaultValue={statusFilter} className="input">
            {EMPLOYEE_STATUS_FILTERS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <button type="submit" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
          Применить
        </button>
      </form>

      {rows.length === 0 ? (
        <div className={`px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>
          Сотрудники не найдены.
        </div>
      ) : (
        <div className="space-y-6">
          {orderedPositions.map((position) => (
            <div key={position} className={`overflow-hidden ${CARD}`}>
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{employeePositionLabel(position)}</span>
                <span className="text-xs text-slate-400">{byPosition.get(position)!.length}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
                  <thead className="bg-slate-50 dark:bg-slate-800/50">
                    <tr>
                      <Th>ФИО</Th>
                      {showClubColumn ? <Th>Клуб</Th> : null}
                      <Th>Статус</Th>
                      <Th>Комментарий</Th>
                      {canManage ? <Th className="text-right">Действия</Th> : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                    {byPosition.get(position)!.map((e) => (
                      <tr key={e.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">{e.fullName}</Td>
                        {showClubColumn ? <Td className="whitespace-nowrap">{e.clubName}</Td> : null}
                        <Td className="whitespace-nowrap">
                          {e.status === "dismissed" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                              Уволен{e.dismissedAt ? ` · ${dateFmt.format(e.dismissedAt)}` : ""}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                              Активен
                            </span>
                          )}
                        </Td>
                        <Td className="max-w-[18rem] truncate text-slate-500 dark:text-slate-400">{e.comment ?? "—"}</Td>
                        {canManage ? (
                          <Td className="text-right">
                            {e.status === "active" ? <div className="flex justify-end"><DismissEmployeeButton id={e.id} name={e.fullName} /></div> : <span className="text-xs text-slate-400">—</span>}
                          </Td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th scope="col" className={`whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${className ?? ""}`}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 align-middle text-sm text-slate-700 dark:text-slate-300 ${className ?? ""}`}>{children}</td>;
}
