import { formatKopeks } from "@/lib/money";
import { expenseCategoryLabel } from "@/lib/expenses";

const CARD = "rounded-lg border border-slate-200 bg-white shadow-sm";
const dtf = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

export type InvoiceAnalyticsRow = {
  status: string;
  amountKopeks: number;
  expenseCategory: string | null;
  clubName: string;
  dueDate: string | null; // ISO
  paidAt: string | null; // ISO
  invoiceNumber: string | null;
  counterpartyName: string | null;
};

const AWAITING = new Set(["needs_review", "approved_by_regional", "approved_by_owner"]);
const FINISHED = new Set(["paid", "canceled", "rejected"]);

/**
 * Read-only invoice analytics for the strategic (owner / GD) view. Financial
 * totals come from invoice amounts; payment status (paid / awaiting / overdue)
 * uses paidAt / dueDate — the two concepts are kept separate, never mixed.
 * Canceled invoices are excluded from totals. No NaN/Infinity.
 */
export function InvoiceAnalytics({ rows, todayISO }: { rows: InvoiceAnalyticsRow[]; todayISO: string }) {
  const today = new Date(todayISO);
  const active = rows.filter((r) => r.status !== "canceled");

  const totalKopeks = active.reduce((s, r) => s + r.amountKopeks, 0);
  const paidKopeks = active.filter((r) => r.status === "paid").reduce((s, r) => s + r.amountKopeks, 0);
  const awaitingKopeks = active.filter((r) => AWAITING.has(r.status)).reduce((s, r) => s + r.amountKopeks, 0);
  const overdue = active.filter((r) => !FINISHED.has(r.status) && r.dueDate && new Date(r.dueDate) < today);
  const overdueKopeks = overdue.reduce((s, r) => s + r.amountKopeks, 0);

  const byCategory = groupSum(active, (r) => r.expenseCategory ?? "—");
  const byClub = groupSum(active, (r) => r.clubName);

  const upcoming = active
    .filter((r) => !FINISHED.has(r.status) && r.dueDate)
    .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime())
    .slice(0, 5);

  return (
    <div className="mb-6 space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Сумма счетов" value={formatKopeks(totalKopeks)} />
        <Stat label="Оплачено" value={formatKopeks(paidKopeks)} accent="text-emerald-700" />
        <Stat label="Ожидает оплаты" value={formatKopeks(awaitingKopeks)} accent="text-amber-700" />
        <Stat label="Просрочено" value={formatKopeks(overdueKopeks)} accent={overdueKopeks > 0 ? "text-rose-700" : undefined} sub={overdue.length > 0 ? `${overdue.length} шт.` : "нет"} />
        <Stat label="Счетов" value={String(active.length)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Breakdown title="По статьям" rows={byCategory.map((x) => ({ label: expenseCategoryLabel(x.key), amountKopeks: x.amountKopeks }))} total={totalKopeks} />
        <Breakdown title="По клубам" rows={byClub.map((x) => ({ label: x.key, amountKopeks: x.amountKopeks }))} total={totalKopeks} />
        <div className={`overflow-hidden ${CARD}`}>
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">Ближайшие платежи</div>
          {upcoming.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-slate-500">Нет предстоящих платежей</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {upcoming.map((r, i) => (
                <li key={i} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-slate-800">{r.counterpartyName ?? r.invoiceNumber ?? "Счёт"}</div>
                    <div className="text-xs text-slate-500">{r.clubName}{r.dueDate ? ` · до ${dtf.format(new Date(r.dueDate))}` : ""}</div>
                  </div>
                  <span className="whitespace-nowrap text-sm font-medium text-slate-900">{formatKopeks(r.amountKopeks)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function groupSum(rows: InvoiceAnalyticsRow[], keyOf: (r: InvoiceAnalyticsRow) => string) {
  const m = new Map<string, number>();
  for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + r.amountKopeks);
  return [...m.entries()].map(([key, amountKopeks]) => ({ key, amountKopeks })).sort((a, b) => b.amountKopeks - a.amountKopeks);
}

function Stat({ label, value, accent, sub }: { label: string; value: string; accent?: string; sub?: string }) {
  return (
    <div className={`p-4 ${CARD}`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 truncate text-lg font-semibold ${accent ?? "text-slate-900"}`}>{value}</div>
      {sub ? <div className="text-[11px] text-slate-400">{sub}</div> : null}
    </div>
  );
}

function Breakdown({ title, rows, total }: { title: string; rows: Array<{ label: string; amountKopeks: number }>; total: number }) {
  return (
    <div className={`overflow-hidden ${CARD}`}>
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">{title}</div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-slate-500">Нет данных</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.slice(0, 8).map((r, i) => {
            const pct = total > 0 ? (r.amountKopeks / total) * 100 : 0;
            return (
              <li key={i} className="px-4 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm text-slate-700">{r.label}</span>
                  <span className="text-sm font-medium text-slate-900">{formatKopeks(r.amountKopeks)}</span>
                </div>
                <div className="mt-1 text-right text-[11px] text-slate-400">{pct.toFixed(1)}%</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
