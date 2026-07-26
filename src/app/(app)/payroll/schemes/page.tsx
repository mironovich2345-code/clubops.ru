import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { canManagePaySchemes, payrollNavMode } from "@/lib/payroll/access";
import { PAYROLL_POSITION_LABELS, PAYROLL_SCHEME_LABELS } from "@/lib/payroll/enums";
import { logicalSchemeKey, isLiveForResolver } from "@/lib/payroll/scheme-version";
import { PayrollNav } from "../_components/PayrollNav";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const STATUS_TONE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  pending_approval: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  approved: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  scheduled: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300",
  active: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  superseded: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  archived: "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500",
  rejected: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  cancelled: "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500",
};
const STATUS_LABEL: Record<string, string> = {
  draft: "Черновик", pending_approval: "На согласовании", approved: "Согласована", scheduled: "Запланирована",
  active: "Действует", superseded: "Заменена", archived: "В архиве", rejected: "Отклонена", cancelled: "Отменена",
};

export default async function PayrollSchemesPage({ searchParams }: { searchParams: Promise<{ club?: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return <NoCompanyState title="Схемы и версии" description="Версионируемые схемы оплаты" />;
  // Schemes are not a club-manager screen — they only see the applied scheme in the calc.
  if (payrollNavMode(ctx.effectiveRoles) === "manager") redirect("/payroll");
  const companyId = ctx.selectedCompanyId;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const clubName = (id: string) => clubs.find((c) => c.id === id)?.name ?? id;
  const sp = await searchParams;
  const clubFilter = sp.club && clubIds.includes(sp.club) ? sp.club : null;

  const rows = clubIds.length
    ? await prisma.employeePayScheme.findMany({ where: { companyId, clubId: clubFilter ? clubFilter : { in: clubIds } }, orderBy: [{ effectiveFrom: "asc" }] })
    : [];
  const empIds = [...new Set(rows.map((r) => r.employeeId).filter((x): x is string => !!x))];
  const emps = empIds.length ? await prisma.clubEmployee.findMany({ where: { id: { in: empIds } }, select: { id: true, fullName: true } }) : [];
  const nameBy = new Map(emps.map((e) => [e.id, e.fullName]));

  // Group into logical chains.
  const now = Date.now();
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) { const k = logicalSchemeKey(r); const l = byKey.get(k) ?? []; l.push(r); byKey.set(k, l); }
  const chains = [...byKey.entries()].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
    const live = sorted.filter((s) => isLiveForResolver(s.status));
    const current = live.filter((s) => s.effectiveFrom.getTime() <= now && (s.effectiveTo == null || s.effectiveTo.getTime() > now));
    const next = sorted.find((s) => s.status === "scheduled" || (isLiveForResolver(s.status) && s.effectiveFrom.getTime() > now));
    const cur = current[current.length - 1] ?? sorted.find((s) => s.status === "active") ?? null;
    const rep = cur ?? sorted[sorted.length - 1];
    const problems = current.length >= 2; // ≥2 live covering now = conflict
    const first = sorted[0];
    return {
      key, rep, clubId: first.clubId, employeeId: first.employeeId, position: first.position,
      currentVersion: cur?.version ?? null, currentStatus: cur?.status ?? sorted[sorted.length - 1].status,
      effectiveFrom: cur?.effectiveFrom ?? null, effectiveTo: cur?.effectiveTo ?? null,
      next: next ? { version: next.version, from: next.effectiveFrom } : null, problems, count: sorted.length,
      schemeType: rep.schemeType,
    };
  }).sort((a, b) => clubName(a.clubId).localeCompare(clubName(b.clubId)));

  const targetLabel = (employeeId: string | null, position: string | null) =>
    employeeId ? (nameBy.get(employeeId) ?? "Сотрудник") : `Вся категория · ${PAYROLL_POSITION_LABELS[position ?? ""] ?? position ?? "—"}`;

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader title="Схемы и версии" description="Версионируемые схемы оплаты: цепочки версий, статусы, даты действия." />
      <PayrollNav mode="full" />

      {clubs.length > 1 ? (
        <div className="mb-4 flex flex-wrap gap-2 text-xs">
          <FilterLink href="/payroll/schemes" active={!clubFilter}>Все клубы</FilterLink>
          {clubs.map((c) => <FilterLink key={c.id} href={`/payroll/schemes?club=${c.id}`} active={clubFilter === c.id}>{c.name}</FilterLink>)}
        </div>
      ) : null}

      {chains.length === 0 ? (
        <div className={`px-4 py-10 text-center text-sm text-slate-500 ${CARD}`}>Схем пока нет. Схемы создаются в карточке сотрудника или через согласование изменений.</div>
      ) : (
        <>
          {/* Desktop */}
          <div className={`hidden overflow-hidden sm:block ${CARD}`}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/60">
                  <tr>
                    <th className="px-4 py-2 font-medium">Клуб</th>
                    <th className="px-4 py-2 font-medium">Категория / сотрудник</th>
                    <th className="px-4 py-2 font-medium">Версия</th>
                    <th className="px-4 py-2 font-medium">Статус</th>
                    <th className="px-4 py-2 font-medium">Действует</th>
                    <th className="px-4 py-2 font-medium">Следующая</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {chains.map((c) => (
                    <tr key={c.key} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{clubName(c.clubId)}</td>
                      <td className="px-4 py-2 text-slate-800 dark:text-slate-200">{targetLabel(c.employeeId, c.position)}<div className="text-[11px] text-slate-400">{PAYROLL_SCHEME_LABELS[c.schemeType] ?? c.schemeType}</div></td>
                      <td className="px-4 py-2 tabular-nums">v{c.currentVersion ?? "—"}{c.problems ? <span className="ml-1 text-rose-600" title="Конфликт версий">⚠</span> : null}</td>
                      <td className="px-4 py-2"><Badge status={c.currentStatus} /></td>
                      <td className="px-4 py-2 text-xs text-slate-500">{c.effectiveFrom ? dateFmt.format(c.effectiveFrom) : "—"}{c.effectiveTo ? ` — ${dateFmt.format(c.effectiveTo)}` : c.effectiveFrom ? " — …" : ""}</td>
                      <td className="px-4 py-2 text-xs text-slate-500">{c.next ? `v${c.next.version} с ${dateFmt.format(c.next.from)}` : "—"}</td>
                      <td className="px-4 py-2 text-right"><Link href={`/payroll/schemes/${c.rep.id}`} className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">История версий →</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <ul className="space-y-3 sm:hidden">
            {chains.map((c) => (
              <li key={c.key} className={`p-4 ${CARD}`}>
                <div className="mb-1 flex items-start justify-between gap-2">
                  <div className="font-medium text-slate-800 dark:text-slate-200">{targetLabel(c.employeeId, c.position)}</div>
                  <Badge status={c.currentStatus} />
                </div>
                <div className="text-xs text-slate-500">{clubName(c.clubId)} · {PAYROLL_SCHEME_LABELS[c.schemeType] ?? c.schemeType}</div>
                <div className="mt-1 text-sm tabular-nums">Версия v{c.currentVersion ?? "—"}{c.problems ? <span className="ml-1 text-rose-600">⚠ конфликт</span> : null}</div>
                <div className="text-xs text-slate-500">Действует: {c.effectiveFrom ? dateFmt.format(c.effectiveFrom) : "—"}{c.effectiveTo ? ` — ${dateFmt.format(c.effectiveTo)}` : ""}</div>
                {c.next ? <div className="text-xs text-indigo-600 dark:text-indigo-400">Далее: v{c.next.version} с {dateFmt.format(c.next.from)}</div> : null}
                <Link href={`/payroll/schemes/${c.rep.id}`} className="mt-2 inline-flex text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">История версий →</Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {!canManagePaySchemes(ctx.effectiveRoles) ? <p className="mt-4 text-xs text-slate-400">Просмотр только для чтения — управление схемами доступно региональному директору, ГД, собственнику и главному бухгалтеру.</p> : null}
    </div>
  );
}

function Badge({ status }: { status: string }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[status] ?? STATUS_TONE.draft}`}>{STATUS_LABEL[status] ?? status}</span>;
}
function FilterLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return <Link href={href} className={`rounded-full px-3 py-1 font-medium transition-colors ${active ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"}`}>{children}</Link>;
}
