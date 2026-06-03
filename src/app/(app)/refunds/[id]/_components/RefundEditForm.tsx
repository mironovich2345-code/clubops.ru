"use client";

import { useFormState, useFormStatus } from "react-dom";
import { transitionRefund, updateRefund } from "../../actions";

type RefundDoc = { storageKey: string; fileName: string; typeLabel: string };

type RefundView = {
  id: string;
  clientName: string;
  clientPhone: string;
  amount: string;
  currency: string;
  reason: string;
  contractNumber: string;
  refundDate: string;
  bankRecipientName: string;
  bankName: string;
  bankBik: string;
  bankAccount: string;
  notes: string;
  clubName: string;
  documents: RefundDoc[];
};

type SaveState = { ok: boolean; error?: string; refundId?: string };
const saveInitial: SaveState = { ok: false };

const ACTION_CLASS: Record<string, string> = {
  send_to_review: "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
  approve: "border-emerald-300 bg-emerald-600 text-white hover:bg-emerald-700",
  reject: "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100",
  pay: "border-brand-300 bg-brand-600 text-white hover:bg-brand-700",
};

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Сохранение..." : "Сохранить изменения"}
    </button>
  );
}

export function RefundEditForm({
  refund,
  availableActions,
  actionLabels,
  statusLabel,
  canEdit,
}: {
  refund: RefundView;
  availableActions: string[];
  actionLabels: Record<string, string>;
  statusLabel: string;
  canEdit: boolean;
}) {
  const [saved, saveAction] = useFormState(updateRefund, saveInitial);

  return (
    <div className="space-y-6">
      {/* Workflow + documents */}
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="text-sm font-semibold text-slate-700">Статус</div>
        <div className="mt-1 text-base font-medium text-slate-900">{statusLabel}</div>

        {availableActions.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {availableActions.map((action) => (
              <form key={action} action={transitionRefund}>
                <input type="hidden" name="refundId" value={refund.id} />
                <input type="hidden" name="action" value={action} />
                <button
                  type="submit"
                  className={`rounded-md border px-3 py-2 text-sm font-medium ${
                    ACTION_CLASS[action] ?? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {actionLabels[action] ?? action}
                </button>
              </form>
            ))}
          </div>
        ) : (
          <div className="mt-4 text-sm text-slate-500">Нет доступных действий для вашей роли.</div>
        )}

        {refund.documents.length > 0 ? (
          <div className="mt-5 border-t border-slate-200 pt-4">
            <div className="mb-2 text-sm font-medium text-slate-700">Документы</div>
            <ul className="space-y-1">
              {refund.documents.map((doc) => (
                <li key={doc.storageKey}>
                  <a
                    href={`/api/refunds/${refund.id}/file?key=${encodeURIComponent(doc.storageKey)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-brand-600 hover:text-brand-700"
                  >
                    {doc.typeLabel}: {doc.fileName}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {/* Editable fields */}
      {canEdit ? (
        <form action={saveAction} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <input type="hidden" name="refundId" value={refund.id} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Клиент">
              <input name="clientName" defaultValue={refund.clientName} className="input" />
            </Field>
            <Field label="Телефон клиента">
              <input name="clientPhone" defaultValue={refund.clientPhone} className="input" />
            </Field>
            <Field label="Сумма, ₽">
              <input name="amount" inputMode="decimal" defaultValue={refund.amount} className="input" />
            </Field>
            <Field label="Валюта">
              <input name="currency" defaultValue={refund.currency} className="input" />
            </Field>
            <Field label="Номер договора">
              <input name="contractNumber" defaultValue={refund.contractNumber} className="input" />
            </Field>
            <Field label="Дата возврата">
              <input type="date" name="refundDate" defaultValue={refund.refundDate} className="input" />
            </Field>
            <Field label="Получатель (банк)">
              <input name="bankRecipientName" defaultValue={refund.bankRecipientName} className="input" />
            </Field>
            <Field label="Банк">
              <input name="bankName" defaultValue={refund.bankName} className="input" />
            </Field>
            <Field label="БИК">
              <input name="bankBik" defaultValue={refund.bankBik} className="input" />
            </Field>
            <Field label="Счёт получателя">
              <input name="bankAccount" defaultValue={refund.bankAccount} className="input" />
            </Field>
            <div className="md:col-span-2">
              <Field label="Причина возврата">
                <textarea name="reason" rows={2} defaultValue={refund.reason} className="input" />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="Примечания">
                <textarea name="notes" rows={2} defaultValue={refund.notes} className="input" />
              </Field>
            </div>
          </div>

          {saved.ok ? (
            <div className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
              Изменения сохранены.
            </div>
          ) : saved.error ? (
            <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
              {saved.error}
            </div>
          ) : null}

          <div className="mt-5 flex justify-end">
            <SaveButton />
          </div>
        </form>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">
          Возврат оплачен — редактирование доступно только владельцу или бухгалтеру.
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}
