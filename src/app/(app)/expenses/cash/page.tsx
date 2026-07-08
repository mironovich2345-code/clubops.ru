import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { requirePageAccess, getCurrentAccessContext, userHasClubRole } from "@/lib/access";
import { canCreateOperational } from "@/lib/auth";
import { formatKopeks } from "@/lib/money";
import { formatUserDisplayName } from "@/lib/user-display";
import { resolveActiveIpForClub } from "@/lib/expense-simplified";
import { getClubCashBreakdown, getClubOpeningBalance, MOVEMENT, MSTATUS } from "@/lib/cash-wallets";
import { OpeningBalanceForm, OtherIncomeForm, TransferForm, PendingTransfers } from "./CashPanel";
import { confirmOtherIncomeAction } from "../cash-actions";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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

  const [breakdown, isRegional, isManager, canOp, openingInfo, ipRows] = await Promise.all([
    getClubCashBreakdown(clubId, ip.legalEntityId),
    userHasClubRole(ctx.user.id, clubId, ["regional_director"]),
    userHasClubRole(ctx.user.id, clubId, ["manager"]),
    Promise.resolve(canCreateOperational(ctx.effectiveRoles)),
    getClubOpeningBalance(clubId, ip.legalEntityId),
    // Active ИП linked to this club (ООО excluded) — options for the form.
    prisma.clubLegalEntity.findMany({
      where: { clubId, isActive: true, legalEntity: { isActive: true, type: { in: ["ip", "ИП"] } } },
      select: { legalEntity: { select: { id: true, name: true } } },
    }),
  ]);
  const allWallets = ctx.effectiveRoles.some((r) => ["owner", "general_director", "regional_director", "accountant", "chief_accountant"].includes(r));
  const ipOptions = ipRows.map((r) => ({ id: r.legalEntity.id, name: r.legalEntity.name }));
  const canCreateTransfer = isManager || isRegional;

  // Author + ИП names for the "Начальный остаток задан" detail card.
  const openingAuthor = openingInfo?.createdByUserId
    ? await prisma.user.findUnique({ where: { id: openingInfo.createdByUserId }, select: { name: true, firstName: true, lastName: true, deletedAt: true } })
    : null;
  const openingIpName = openingInfo ? (ipOptions.find((o) => o.id === openingInfo.legalEntityId)?.name ?? null) : null;
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { name: true } });

  // «Приход Иное» pending confirmations for this Club.
  const otherIncomePending = canOp
    ? await prisma.cashMovement.findMany({ where: { clubId, legalEntityId: ip.legalEntityId, status: MSTATUS.PENDING, type: MOVEMENT.OTHER_INCOME }, orderBy: { createdAt: "desc" }, take: 50 })
    : [];

  // Two-way transfers (pending + recent confirmed) for this Club.
  const transfers = canOp
    ? await prisma.cashMovement.findMany({
        where: { clubId, legalEntityId: ip.legalEntityId, type: MOVEMENT.TRANSFER, status: { in: [MSTATUS.PENDING, MSTATUS.CONFIRMED] } },
        orderBy: [{ createdAt: "desc" }], take: 40,
        select: { id: true, amountKopeks: true, occurredAt: true, comment: true, status: true, confirmedByUserId: true, confirmedAt: true, fromWallet: { select: { type: true, holderUserId: true } }, toWallet: { select: { type: true, holderUserId: true } } },
      })
    : [];

  // Resolve display names for regionals (transfer targets) + confirmers.
  const regionalUsers = canOp
    ? await prisma.user.findMany({
        where: { isActive: true, deletedAt: null, OR: [{ clubRoles: { some: { clubId, role: "regional_director" } } }, { companyAccess: { some: { companyId, role: "regional_director" } } }] },
        select: { id: true, name: true, firstName: true, lastName: true, deletedAt: true },
      })
    : [];
  const extraIds = Array.from(new Set(transfers.flatMap((m) => [m.confirmedByUserId, m.toWallet?.holderUserId].filter(Boolean) as string[])));
  const extraUsers = extraIds.length ? await prisma.user.findMany({ where: { id: { in: extraIds } }, select: { id: true, name: true, firstName: true, lastName: true, deletedAt: true } }) : [];
  const nameMap = new Map<string, string>();
  for (const u of [...regionalUsers, ...extraUsers]) nameMap.set(u.id, formatUserDisplayName(u));
  const nameOf = (id: string | null | undefined) => (id ? (nameMap.get(id) ?? "—") : "—");

  const transferRows = transfers.map((m) => {
    const toRegional = m.toWallet?.type === "regional_cash";
    return {
      id: m.id,
      directionLabel: toRegional ? "Клуб → Директор" : "Директор → Клуб",
      amountText: formatKopeks(m.amountKopeks),
      dateText: dateFmt.format(m.occurredAt),
      comment: m.comment,
      confirmed: m.status === MSTATUS.CONFIRMED,
      statusLabel: m.status === MSTATUS.CONFIRMED ? "Получено" : toRegional ? "Ожидает подтверждения директором" : "Ожидает подтверждения клубом",
      counterpartyLabel: toRegional ? `Получатель: ${nameOf(m.toWallet?.holderUserId)}` : `Получатель: ${club?.name ?? "Клуб"}`,
      confirmedByName: m.confirmedByUserId ? nameOf(m.confirmedByUserId) : null,
      confirmedAtText: m.confirmedAt ? dateTimeFmt.format(m.confirmedAt) : null,
      // Only the true recipient may confirm (re-checked on the server too).
      canConfirm: m.status === MSTATUS.PENDING && (toRegional ? m.toWallet?.holderUserId === ctx.user.id && isRegional : isManager),
    };
  });

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

      {breakdown.hasOpeningBalance && openingInfo ? (
        <Section title="Начальный остаток">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">Начальный остаток задан</span>
            <span className="text-lg font-semibold text-slate-900">{formatKopeks(openingInfo.amountKopeks)}</span>
          </div>
          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
            <div><dt className="inline text-slate-500">Дата остатка: </dt><dd className="inline">{dateFmt.format(openingInfo.occurredAt)}</dd></div>
            <div><dt className="inline text-slate-500">ИП: </dt><dd className="inline">{openingIpName ?? "—"}</dd></div>
            <div><dt className="inline text-slate-500">Касса: </dt><dd className="inline">Касса клуба</dd></div>
            <div><dt className="inline text-slate-500">Задал: </dt><dd className="inline">{openingAuthor ? formatUserDisplayName(openingAuthor) : "—"}</dd></div>
            {openingInfo.comment ? <div className="sm:col-span-2"><dt className="inline text-slate-500">Комментарий: </dt><dd className="inline">{openingInfo.comment}</dd></div> : null}
          </dl>
        </Section>
      ) : isRegional ? (
        <Section title="Начальный остаток">
          <OpeningBalanceForm ipOptions={ipOptions} defaultDate={todayISO()} clubName={club?.name ?? null} />
        </Section>
      ) : null}

      {canOp ? (
        <Section title="Приход «Иное» (внешнее пополнение наличными — не продажа)"><OtherIncomeForm /></Section>
      ) : null}

      {canCreateTransfer ? (
        <Section title="Передача наличных">
          <TransferForm
            regionals={regionalUsers.map((r) => ({ userId: r.id, name: formatUserDisplayName(r) }))}
            canCreateToRegional={isManager || isRegional}
            canCreateToClub={isRegional}
          />
        </Section>
      ) : null}

      {canOp && transferRows.length > 0 ? (
        <Section title="Передачи наличных (ожидают подтверждения / получено)">
          <PendingTransfers rows={transferRows} />
        </Section>
      ) : null}

      {otherIncomePending.length > 0 ? (
        <Section title="Приход «Иное» — ожидают подтверждения получателем">
          <ul className="divide-y divide-slate-100">
            {otherIncomePending.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="text-sm text-slate-700">
                  Приход «Иное» · {formatKopeks(m.amountKopeks)} · {dateFmt.format(m.occurredAt)}
                  {m.comment ? <span className="ml-1 text-xs text-slate-500">· {m.comment}</span> : null}
                </div>
                <form action={confirmOtherIncomeAction}>
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
