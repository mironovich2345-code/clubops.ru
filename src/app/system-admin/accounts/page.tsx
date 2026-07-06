import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentSystemAdmin } from "@/lib/system-role";
import { formatUserDisplayName } from "@/lib/user-display";
import { normalizeEmail } from "@/lib/normalize-email";
import { decryptEmail } from "@/lib/account-recovery";
import { AccountActions } from "./_components/AccountRow";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

type Status = "restored" | "restorable" | "expired";

export default async function SystemAdminAccountsPage() {
  const admin = await getCurrentSystemAdmin();
  if (!admin) redirect("/login");

  const rows = await prisma.accountDeletion.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { user: { select: { name: true, firstName: true, lastName: true, deletedAt: true, id: true } } },
  });

  const now = Date.now();
  const view = await Promise.all(
    rows.map(async (r) => {
      const status: Status = r.restoredAt ? "restored" : r.recoveryPurgedAt || r.restoreUntil.getTime() < now ? "expired" : "restorable";
      // Email-reuse flag WITHOUT revealing the new account.
      let reused = false;
      const original = decryptEmail(r.originalEmailEncrypted);
      if (original) {
        const taken = await prisma.user.findUnique({ where: { email: normalizeEmail(original) }, select: { id: true } });
        reused = Boolean(taken && taken.id !== r.userId);
      }
      return {
        id: r.id,
        name: formatUserDisplayName(r.user),
        masked: r.originalEmailMasked,
        deletedAt: r.deletedAt ?? r.createdAt,
        requestType: r.requestType,
        restoreUntil: r.restoreUntil,
        status,
        reused,
      };
    }),
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-lg font-semibold text-slate-900">Системное администрирование · Аккаунты</h1>
      <p className="mt-1 text-sm text-slate-500">Удалённые аккаунты и восстановление. Финансовые данные и документы не отображаются.</p>

      <div className="mt-5 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th>Пользователь</Th><Th>Email</Th><Th>Удалён</Th><Th>Инициатор</Th><Th>Восстановление до</Th><Th>Статус</Th><Th>Действия</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {view.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-slate-500">Удалённых аккаунтов нет.</td></tr>
            ) : view.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <Td className="font-medium text-slate-900">{r.name}</Td>
                <Td className="text-slate-600">{r.masked}{r.reused ? <span className="ml-1 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700 ring-1 ring-inset ring-amber-200">email переиспользован</span> : null}</Td>
                <Td className="whitespace-nowrap text-slate-500">{dateFmt.format(r.deletedAt)}</Td>
                <Td className="text-slate-600">{r.requestType === "self" ? "сам" : r.requestType === "owner" ? "собственник" : "сис.админ"}</Td>
                <Td className="whitespace-nowrap text-slate-500">{dateFmt.format(r.restoreUntil)}</Td>
                <Td>{r.status === "restored" ? "восстановлен" : r.status === "expired" ? "срок истёк" : "можно восстановить"}</Td>
                <Td><AccountActions deletionId={r.id} restorable={r.status === "restorable"} /></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
