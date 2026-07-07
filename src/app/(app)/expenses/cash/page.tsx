import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { requirePageAccess, getCurrentAccessContext, userHasClubRole, userHasCompanyRole } from "@/lib/access";
import { canCreateOperational } from "@/lib/auth";
import { formatKopeks } from "@/lib/money";
import { formatUserDisplayName } from "@/lib/user-display";
import { resolveActiveIpForClub } from "@/lib/expense-simplified";
import { getClubCashBreakdown, MOVEMENT, MSTATUS } from "@/lib/cash-wallets";
import { OpeningBalanceForm, OtherIncomeForm, TransferForm } from "./CashPanel";
import { confirmOtherIncomeAction, confirmTransferAction } from "../cash-actions";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

export default async function CashPage() {
  await requirePageAccess("expenses");
  const ctx = await getCurrentAccessContext();
  if (!ctx) redirect("/login");
  const companyId = ctx.selectedCompanyId;
  const clubId = ctx.selectedClubId ?? (ctx.allowedClubIds.length === 1 ? ctx.allowedClubIds[0] : null);
  if (!companyId || !clubId) redirect("/expenses");

  const ip = await resolveActiveIpForClub(clubId);
  if (!ip.ok) {
    return (
      <div>
        <PageHeader title="Касса ИП" description="Наличные клуба и региональных директоров" />
        <div className="mt-4 rounded-md bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">{ip.error}</div>
      </div>
    );
  }

  const [breakdown, isChief, isOwner, isRegional, canOp] = await Promise.all([
    getClubCashBreakdown(clubId, ip.legalEntityId),
    userHasClubRole(ctx.user.id, clubId, ["chief_accountant"]),
    userHasCompanyRole(ctx.user.id, companyId, ["owner"]),
    userHasClubRole(ctx.user.id, clubId, ["regional_director"]),
    Promise.resolve(canCreateOperational(ctx.effectiveRoles)),
  ]);
  const allWallets = ctx.effectiveRoles.some((r) => ["owner", "general_director", "regional_director", "accountant", "chief_accountant"].includes(r));

  // Pending confirmations for this Club (other income + transfers).
  const pending = canOp
    ? await prisma.cashMovement.findMany({
        where: { clubId, legalEntityId: ip.legalEntityId, status: MSTATUS.PENDING, type: { in: [MOVEMENT.OTHER_INCOME, MOVEMENT.TRANSFER] } },
        orderBy: { createdAt: "desc" }, take: 50,
      })
    : [];

  // Regional directors of this Club (transfer targets), by display name.
  const regionalUsers = canOp
    ? await prisma.user.findMany({
        where: { isActive: true, deletedAt: null, OR: [{ clubRoles: { some: { clubId, role: "regional_director" } } }, { companyAccess: { some: { companyId, role: "regional_director" } } }] },
        select: { id: true, name: true, firstName: true, lastName: true, deletedAt: true },
      })
    : [];

  return (
    <div className="max-w-3xl">
      <PageHeader title="Касса ИП" description="Наличные клуба и региональных директоров (только подтверждённые движения)" />

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Наличные в клубе</div>
          <div className="mt-1 text-xl font-semibold text-slate-900">
            {breakdown.hasOpeningBalance ? formatKopeks(breakdown.clubBalanceKopeks) : <span className="text-sm text-amber-700">Требуется задать начальный остаток</span>}
          </div>
          {!allWallets && breakdown.transferredToRegionalTotalKopeks > 0 ? (
            <div className="mt-1 text-xs text-slate-500">Передано региональному директору: {formatKopeks(breakdown.transferredToRegionalTotalKopeks)}</div>
          ) : null}
        </div>
        {allWallets ? (
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs font-medium text-slate-500">У региональных директоров</div>
            <div className="mt-1 text-xl font-semibold text-slate-900">{formatKopeks(breakdown.regionalTotalKopeks)}</div>
            <div className="mt-1 text-xs text-slate-500">Всего: {formatKopeks(breakdown.combinedKopeks)}</div>
          </div>
        ) : null}
      </div>

      {(isChief || isOwner) && !breakdown.hasOpeningBalance ? (
        <Section title="Начальный остаток"><OpeningBalanceForm /></Section>
      ) : null}

      {canOp ? (
        <>
          <Section title="Приход «Иное» (внешнее пополнение наличными — не продажа)"><OtherIncomeForm /></Section>
          <Section title="Перевод наличных между клубом и региональным директором">
            <TransferForm regionals={regionalUsers.map((r) => ({ userId: r.id, name: formatUserDisplayName(r) }))} canReturnFromRegional={isRegional} />
          </Section>
        </>
      ) : null}

      {pending.length > 0 ? (
        <Section title="Ожидают подтверждения получателем">
          <ul className="divide-y divide-slate-100">
            {pending.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="text-sm text-slate-700">
                  {m.type === MOVEMENT.OTHER_INCOME ? "Приход «Иное»" : "Перевод"} · {formatKopeks(m.amountKopeks)} · {dateFmt.format(m.occurredAt)}
                  {m.comment ? <span className="ml-1 text-xs text-slate-500">· {m.comment}</span> : null}
                </div>
                <form action={m.type === MOVEMENT.OTHER_INCOME ? confirmOtherIncomeAction : confirmTransferAction}>
                  <input type="hidden" name="movementId" value={m.id} />
                  <button type="submit" className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100">Подтвердить</button>
                </form>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 text-sm font-semibold text-slate-700">{title}</div>
      {children}
    </div>
  );
}
