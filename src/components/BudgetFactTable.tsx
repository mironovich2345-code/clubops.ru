import { formatKopeks } from "@/lib/money";
import type { BudgetFactRow, BudgetFactStatus } from "@/lib/budgets";

const STATUS_META: Record<BudgetFactStatus, { label: string; badge: string; bar: string }> = {
  normal: {
    label: "Норма",
    badge: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    bar: "bg-emerald-500",
  },
  warning: {
    label: "Близко к лимиту",
    badge: "bg-amber-50 text-amber-800 ring-amber-200",
    bar: "bg-amber-500",
  },
  over_budget: {
    label: "Превышен",
    badge: "bg-rose-50 text-rose-700 ring-rose-200",
    bar: "bg-rose-500",
  },
};

function diffText(diffKopeks: number): { text: string; cls: string } {
  if (diffKopeks > 0) return { text: `+${formatKopeks(diffKopeks)}`, cls: "text-rose-700" };
  if (diffKopeks < 0) return { text: `−${formatKopeks(Math.abs(diffKopeks))}`, cls: "text-emerald-700" };
  return { text: formatKopeks(0), cls: "text-slate-600" };
}

/** Shared Plan vs Fact table (dashboard + budgets page). Presentational only. */
export function BudgetFactTable({
  rows,
  emptyText = "Лимиты не заданы — нет данных для сравнения.",
}: {
  rows: BudgetFactRow[];
  emptyText?: string;
}) {
  if (rows.length === 0) {
    return <div className="px-4 py-8 text-center text-sm text-slate-500">{emptyText}</div>;
  }
  return (
    <table className="min-w-full divide-y divide-slate-200">
      <thead className="bg-slate-50">
        <tr>
          <Th>Статья</Th>
          <Th className="text-right">План</Th>
          <Th className="text-right">Факт</Th>
          <Th className="text-right">Разница</Th>
          <Th className="text-right">%</Th>
          <Th>Статус</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 bg-white">
        {rows.map((row) => {
          const meta = STATUS_META[row.status];
          const diff = diffText(row.differenceKopeks);
          const barWidth = Math.min(100, Math.max(2, row.completionPercent));
          return (
            <tr key={row.category} className="hover:bg-slate-50">
              <Td className="font-medium text-slate-900">{row.label}</Td>
              <Td className="whitespace-nowrap text-right">{formatKopeks(row.budgetKopeks)}</Td>
              <Td className="whitespace-nowrap text-right">{formatKopeks(row.actualKopeks)}</Td>
              <Td className={`whitespace-nowrap text-right font-medium ${diff.cls}`}>{diff.text}</Td>
              <Td className="text-right">
                <div className="font-medium text-slate-900">{row.completionPercent.toFixed(0)}%</div>
                <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${meta.bar}`} style={{ width: `${barWidth}%` }} />
                </div>
              </Td>
              <Td>
                <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${meta.badge}`}>
                  {meta.label}
                </span>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
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
