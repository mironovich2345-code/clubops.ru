"use client";

import { useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { formatKopeks } from "@/lib/money";
import { buttonClass } from "@/components/mobile/buttons";
import { MobileDataCard } from "@/components/mobile/density";
import { recordInvoicePayment, reverseInvoicePayment } from "../../actions";

type PaymentRow = {
  id: string; amountKopeks: number; paymentDate: string; source: string; method: string | null; comment: string | null;
  status: string; author: string; reversedBy: string | null; reversalReason: string | null; enteredAfterPayment: boolean; legacyBackfill: boolean;
};
export type PaymentView = {
  invoiceTotalKopeks: number; paidTotalKopeks: number; remainingTotalKopeks: number; status: string; rows: PaymentRow[];
};

const initial = { ok: false } as { ok: boolean; error?: string };
const SOURCE_LABELS: Record<string, string> = { bank: "Банк", edo: "ЭДО", cash: "Наличные", other: "Другое", legacy_backfill: "Перенос (legacy)" };
const STATUS_LABELS: Record<string, string> = { confirmed: "Подтверждён", reversed: "Сторнирован" };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className={`${buttonClass({ variant: "primary", size: "cta" })} w-full sm:w-auto`}>{pending ? "Сохранение..." : label}</button>;
}

export function InvoicePaymentPanel({ invoiceId, view, canRecord, canReverse, today }: { invoiceId: string; view: PaymentView; canRecord: boolean; canReverse: boolean; today: string }) {
  const [state, action] = useFormState(recordInvoicePayment, initial);
  const [mode, setMode] = useState<"full" | "partial">("full");
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [state]);
  const remaining = view.remainingTotalKopeks;
  const [partialRub, setPartialRub] = useState("");
  const currentKopeks = mode === "full" ? remaining : Math.round((Number(partialRub.replace(",", ".")) || 0) * 100);
  const afterKopeks = remaining - currentKopeks;

  return (
    <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">История оплат</div>

      {/* Totals */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Сумма счёта" value={formatKopeks(view.invoiceTotalKopeks)} />
        <Stat label="Оплачено" value={formatKopeks(view.paidTotalKopeks)} tone="success" />
        <Stat label="Осталось" value={formatKopeks(remaining)} tone={remaining > 0 ? "warn" : undefined} />
        <Stat label="Статус" value={view.status === "paid" ? "Оплачен" : view.status === "partially_paid" ? "Оплачен частично" : "Ожидает оплаты"} />
      </div>

      {/* «Отметить оплату» */}
      {canRecord && remaining > 0 ? (
        <form action={action} className="mb-4 grid grid-cols-1 gap-3 rounded-md border border-slate-200 p-3 dark:border-slate-700 sm:grid-cols-2">
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <input type="hidden" name="mode" value={mode} />
          <div className="sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-slate-500">Тип оплаты</span>
            <div className="flex gap-2">
              <label className="inline-flex items-center gap-1.5 text-sm"><input type="radio" name="__mode" checked={mode === "full"} onChange={() => setMode("full")} /> Оплачено полностью</label>
              <label className="inline-flex items-center gap-1.5 text-sm"><input type="radio" name="__mode" checked={mode === "partial"} onChange={() => setMode("partial")} /> Оплачено частично</label>
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Сумма платежа, ₽</span>
            {mode === "full" ? (
              <input readOnly value={(remaining / 100).toFixed(2)} className="input w-full bg-slate-50 dark:bg-slate-800" />
            ) : (
              <input name="amount" inputMode="decimal" required value={partialRub} onChange={(e) => setPartialRub(e.target.value)} placeholder="0,00" className="input w-full" />
            )}
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Дата платежа</span>
            <input type="date" name="paymentDate" required defaultValue={today} className="input w-full" style={{ fontSize: 16 }} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Способ / источник</span>
            <select name="source" defaultValue="bank" className="input w-full">
              <option value="bank">Банк</option><option value="edo">ЭДО</option><option value="cash">Наличные</option><option value="other">Другое</option>
            </select>
          </label>
          <label className="block"><span className="mb-1 block text-xs font-medium text-slate-500">Комментарий</span><input name="comment" className="input w-full" /></label>
          <div className="sm:col-span-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            Сумма счёта: {formatKopeks(view.invoiceTotalKopeks)} · Ранее оплачено: {formatKopeks(view.paidTotalKopeks)} · Текущий платёж: {formatKopeks(Math.max(0, currentKopeks))} · Останется после оплаты: {formatKopeks(Math.max(0, afterKopeks))}
          </div>
          <div className="sm:col-span-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            {state.error ? <span className="text-sm text-rose-600 dark:text-rose-400">{state.error}</span> : <span />}
            <Submit label="Сохранить оплату" />
          </div>
        </form>
      ) : null}

      {/* Payment history — append-only */}
      {view.rows.length === 0 ? (
        <div className="text-sm text-slate-500">Платежей пока нет.</div>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 lg:block dark:border-slate-800">
            <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
              <thead className="bg-slate-50 dark:bg-slate-800/50"><tr><Th>Дата</Th><Th>Сумма</Th><Th>Источник</Th><Th>Способ</Th><Th>Автор</Th><Th>Статус</Th><Th>Комментарий</Th><Th>Действия</Th></tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {view.rows.map((p) => (
                  <tr key={p.id} className={p.status === "reversed" ? "text-slate-400" : undefined}>
                    <Td>{p.paymentDate}</Td>
                    <Td>{formatKopeks(p.amountKopeks)}</Td>
                    <Td>{SOURCE_LABELS[p.source] ?? p.source}{p.enteredAfterPayment ? " · после оплаты" : ""}{p.legacyBackfill ? " · legacy" : ""}</Td>
                    <Td>{p.method ?? "—"}</Td>
                    <Td>{p.author}</Td>
                    <Td>{STATUS_LABELS[p.status] ?? p.status}{p.reversedBy ? ` · ${p.reversedBy}` : ""}</Td>
                    <Td>{p.reversalReason ? `Сторно: ${p.reversalReason}` : p.comment ?? "—"}</Td>
                    <Td>{canReverse && p.status === "confirmed" ? <ReverseButton paymentId={p.id} /> : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-3 lg:hidden">
            {view.rows.map((p) => (
              <MobileDataCard key={p.id} title={`${p.paymentDate} · ${formatKopeks(p.amountKopeks)}`}
                badge={<span className="text-xs font-medium text-[var(--text-muted)]">{STATUS_LABELS[p.status] ?? p.status}</span>}
                rows={[
                  { label: "Источник", value: (SOURCE_LABELS[p.source] ?? p.source) + (p.enteredAfterPayment ? " · после оплаты" : "") },
                  { label: "Автор", value: p.author },
                  ...(p.reversalReason ? [{ label: "Сторно", value: p.reversalReason }] : p.comment ? [{ label: "Комментарий", value: p.comment }] : []),
                ]}
                footer={canReverse && p.status === "confirmed" ? <ReverseButton paymentId={p.id} /> : undefined}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ReverseButton({ paymentId }: { paymentId: string }) {
  const [state, action] = useFormState(reverseInvoicePayment, initial);
  return (
    <details className="inline-block">
      <summary className="cursor-pointer text-xs font-medium text-rose-600 dark:text-rose-400">Сторнировать</summary>
      <form action={action} className="mt-2 flex flex-col gap-1.5 rounded-md border border-rose-200 bg-white p-2 shadow-sm dark:border-rose-800 dark:bg-slate-900">
        <input type="hidden" name="paymentId" value={paymentId} />
        <input name="reason" required placeholder="Причина сторно (обязательно)" className="input text-xs" />
        <button type="submit" className="rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-500/10 dark:text-rose-300">Подтвердить сторно</button>
        {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
      </form>
    </details>
  );
}
function Stat({ label, value, tone }: { label: string; value: string; tone?: "success" | "warn" }) {
  const c = tone === "success" ? "text-emerald-700 dark:text-emerald-400" : tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-slate-900 dark:text-slate-100";
  return <div className="rounded-md border border-slate-200 p-2.5 dark:border-slate-800"><div className="truncate text-[11px] text-slate-500">{label}</div><div className={`mt-0.5 truncate text-sm font-semibold tabular-nums ${c}`}>{value}</div></div>;
}
function Th({ children }: { children: React.ReactNode }) { return <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</th>; }
function Td({ children }: { children: React.ReactNode }) { return <td className="px-3 py-2 align-top text-slate-700 dark:text-slate-300">{children}</td>; }
