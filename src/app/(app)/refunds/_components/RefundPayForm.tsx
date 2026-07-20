"use client";

import { useFormState, useFormStatus } from "react-dom";
import { payRefundV2 } from "../refund-document-actions";

type State = { ok: boolean; error?: string; refundId?: string };
const initial: State = { ok: false };

export type LegalEntityOption = { id: string; name: string; type: string };

const TYPE_LABEL: Record<string, string> = { ooo: "ООО", ip: "ИП" };

/**
 * The single financial control for a v2 refund: the accountant chooses the paying
 * legal entity + payment date and marks it paid. The server (payRefundV2) re-checks
 * role, scope, status, legal-entity validity and the closed-month guard.
 */
export function RefundPayForm({
  refundId,
  amountLabel,
  legalEntities,
  todayIso,
}: {
  refundId: string;
  amountLabel: string;
  legalEntities: LegalEntityOption[];
  todayIso: string;
}) {
  const [state, formAction] = useFormState(payRefundV2, initial);

  return (
    <div className="mt-6 rounded-lg border border-emerald-200 bg-white p-5 shadow-sm">
      <div className="mb-1 text-sm font-semibold text-slate-800">Оплата возврата</div>
      <p className="mb-4 text-xs text-slate-500">
        Отметьте возврат оплаченным. Сумма к выплате: <span className="font-medium text-slate-700">{amountLabel}</span>.
      </p>

      {legalEntities.length === 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          У клуба нет активного юридического лица. Оплата невозможна, пока юрлицо не привязано к клубу.
        </div>
      ) : (
        <form
          action={formAction}
          onSubmit={(e) => {
            if (!window.confirm("Отметить возврат оплаченным? Действие фиксируется в учёте.")) e.preventDefault();
          }}
        >
          <input type="hidden" name="refundId" value={refundId} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">Юридическое лицо</span>
              <select name="legalEntityId" required defaultValue="" className="input">
                <option value="" disabled>Выберите юрлицо</option>
                {legalEntities.map((le) => (
                  <option key={le.id} value={le.id}>
                    {le.name}{le.type ? ` · ${TYPE_LABEL[le.type] ?? le.type}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">Дата оплаты</span>
              <input type="date" name="paidAt" defaultValue={todayIso} className="input" />
            </label>
            <div className="md:col-span-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">Комментарий / номер платежа</span>
                <input name="paymentComment" className="input" placeholder="Необязательно" />
              </label>
            </div>
          </div>

          {state.error ? (
            <div className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
              {state.error}
            </div>
          ) : null}

          <div className="mt-5 flex justify-end">
            <PayButton />
          </div>
        </form>
      )}
    </div>
  );
}

function PayButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
    >
      {pending ? "Сохранение..." : "Оплачено"}
    </button>
  );
}
