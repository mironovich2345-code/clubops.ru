"use client";

import { useFormState, useFormStatus } from "react-dom";
import { recordPayment, recordAdvance, cancelPayment, cancelAdvance, type PayrollPaymentState } from "../periods/actions";
import { formatKopeks } from "@/lib/money";

const initial: PayrollPaymentState = { ok: false };

export type PaymentRow = { id: string; amountKopeks: number; method: string; status: string };
export type AdvanceRow = { id: string; amountKopeks: number; method: string };

const methodLabel = (m: string) => (m === "cash" ? "наличные" : m === "bank" ? "безнал" : m);

function SubmitBtn({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex items-center justify-center rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? "..." : label}
    </button>
  );
}

function MethodSelect({ canCash, canBank }: { canCash: boolean; canBank: boolean }) {
  return (
    <select name="method" defaultValue={canCash ? "cash" : "bank"} className="input text-sm">
      {canCash ? <option value="cash">Наличные</option> : null}
      {canBank ? <option value="bank">Безнал</option> : null}
    </select>
  );
}

export function PaymentsSection({
  calculationId,
  advance,
  payments,
  netPayableKopeks,
  paidKopeks,
  remainingKopeks,
  payable,
  canPayCash,
  canPayBank,
}: {
  calculationId: string;
  advance: AdvanceRow | null;
  payments: PaymentRow[];
  netPayableKopeks: number;
  paidKopeks: number;
  remainingKopeks: number;
  payable: boolean;
  canPayCash: boolean;
  canPayBank: boolean;
}) {
  const [payState, payAction] = useFormState(recordPayment, initial);
  const [advState, advAction] = useFormState(recordAdvance, initial);
  const canPay = payable && (canPayCash || canPayBank);

  return (
    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800/70">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Выплаты</span>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          К выплате {formatKopeks(netPayableKopeks)} · Выплачено {formatKopeks(paidKopeks)} ·{" "}
          <span className={remainingKopeks > 0 ? "text-amber-600" : remainingKopeks < 0 ? "text-rose-600" : "text-emerald-600"}>
            Остаток {formatKopeks(remainingKopeks)}
          </span>
        </span>
      </div>

      {/* Advance */}
      {advance ? (
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="text-slate-600 dark:text-slate-300">Аванс: {formatKopeks(advance.amountKopeks)} ({methodLabel(advance.method)})</span>
          {canPay ? (
            <form action={cancelAdvance} onSubmit={(e) => { if (!window.confirm("Отменить аванс?")) e.preventDefault(); }}>
              <input type="hidden" name="advanceId" value={advance.id} />
              <button type="submit" className="text-slate-400 hover:text-rose-600">отменить</button>
            </form>
          ) : null}
        </div>
      ) : null}

      {/* Payments list */}
      {payments.length > 0 ? (
        <ul className="mb-2 space-y-1">
          {payments.map((p) => (
            <li key={p.id} className="flex items-center justify-between text-xs">
              <span className="text-slate-600 dark:text-slate-300">
                {formatKopeks(p.amountKopeks)} · {methodLabel(p.method)}
                {p.status !== "confirmed" ? <span className="text-slate-400"> ({p.status})</span> : null}
              </span>
              {canPay && p.status === "confirmed" ? (
                <form action={cancelPayment} onSubmit={(e) => { if (!window.confirm("Отменить выплату? Наличные вернутся в кассу.")) e.preventDefault(); }}>
                  <input type="hidden" name="paymentId" value={p.id} />
                  <button type="submit" className="text-slate-400 hover:text-rose-600">✕</button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {canPay ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {/* Payment form */}
          <form action={payAction} className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-2 dark:bg-slate-800/40">
            <input type="hidden" name="calculationId" value={calculationId} />
            <MethodSelect canCash={canPayCash} canBank={canPayBank} />
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-500">Сумма, ₽</span>
              <input name="amount" type="number" min="0" step="0.01" className="input w-24 text-sm" />
            </label>
            <input name="documentKey" className="input w-28 text-sm" placeholder="Ведомость" />
            <SubmitBtn label="Выплатить" />
            {payState.error ? <span className="w-full text-[11px] text-rose-600">{payState.error}</span> : null}
          </form>

          {/* Advance form (only if none yet) */}
          {!advance ? (
            <form action={advAction} className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-2 dark:bg-slate-800/40">
              <input type="hidden" name="calculationId" value={calculationId} />
              <MethodSelect canCash={canPayCash} canBank={canPayBank} />
              <label className="block">
                <span className="mb-1 block text-[11px] text-slate-500">Аванс, ₽</span>
                <input name="amount" type="number" min="0" step="0.01" className="input w-24 text-sm" />
              </label>
              <input name="documentKey" className="input w-28 text-sm" placeholder="Документ" />
              <SubmitBtn label="Аванс" />
              {advState.error ? <span className="w-full text-[11px] text-rose-600">{advState.error}</span> : null}
            </form>
          ) : null}
        </div>
      ) : payable ? (
        <p className="text-xs text-slate-400">Выплату проводит управляющий/регионал (наличные) или бухгалтер (безнал).</p>
      ) : (
        <p className="text-xs text-slate-400">Выплаты станут доступны после утверждения периода.</p>
      )}
    </div>
  );
}
