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
  expensePeriod: string; // "YYYY-MM" for the month picker
  expensePeriodLabel: string; // "Май 2026"
  paidAtLabel: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  notes: string;
  status: string;
  confidence: string;
  clubName: string;
  fileStatus: "available" | "no_metadata" | "missing_object";
  correctionComment: string;
  correctionRequestedAtLabel: string;
  originalFileName: string;
  canDownload: boolean;
};

type SaveState = { ok: boolean; error?: string; invoiceId?: string };
const saveInitial: SaveState = { ok: false };

// Button styling per workflow action.
const ACTION_CLASS: Record<string, string> = {
  send_to_review: "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
  approve: "border-emerald-300 bg-emerald-600 text-white hover:bg-emerald-700",
  reject: "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100",
  cancel: "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100",
  pay: "border-brand-300 bg-brand-600 text-white hover:bg-brand-700",
};

// Irreversible actions require an explicit confirmation.
const CONFIRM_ACTIONS: Record<string, string> = {
  reject: "Отклонить счёт? Действие нельзя отменить.",
  cancel: "Отменить счёт? Действие нельзя отменить.",
};

// Status badge tone.
const STATUS_TONE: Record<string, string> = {
  paid: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  rejected: "bg-rose-50 text-rose-700 ring-rose-200",
  canceled: "bg-amber-50 text-amber-800 ring-amber-200",
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
            <div className="mt-1">
              <span
                className={`inline-flex rounded-full px-2.5 py-0.5 text-sm font-medium ring-1 ring-inset ${
                  STATUS_TONE[invoice.status] ?? "bg-slate-100 text-slate-700 ring-slate-200"
                }`}
              >
                {statusLabel}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span>Период расхода: <span className="font-medium text-slate-700">{invoice.expensePeriodLabel}</span></span>
              <span>Дата оплаты: <span className="font-medium text-slate-700">{invoice.paidAtLabel}</span></span>
            </div>
          </div>
          <DocumentBlock invoice={invoice} />
        </div>

        {/* Return for correction — a reason is required (regional/chief reviewer). */}
        {availableActions.includes("return_for_correction") ? (
          <form action={transitionInvoice} className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3">
            <input type="hidden" name="invoiceId" value={invoice.id} />
            <input type="hidden" name="action" value="return_for_correction" />
            <label className="block text-xs font-medium text-amber-900">
              Причина возврата на исправление (обязательно)
              <textarea name="reason" required minLength={5} rows={2} className="input mt-1" placeholder="Что нужно исправить управляющему" />
            </label>
            <button type="submit" className="mt-2 rounded-md border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100">
              Вернуть на исправление
            </button>
          </form>
        ) : null}

        {availableActions.filter((a) => a !== "return_for_correction").length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {availableActions.filter((a) => a !== "return_for_correction").map((action) => (
              <form
                key={action}
                action={transitionInvoice}
                onSubmit={(e) => {
                  const confirmText = CONFIRM_ACTIONS[action];
                  if (confirmText && !window.confirm(confirmText)) e.preventDefault();
                }}
              >
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
        ) : null}
        {availableActions.length === 0 ? (
          <div className="mt-4 text-sm text-slate-500">Нет доступных действий для вашей роли.</div>
        ) : null}
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
            <Field label="Период расхода">
              <input type="month" name="expensePeriod" defaultValue={invoice.expensePeriod} className="input" />
              <span className="mt-1 block text-xs text-slate-400">Месяц, к которому относится расход</span>
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

// Document block — always renders (the card never 404s for a file). Shows one of
// four states; working links appear only when the object is really present.
function DocumentBlock({ invoice }: { invoice: InvoiceView }) {
  if (invoice.fileStatus === "available") {
    return (
      <div className="flex flex-col items-start gap-1">
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">Файл доступен</span>
        <div className="flex flex-wrap items-center gap-4">
          <a
            href={`/api/invoices/${invoice.id}/file`}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-brand-600 hover:text-brand-700"
          >
            Открыть документ{invoice.originalFileName ? ` (${invoice.originalFileName})` : ""}
          </a>
          {invoice.canDownload ? (
            <a
              href={`/api/invoices/${invoice.id}/file?download=1`}
              className="text-sm font-medium text-slate-600 underline hover:text-slate-800"
            >
              Скачать
            </a>
          ) : null}
        </div>
      </div>
    );
  }
  if (invoice.fileStatus === "missing_object") {
    return (
      <div className="max-w-sm rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <div className="font-medium">Файл отсутствует в хранилище</div>
        <div className="mt-0.5">Данные счёта сохранены, но исходный документ недоступен.</div>
      </div>
    );
  }
  // no_metadata
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
      К счёту не прикреплён файл
    </span>
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
