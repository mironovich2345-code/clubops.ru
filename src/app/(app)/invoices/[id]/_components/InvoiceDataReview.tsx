"use client";

import { useFormState, useFormStatus } from "react-dom";
import { reviewInvoiceData } from "../../actions";

// The AI-extracted invoice fields the accountant / owner verifies before payment.
// This is a SANITIZED projection of the invoice — never the raw AI JSON, prompt,
// stack trace or any other company's data. Warnings are pre-parsed on the server.
export type InvoiceReviewView = {
  id: string;
  counterpartyName: string;
  counterpartyInn: string;
  counterpartyKpp: string;
  counterpartyBankName: string;
  counterpartyBankBik: string;
  counterpartyAccount: string;
  counterpartyCorrAccount: string;
  payerName: string;
  payerInn: string;
  payerKpp: string;
  subject: string;
  amount: string;
  currency: string;
  expenseCategory: string;
  expensePeriod: string; // "YYYY-MM"
  invoiceNumber: string;
  invoiceDate: string; // "YYYY-MM-DD"
  dueDate: string; // "YYYY-MM-DD"
  aiDataReviewNote: string;
  confidence: string;
  confidenceLabel: string;
  isLowConfidence: boolean;
  warnings: string[];
  reviewedAtLabel: string; // "" when never reviewed
  reviewedByName: string; // "" when unknown / never reviewed
  payBlocked: boolean; // server payment guard is armed
  payBlockReason: string; // exact server reason ("" when not blocked)
};

type SaveState = { ok: boolean; error?: string; invoiceId?: string };
const saveInitial: SaveState = { ok: false };

const CONFIDENCE_TONE: Record<string, string> = {
  high: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  medium: "bg-amber-50 text-amber-800 ring-amber-200",
  low: "bg-rose-50 text-rose-700 ring-rose-200",
};

export function InvoiceDataReview({
  invoice,
  categories,
  canReview,
}: {
  invoice: InvoiceReviewView;
  categories: readonly { key: string; label: string }[];
  canReview: boolean;
}) {
  const [saved, saveAction] = useFormState(reviewInvoiceData, saveInitial);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Данные счёта</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Распознано автоматически. Проверьте контрагента, сумму и реквизиты перед оплатой.
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${
            CONFIDENCE_TONE[invoice.confidence] ?? "bg-slate-100 text-slate-700 ring-slate-200"
          }`}
        >
          Уверенность ИИ: {invoice.confidenceLabel}
        </span>
      </div>

      {/* Review status */}
      <div className="mt-3 text-xs text-slate-500">
        {invoice.reviewedAtLabel ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-emerald-700 ring-1 ring-inset ring-emerald-200">
            Проверено{invoice.reviewedByName ? ` · ${invoice.reviewedByName}` : ""} · {invoice.reviewedAtLabel}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-slate-600 ring-1 ring-inset ring-slate-200">
            Данные ещё не проверены бухгалтером
          </span>
        )}
      </div>

      {/* Payment guard notice — the exact reason the server would refuse payment. */}
      {invoice.payBlocked ? (
        <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {invoice.payBlockReason || "Оплата заблокирована до проверки данных счёта."}
        </div>
      ) : null}

      {/* AI warnings (parsed on the server — never raw JSON) */}
      {invoice.warnings.length > 0 ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <div className="font-medium">Предупреждения ИИ</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {invoice.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {canReview ? (
        <form action={saveAction} className="mt-5">
          <input type="hidden" name="invoiceId" value={invoice.id} />

          <Group title="Основное">
            <Field label="Контрагент">
              <input name="counterpartyName" defaultValue={invoice.counterpartyName} className="input" />
            </Field>
            <Field label="ИНН">
              <input name="counterpartyInn" inputMode="numeric" defaultValue={invoice.counterpartyInn} className="input" />
            </Field>
            <Field label="КПП">
              <input name="counterpartyKpp" inputMode="numeric" defaultValue={invoice.counterpartyKpp} className="input" />
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
            <Field label="Сумма, ₽">
              <input name="amount" inputMode="decimal" defaultValue={invoice.amount} className="input" />
            </Field>
            <Field label="Валюта">
              <input name="currency" defaultValue={invoice.currency} className="input" />
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
            <Field label="Период расхода">
              <input type="month" name="expensePeriod" defaultValue={invoice.expensePeriod} className="input" />
            </Field>
          </Group>

          <Group title="Плательщик">
            <Field label="Плательщик">
              <input name="payerName" defaultValue={invoice.payerName} className="input" />
            </Field>
            <Field label="ИНН плательщика">
              <input name="payerInn" inputMode="numeric" defaultValue={invoice.payerInn} className="input" />
            </Field>
            <Field label="КПП плательщика">
              <input name="payerKpp" inputMode="numeric" defaultValue={invoice.payerKpp} className="input" />
            </Field>
          </Group>

          <Group title="Реквизиты">
            <Field label="Банк">
              <input name="counterpartyBankName" defaultValue={invoice.counterpartyBankName} className="input" />
            </Field>
            <Field label="БИК">
              <input name="counterpartyBankBik" inputMode="numeric" defaultValue={invoice.counterpartyBankBik} className="input" />
            </Field>
            <Field label="Расчётный счёт">
              <input name="counterpartyAccount" inputMode="numeric" defaultValue={invoice.counterpartyAccount} className="input" />
            </Field>
            <Field label="Корр. счёт">
              <input name="counterpartyCorrAccount" inputMode="numeric" defaultValue={invoice.counterpartyCorrAccount} className="input" />
            </Field>
          </Group>

          <Group title="Назначение">
            <div className="md:col-span-2">
              <Field label="Назначение платежа">
                <textarea name="subject" rows={2} defaultValue={invoice.subject} className="input" />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="Комментарий проверки">
                <textarea name="aiDataReviewNote" rows={2} defaultValue={invoice.aiDataReviewNote} className="input" />
                <span className="mt-1 block text-xs text-slate-400">Необязательно. Фиксируется в журнале при сохранении.</span>
              </Field>
            </div>
          </Group>

          {saved.ok ? (
            <div className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
              Данные счёта проверены и сохранены.
            </div>
          ) : saved.error ? (
            <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
              {saved.error}
            </div>
          ) : null}

          <div className="mt-5 flex justify-end">
            <SubmitButton />
          </div>
        </form>
      ) : (
        // Read-only projection for roles that may view but not sign off.
        <div className="mt-5">
          <Group title="Основное">
            <ReadField label="Контрагент" value={invoice.counterpartyName} />
            <ReadField label="ИНН" value={invoice.counterpartyInn} />
            <ReadField label="КПП" value={invoice.counterpartyKpp} />
            <ReadField label="Номер счёта" value={invoice.invoiceNumber} />
            <ReadField label="Дата счёта" value={invoice.invoiceDate} />
            <ReadField label="Срок оплаты" value={invoice.dueDate} />
            <ReadField label="Сумма" value={invoice.amount ? `${invoice.amount} ${invoice.currency}` : ""} />
            <ReadField label="Плательщик" value={invoice.payerName} />
            <ReadField label="Банк" value={invoice.counterpartyBankName} />
            <ReadField label="БИК" value={invoice.counterpartyBankBik} />
            <ReadField label="Расчётный счёт" value={invoice.counterpartyAccount} />
            <ReadField label="Корр. счёт" value={invoice.counterpartyCorrAccount} />
            <div className="md:col-span-2">
              <ReadField label="Назначение платежа" value={invoice.subject} />
            </div>
          </Group>
        </div>
      )}
    </div>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Сохранение..." : "Сохранить данные счёта"}
    </button>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="mt-4 first:mt-0">
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</legend>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
    </fieldset>
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

function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <div className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <span className="block text-sm text-slate-600">{value || "—"}</span>
    </div>
  );
}
