"use client";

import { useFormState, useFormStatus } from "react-dom";
import { transitionInvoice, updateInvoice } from "../../actions";

type InvoiceView = {
  id: string;
  counterpartyName: string;
  counterpartyInn: string;
  counterpartyKpp: string;
  counterpartyBankName: string;
  counterpartyBankBik: string;
  counterpartyAccount: string;
  counterpartyCorrAccount: string;
  amount: string;
  currency: string;
  expenseCategory: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  notes: string;
  status: string;
  confidence: string;
  clubName: string;
  hasFile: boolean;
  originalFileName: string;
};

type SaveState = { ok: boolean; error?: string; invoiceId?: string };
const saveInitial: SaveState = { ok: false };

// Button styling per workflow action.
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

export function InvoiceEditForm({
  invoice,
  categories,
  availableActions,
  actionLabels,
  statusLabel,
  canEdit,
}: {
  invoice: InvoiceView;
  categories: readonly { key: string; label: string }[];
  availableActions: string[];
  actionLabels: Record<string, string>;
  statusLabel: string;
  canEdit: boolean;
}) {
  const [saved, saveAction] = useFormState(updateInvoice, saveInitial);

  return (
    <div className="space-y-6">
      {/* Workflow / status */}
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-700">Статус</div>
            <div className="mt-1 text-base font-medium text-slate-900">{statusLabel}</div>
          </div>
          {invoice.hasFile ? (
            <a
              href={`/api/invoices/${invoice.id}/file`}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-brand-600 hover:text-brand-700"
            >
              Открыть исходный файл{invoice.originalFileName ? ` (${invoice.originalFileName})` : ""}
            </a>
          ) : null}
        </div>

        {availableActions.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {availableActions.map((action) => (
              <form key={action} action={transitionInvoice}>
                <input type="hidden" name="invoiceId" value={invoice.id} />
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
      </div>

      {/* Editable fields */}
      {canEdit ? (
        <form action={saveAction} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <input type="hidden" name="invoiceId" value={invoice.id} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Контрагент">
              <input name="counterpartyName" defaultValue={invoice.counterpartyName} className="input" />
              <span className="mt-1 block text-xs text-slate-400">Поставщик / получатель оплаты</span>
            </Field>
            <Field label="ИНН">
              <input name="counterpartyInn" defaultValue={invoice.counterpartyInn} className="input" />
            </Field>
            <Field label="КПП">
              <input name="counterpartyKpp" defaultValue={invoice.counterpartyKpp} className="input" />
            </Field>
            <Field label="Банк">
              <input name="counterpartyBankName" defaultValue={invoice.counterpartyBankName} className="input" />
            </Field>
            <Field label="БИК">
              <input name="counterpartyBankBik" defaultValue={invoice.counterpartyBankBik} className="input" />
            </Field>
            <Field label="Расчётный счёт">
              <input name="counterpartyAccount" defaultValue={invoice.counterpartyAccount} className="input" />
            </Field>
            <Field label="Корр. счёт">
              <input name="counterpartyCorrAccount" defaultValue={invoice.counterpartyCorrAccount} className="input" />
            </Field>
            <Field label="Статья расходов">
              <select name="expenseCategory" defaultValue={invoice.expenseCategory} className="input">
                <option value="">—</option>
                {categories.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Сумма, ₽">
              <input name="amount" inputMode="decimal" defaultValue={invoice.amount} className="input" />
            </Field>
            <Field label="Валюта">
              <input name="currency" defaultValue={invoice.currency} className="input" />
            </Field>
            <Field label="Номер счёта">
              <input name="invoiceNumber" defaultValue={invoice.invoiceNumber} className="input" />
            </Field>
            <Field label="Дата счёта">
              <input type="date" name="invoiceDate" defaultValue={invoice.invoiceDate} className="input" />
            </Field>
            <Field label="Срок оплаты">
              <input type="date" name="dueDate" defaultValue={invoice.dueDate} className="input" />
            </Field>
            <div className="md:col-span-2">
              <Field label="Примечания">
                <textarea name="notes" rows={2} defaultValue={invoice.notes} className="input" />
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
          Счёт оплачен — редактирование доступно только владельцу или бухгалтеру.
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
