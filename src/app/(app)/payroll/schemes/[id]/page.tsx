import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { canManagePaySchemes, canActivateScheme, payrollNavMode } from "@/lib/payroll/access";
import { PAYROLL_POSITION_LABELS, PAYROLL_SCHEME_LABELS } from "@/lib/payroll/enums";
import { logicalSchemeKey, describeParamRows, diffParamRows } from "@/lib/payroll/scheme-version";
import { PayrollNav } from "../../_components/PayrollNav";
import { SchemeLifecycleActions } from "../../_components/SchemeLifecycleActions";

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

function parseParams(json: string): Record<string, unknown> {
  try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; }
}

export default async function SchemeVersionChainPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return <NoCompanyState title="Цепочка версий схемы" description="Версионируемые схемы оплаты" />;
  if (payrollNavMode(ctx.effectiveRoles) === "manager") redirect("/payroll");
  const companyId = ctx.selectedCompanyId;
  const { id } = await params;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);

  const anchor = await prisma.employeePayScheme.findUnique({ where: { id } });
  if (!anchor || anchor.companyId !== companyId || !clubIds.includes(anchor.clubId)) notFound();

  const chain = await prisma.employeePayScheme.findMany({
    where: { companyId, clubId: anchor.clubId, employeeId: anchor.employeeId, position: anchor.position },
    orderBy: [{ effectiveFrom: "asc" }],
  });
  const employee = anchor.employeeId ? await prisma.clubEmployee.findUnique({ where: { id: anchor.employeeId }, select: { fullName: true } }) : null;
  const clubName = clubs.find((c) => c.id === anchor.clubId)?.name ?? anchor.clubId;
  const targetLabel = anchor.employeeId ? (employee?.fullName ?? "Сотрудник") : `Вся категория · ${PAYROLL_POSITION_LABELS[anchor.position ?? ""] ?? anchor.position ?? "—"}`;

  const canAuthor = canManagePaySchemes(ctx.effectiveRoles);
  const canActivate = canActivateScheme(ctx.effectiveRoles);

  // Compare: the two most recent versions by effectiveFrom (spec §13).
  const compareBase = chain.length >= 2 ? chain[chain.length - 2] : null;
  const compareNew = chain.length >= 2 ? chain[chain.length - 1] : null;
  const diff = compareBase && compareNew ? diffParamRows(parseParams(compareBase.paramsJson), parseParams(compareNew.paramsJson)) : [];

  // Linked change requests for source display.
  const crIds = [...new Set(chain.map((s) => s.sourceChangeRequestId).filter((x): x is string => !!x))];
  const crs = crIds.length ? await prisma.payrollChangeRequest.findMany({ where: { id: { in: crIds } }, select: { id: true } }) : [];
  const crSet = new Set(crs.map((c) => c.id));

  return (
    <div className="mx-auto max-w-[900px]">
      <div className="mb-4"><Link href="/payroll/schemes" className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">← Схемы и версии</Link></div>
      <PageHeader title={targetLabel} description={`${clubName} · ${PAYROLL_SCHEME_LABELS[anchor.schemeType] ?? anchor.schemeType} · ${chain.length} верс.`} />
      <PayrollNav mode="full" />

      <p className="mb-5 break-all text-[11px] text-slate-400">Логический ключ: {logicalSchemeKey(anchor)}</p>

      {/* Compare (last two) */}
      {compareBase && compareNew ? (
        <div className={`mb-6 p-5 ${CARD}`}>
          <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Сравнение v{compareBase.version} → v{compareNew.version}</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead className="text-left text-xs text-slate-400"><tr><th className="py-1 pr-3 font-medium">Параметр</th><th className="py-1 pr-3 font-medium">Было (v{compareBase.version})</th><th className="py-1 font-medium">Стало (v{compareNew.version})</th></tr></thead>
              <tbody>
                {diff.map((d) => (
                  <tr key={d.key} className={d.changed ? "" : "text-slate-400"}>
                    <td className="py-1 pr-3">{d.label}</td>
                    <td className="py-1 pr-3 tabular-nums">{d.oldDisplay}</td>
                    <td className={`py-1 tabular-nums ${d.changed ? "font-medium text-emerald-600 dark:text-emerald-400" : ""}`}>{d.newDisplay}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* Version chain (newest first) */}
      <div className="space-y-4">
        {[...chain].reverse().map((s) => {
          const rows = describeParamRows(parseParams(s.paramsJson));
          return (
            <div key={s.id} className={`p-5 ${CARD}`}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">v{s.version}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[s.status] ?? STATUS_TONE.draft}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
                </div>
                <span className="text-xs text-slate-400">{dateFmt.format(s.effectiveFrom)}{s.effectiveTo ? ` — ${dateFmt.format(s.effectiveTo)}` : " — …"}</span>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                {rows.map((r) => (
                  <div key={r.key}><dt className="text-[11px] text-slate-400">{r.label}</dt><dd className="tabular-nums text-slate-800 dark:text-slate-200">{r.display}</dd></div>
                ))}
              </dl>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
                {s.approvedById ? <span>Согласовал: есть</span> : null}
                {s.sourceChangeRequestId && crSet.has(s.sourceChangeRequestId) ? <Link href={`/payroll/change-requests/${s.sourceChangeRequestId}`} className="text-brand-700 hover:underline dark:text-brand-300">Источник: заявка →</Link> : null}
                {s.comment ? <span>· {s.comment}</span> : null}
              </div>
              {canAuthor || canActivate ? (
                <div className="mt-3">
                  <SchemeLifecycleActions schemeId={s.id} status={s.status} canAuthor={canAuthor} canActivate={canActivate} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
