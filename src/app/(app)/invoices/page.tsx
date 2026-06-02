import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/auth";
import { ensureDemoData } from "@/lib/seed";
import { formatKopeks } from "@/lib/money";
import {
  getClubsForUser,
  getInvoicesForUser,
  summarize,
  type StatusSummary,
} from "@/lib/invoices";
import { CreateInvoiceForm } from "./_components/CreateInvoiceForm";
import { InvoiceRowActions } from "./_components/InvoiceRowActions";
import { StatusBadge } from "./_components/StatusBadge";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

export default async function InvoicesPage() {
  const user = await requirePageAccess("invoices");
  await ensureDemoData();

  const [clubs, invoices] = await Promise.all([
    getClubsForUser(user),
    getInvoicesForUser(user),
  ]);

  const summary = summarize(invoices);

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <PageHeader title="Счета" description="Контроль счетов, оплат и просрочек" />
      </div>

      <SummarySection summary={summary} />

      <CreateInvoiceForm clubs={clubs} />

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th>Статус</Th>
              <Th>Контрагент</Th>
              <Th>Назначение</Th>
              <Th className="text-right">Сумма</Th>
              <Th>Дата счёта</Th>
              <Th>Срок оплаты</Th>
              <Th>Комментарий</Th>
              <Th>Действия</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {invoices.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-slate-500">
                  Пока нет счетов. Нажмите «Добавить счёт», чтобы создать первый.
                </td>
              </tr>
            ) : (
              invoices.map((invoice) => (
                <tr key={invoice.id} className="hover:bg-slate-50">
                  <Td>
                    <StatusBadge status={invoice.status} dueDate={invoice.dueDate} />
                  </Td>
                  <Td>
                    <div className="font-medium text-slate-900">{invoice.counterpartyName}</div>
                    <div className="text-xs text-slate-500">{invoice.club.name}</div>
                  </Td>
                  <Td>{invoice.subject}</Td>
                  <Td className="whitespace-nowrap text-right font-medium text-slate-900">
                    {formatKopeks(invoice.amountKopeks)}
                  </Td>
                  <Td className="whitespace-nowrap">{dateFormatter.format(invoice.invoiceDate)}</Td>
                  <Td className="whitespace-nowrap">{dateFormatter.format(invoice.dueDate)}</Td>
                  <Td className="max-w-xs">
                    <div className="line-clamp-2 text-slate-600">{invoice.comment ?? "—"}</div>
                  </Td>
                  <Td>
                    <InvoiceRowActions invoiceId={invoice.id} status={invoice.status} />
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

function SummarySection({ summary }: { summary: StatusSummary }) {
  const cards: Array<{
    key: keyof StatusSummary;
    label: string;
    accent: string;
  }> = [
    { key: "unpaid", label: "Не оплачено", accent: "text-amber-700" },
    { key: "overdue", label: "Просрочено", accent: "text-rose-700" },
    { key: "paid", label: "Оплачено", accent: "text-emerald-700" },
    { key: "rejected", label: "Отклонено", accent: "text-slate-600" },
  ];
  return (
    <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <div
          key={card.key}
          className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
        >
          <div className="text-sm font-medium text-slate-500">{card.label}</div>
          <div className={`mt-2 text-2xl font-semibold ${card.accent}`}>
            {formatKopeks(summary[card.key].amountKopeks)}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Счетов: {summary[card.key].count}
          </div>
        </div>
      ))}
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
