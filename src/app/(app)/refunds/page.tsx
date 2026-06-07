import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks } from "@/lib/money";
import {
  requirePageAccess,
  getCurrentCompanyAndClub,
  getClubsInScope,
  getCurrentAccessContext,
} from "@/lib/access";
import { canCreateOperational } from "@/lib/auth";
import { getRefundsForScope, REFUND_DOC_TYPES } from "@/lib/refunds";
import { APPROVAL_STATUS_LABELS } from "@/lib/approval";
import { RefundUpload } from "./_components/RefundUpload";
import { ExportButton } from "@/components/ExportButton";
import { canExport } from "@/lib/exports";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

export default async function RefundsPage() {
  const user = await requirePageAccess("refunds");

  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Возвраты" description="Загрузка и согласование возвратов" />;
  }

  const [clubs, refunds, ctx] = await Promise.all([
    getClubsInScope(scope),
    getRefundsForScope(scope),
    getCurrentAccessContext(),
  ]);
  const canCreate = ctx ? canCreateOperational(ctx.effectiveRoles) : false;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="Возвраты" description="Загрузка документов, согласование и оплата возвратов" />
        {ctx && canExport(ctx.effectiveRoles, "refunds") ? <div className="pt-1"><ExportButton type="refunds" /></div> : null}
      </div>

      {canCreate && clubs.length > 0 ? (
        <RefundUpload clubs={clubs} docTypes={REFUND_DOC_TYPES} companyName={scope.company.name} />
      ) : null}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th>Клиент</Th>
              <Th className="text-right">Сумма</Th>
              <Th>Договор</Th>
              <Th>Статус</Th>
              <Th>Клуб</Th>
              <Th>Создан</Th>
              <Th>Действия</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {refunds.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-slate-500">
                  Пока нет возвратов. Загрузите документы или заполните вручную.
                </td>
              </tr>
            ) : (
              refunds.map((refund) => (
                <tr key={refund.id} className="hover:bg-slate-50">
                  <Td>
                    <div className="font-medium text-slate-900">{refund.clientName ?? "— без клиента —"}</div>
                    {refund.clientPhone ? (
                      <div className="text-xs text-slate-500">{refund.clientPhone}</div>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-right font-medium text-slate-900">
                    {formatKopeks(refund.amountKopeks)}
                  </Td>
                  <Td>{refund.contractNumber ?? "—"}</Td>
                  <Td className="whitespace-nowrap">
                    {APPROVAL_STATUS_LABELS[refund.status] ?? refund.status}
                  </Td>
                  <Td className="whitespace-nowrap text-slate-600">{refund.club.name}</Td>
                  <Td className="whitespace-nowrap text-slate-500">
                    {dateFormatter.format(refund.createdAt)}
                  </Td>
                  <Td>
                    <Link
                      href={`/refunds/${refund.id}`}
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Открыть
                    </Link>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
