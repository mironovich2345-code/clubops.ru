import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks } from "@/lib/money";
import {
  requirePageAccess,
  getCurrentCompanyAndClub,
  getCurrentAccessContext,
  getClubsInScope,
  getCompanyMembers,
} from "@/lib/access";
import { canManageMandatoryPayments } from "@/lib/auth";
import {
  getMandatoryPaymentsForScope,
  getMandatoryPaymentForContext,
  mandatoryCategoryLabel,
  MANDATORY_PAYMENT_CATEGORIES,
  MANDATORY_RECURRENCES,
  MANDATORY_RECURRENCE_LABELS,
  MANDATORY_STATUS_LABELS,
} from "@/lib/mandatory-payments";
import { MandatoryPaymentForm, type EditingPlan } from "./_components/MandatoryPaymentForm";
import { pauseMandatoryPayment, activateMandatoryPayment, cancelMandatoryPayment } from "./actions";

export const dynamic = "force-dynamic";

const dueDateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default async function MandatoryPaymentsPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const user = await requirePageAccess("mandatory_payments");
  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Обязательные платежи" description="Регулярные и разовые обязательные платежи" />;
  }
  const ctx = await getCurrentAccessContext();
  if (!ctx) {
    return <NoCompanyState title="Обязательные платежи" description="Регулярные и разовые обязательные платежи" />;
  }
  const canManage = canManageMandatoryPayments(ctx.effectiveRoles);

  const sp = await searchParams;
  const [clubs, plans] = await Promise.all([getClubsInScope(scope), getMandatoryPaymentsForScope(scope)]);

  // Responsible-user options + the edited plan are only needed when managing.
  let users: { id: string; name: string }[] = [];
  let editing: EditingPlan | undefined;
  if (canManage) {
    const members = await getCompanyMembers(scope.company.id);
    const byId = new Map<string, string>();
    for (const m of members) if (m.user.isActive) byId.set(m.user.id, m.user.name);
    users = [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));

    if (sp.edit) {
      const plan = await getMandatoryPaymentForContext(ctx, sp.edit);
      if (plan) {
        editing = {
          id: plan.id,
          clubId: plan.clubId,
          category: plan.category,
          title: plan.title,
          amountRub: String(plan.amountKopeks / 100),
          recurrence: plan.recurrence,
          dueDayOfMonth: plan.dueDayOfMonth,
          dueDate: plan.dueDate ? isoDay(plan.dueDate) : "",
          responsibleUserId: plan.responsibleUserId ?? "",
          notes: plan.notes ?? "",
        };
      }
    }
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <PageHeader title="Обязательные платежи" description="Регулярные и разовые обязательные платежи" />
        {canManage && editing ? (
          <Link href="/mandatory-payments" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            Новый платёж
          </Link>
        ) : null}
      </div>

      {canManage ? (
        <div className="mb-6">
          <MandatoryPaymentForm
            clubs={clubs.map((c) => ({ key: c.id, label: c.name }))}
            categories={MANDATORY_PAYMENT_CATEGORIES.map((c) => ({ key: c.key, label: c.label }))}
            recurrences={MANDATORY_RECURRENCES.map((r) => ({ key: r.key, label: r.label }))}
            users={users}
            editing={editing}
          />
        </div>
      ) : (
        <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Управлять обязательными платежами может собственник или ген.директор
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 dark:border-slate-800 dark:text-slate-200">
          Платежи ({plans.length})
        </div>
        {plans.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400">Обязательных платежей пока нет.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <Th>Клуб</Th>
                  <Th>Категория</Th>
                  <Th>Название</Th>
                  <Th className="text-right">Сумма</Th>
                  <Th>День оплаты</Th>
                  <Th>Повтор</Th>
                  <Th>Ответственный</Th>
                  <Th>Статус</Th>
                  {canManage ? <Th className="text-right">Действия</Th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {plans.map((p) => (
                  <tr key={p.id} className={p.status === "canceled" ? "opacity-60" : "hover:bg-slate-50 dark:hover:bg-slate-800/40"}>
                    <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">{p.clubName}</Td>
                    <Td className="whitespace-nowrap">{mandatoryCategoryLabel(p.category)}</Td>
                    <Td>{p.title}</Td>
                    <Td className="whitespace-nowrap text-right font-medium text-slate-900 dark:text-slate-100">{formatKopeks(p.amountKopeks)}</Td>
                    <Td className="whitespace-nowrap">
                      {p.recurrence === "monthly" ? (p.dueDayOfMonth ?? "—") : p.dueDate ? dueDateFmt.format(p.dueDate) : "—"}
                    </Td>
                    <Td className="whitespace-nowrap">{MANDATORY_RECURRENCE_LABELS[p.recurrence] ?? p.recurrence}</Td>
                    <Td className="whitespace-nowrap">{p.responsibleName ?? "—"}</Td>
                    <Td className="whitespace-nowrap"><StatusBadge status={p.status} /></Td>
                    {canManage ? (
                      <Td className="whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-2">
                          {p.status !== "canceled" ? (
                            <Link href={`/mandatory-payments?edit=${p.id}`} className="text-xs font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400">Изменить</Link>
                          ) : null}
                          {p.status === "planned" ? <InlineAction action={pauseMandatoryPayment} id={p.id} label="Пауза" /> : null}
                          {p.status === "paused" ? <InlineAction action={activateMandatoryPayment} id={p.id} label="Возобновить" /> : null}
                          {p.status !== "canceled" ? <InlineAction action={cancelMandatoryPayment} id={p.id} label="Отменить" tone="danger" /> : null}
                        </div>
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function InlineAction({ action, id, label, tone }: { action: (fd: FormData) => Promise<void>; id: string; label: string; tone?: "danger" }) {
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" className={`text-xs font-medium ${tone === "danger" ? "text-rose-600 hover:text-rose-700 dark:text-rose-400" : "text-slate-600 hover:text-slate-900 dark:text-slate-300"}`}>
        {label}
      </button>
    </form>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "planned"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20"
      : status === "paused"
        ? "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20"
        : "bg-slate-100 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700";
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${cls}`}>{MANDATORY_STATUS_LABELS[status] ?? status}</span>;
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th scope="col" className={`whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${className ?? ""}`}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 align-middle text-sm text-slate-700 dark:text-slate-300 ${className ?? ""}`}>{children}</td>;
}
