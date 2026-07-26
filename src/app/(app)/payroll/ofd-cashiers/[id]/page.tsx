import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";
import { canManageCashierMapping, payrollNavMode } from "@/lib/payroll/access";
import { suggestEmployee, toCandidate } from "@/lib/ofd/cashier-identity";
import { PayrollNav } from "../../_components/PayrollNav";
import { CashierMappingActions, type EmployeeOption } from "../../_components/CashierMappingActions";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const dtFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const STATUS_LABEL: Record<string, string> = {
  confirmed: "Подтверждён", manually_assigned: "Назначен вручную", auto_matched: "Авто-совпадение",
  ambiguous: "Спорный", unmatched: "Не сопоставлен", excluded: "Исключён", inactive: "Неактивен",
};

export default async function CashierIdentityPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return <NoCompanyState title="Кассир ОФД" description="Сопоставление кассира" />;
  if (payrollNavMode(ctx.effectiveRoles) === "manager") redirect("/payroll");
  const companyId = ctx.selectedCompanyId;
  const { id } = await params;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);

  const identity = await prisma.ofdCashierIdentity.findUnique({ where: { id } });
  if (!identity || identity.companyId !== companyId || (identity.clubId && !clubIds.includes(identity.clubId))) notFound();

  const mappings = await prisma.ofdCashierMapping.findMany({ where: { cashierIdentityId: identity.id }, orderBy: { effectiveFrom: "desc" } });
  const empIds = [...new Set(mappings.map((m) => m.employeeId).filter((x): x is string => !!x))];
  const empRows = empIds.length ? await prisma.clubEmployee.findMany({ where: { id: { in: empIds } }, select: { id: true, fullName: true } }) : [];
  const nameBy = new Map(empRows.map((e) => [e.id, e.fullName]));

  const clubEmployees = identity.clubId
    ? await prisma.clubEmployee.findMany({ where: { companyId, clubId: identity.clubId, status: "active" }, select: { id: true, fullName: true, status: true, hireDate: true, dismissedAt: true }, orderBy: { fullName: "asc" } })
    : [];
  const suggestion = suggestEmployee(identity.normalizedName, clubEmployees.map(toCandidate), identity.lastSeenAt);
  const suggestedEmployeeId = suggestion.status === "auto_matched" ? suggestion.employeeId : null;
  const options: EmployeeOption[] = clubEmployees.map((e) => ({ id: e.id, fullName: e.fullName }));
  const canManage = canManageCashierMapping(ctx.effectiveRoles);
  const clubName = clubs.find((c) => c.id === identity.clubId)?.name ?? "—";

  return (
    <div className="mx-auto max-w-[840px]">
      <div className="mb-4"><Link href="/payroll/ofd-cashiers" className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">← Кассиры ОФД</Link></div>
      <PageHeader title={identity.rawName} description={`${clubName} · ${identity.provider}`} />
      <PayrollNav mode="full" />

      <div className={`mb-4 grid grid-cols-2 gap-4 p-5 sm:grid-cols-4 ${CARD}`}>
        <Stat label="Нормализовано" value={identity.normalizedName} />
        <Stat label="Чеков" value={String(identity.receiptsCount)} />
        <Stat label="Продажи" value={formatKopeks(identity.salesAmountKopeks)} />
        <Stat label="Появления" value={`${dtFmt.format(identity.firstSeenAt)} — ${dtFmt.format(identity.lastSeenAt)}`} />
      </div>

      {suggestion.status === "ambiguous" ? (
        <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">Несколько кандидатов с таким ФИО — выберите сотрудника вручную. Чеки не распределяются, пока сопоставление не подтверждено.</div>
      ) : suggestion.status === "unmatched" ? (
        <div className="mb-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/40">Точного совпадения ФИО с активным сотрудником клуба нет — назначьте вручную.</div>
      ) : suggestedEmployeeId ? (
        <div className="mb-4 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">Предложение: {nameBy.get(suggestedEmployeeId) ?? clubEmployees.find((e) => e.id === suggestedEmployeeId)?.fullName} (точное совпадение ФИО). Подтвердите, чтобы распределять чеки.</div>
      ) : null}

      {canManage && identity.status !== "excluded" ? (
        <div className={`mb-4 p-5 ${CARD}`}>
          <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Сопоставление</div>
          <CashierMappingActions identityId={identity.id} employees={options} suggestedEmployeeId={suggestedEmployeeId} firstSeen={identity.firstSeenAt.toISOString().slice(0, 10)} />
        </div>
      ) : null}

      <div className={`p-5 ${CARD}`}>
        <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">История сопоставлений</div>
        {mappings.length === 0 ? (
          <div className="text-xs text-slate-400">Пока нет.</div>
        ) : (
          <ol className="space-y-2">
            {mappings.map((m) => (
              <li key={m.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="text-slate-400">{dtFmt.format(m.effectiveFrom)}{m.effectiveTo ? ` — ${dtFmt.format(m.effectiveTo)}` : " — …"}</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{STATUS_LABEL[m.status] ?? m.status}</span>
                {m.employeeId ? <span className="text-slate-600 dark:text-slate-300">→ {nameBy.get(m.employeeId) ?? m.employeeId}</span> : null}
                {m.excludedReason ? <span className="text-slate-500">— {m.excludedReason}</span> : null}
                {m.comment ? <span className="text-slate-500">· {m.comment}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><div className="text-xs text-slate-500 dark:text-slate-400">{label}</div><div className="text-sm font-medium text-slate-900 dark:text-slate-100 break-words">{value}</div></div>;
}
