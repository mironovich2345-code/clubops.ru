"use client";

import { useFormState, useFormStatus } from "react-dom";
import { MobileFileField } from "@/components/mobile/MobileFileField";
import type { RefundExtraction } from "@/lib/ai/refund-analyzer";
import type { RefundDocument } from "@/lib/refunds";
import { uploadAndAnalyzeRefund, saveRefund } from "../actions";

type ClubOption = { id: string; name: string; city: string };
type DocType = { key: string; label: string };

type AnalyzeState = {
  ok: boolean;
  error?: string;
  clubId?: string;
  documents?: RefundDocument[];
  extraction?: RefundExtraction;
};
type SaveState = { ok: boolean; error?: string; refundId?: string };

const analyzeInitial: AnalyzeState = { ok: false };
const saveInitial: SaveState = { ok: false };
const CONFIDENCE_LABELS: Record<string, string> = { low: "низкая", medium: "средняя", high: "высокая" };

function Button({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? busy : idle}
    </button>
  );
}

export function RefundUpload({
  clubs,
  docTypes,
  companyName,
}: {
  clubs: ClubOption[];
  docTypes: readonly DocType[];
  companyName: string;
}) {
  const [analyze, analyzeAction] = useFormState(uploadAndAnalyzeRefund, analyzeInitial);
  const [saved, saveAction] = useFormState(saveRefund, saveInitial);

  const extraction = analyze.ok ? analyze.extraction : undefined;
  const documents = analyze.ok ? analyze.documents ?? [] : [];

  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 text-sm font-semibold text-slate-700">
        Добавить возврат (несколько документов — фото, PDF, или вручную)
      </div>

      <form action={analyzeAction} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Компания">
          <input value={companyName} disabled className="input bg-slate-50 text-slate-500" />
        </Field>
        <Field label="Клуб">
          <select name="clubId" required defaultValue={clubs.length === 1 ? clubs[0].id : ""} className="input">
            {clubs.length !== 1 ? <option value="" disabled>Выберите клуб</option> : null}
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.city}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Тип документов">
          <select name="docType" defaultValue="other" className="input">
            {docTypes.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Файлы (JPG, PNG, WEBP, PDF — можно несколько; необязательно)">
          <MobileFileField name="files" maxFiles={5} />
        </Field>
        <div className="md:col-span-2 flex items-center justify-between gap-3">
          {!analyze.ok && analyze.error ? (
            <span className="text-sm text-rose-600">{analyze.error}</span>
          ) : (
            <span />
          )}
          <Button idle="Распознать / заполнить" busy="Обработка..." />
        </div>
      </form>

      {analyze.ok && extraction ? (
        <form action={saveAction} className="mt-6 border-t border-slate-200 pt-5">
          <input type="hidden" name="clubId" value={analyze.clubId} />
          <input type="hidden" name="confidence" value={extraction.confidence} />
          <input type="hidden" name="documentsJson" value={JSON.stringify(documents)} />
          <input type="hidden" name="rawExtractedJson" value={JSON.stringify(extraction)} />

          <div className="mb-3 flex items-center gap-2 text-sm">
            <span className="font-semibold text-slate-700">Проверьте данные возврата</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
              Уверенность: {CONFIDENCE_LABELS[extraction.confidence] ?? extraction.confidence}
            </span>
            {documents.length > 0 ? (
              <span className="text-xs text-slate-500">Документов: {documents.length}</span>
            ) : null}
          </div>

          {extraction.warnings.length > 0 ? (
            <ul className="mb-4 space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
              {extraction.warnings.map((w, i) => (
                <li key={i}>• {w}</li>
              ))}
            </ul>
          ) : null}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Клиент">
              <input name="clientName" defaultValue={extraction.clientName ?? ""} className="input" />
            </Field>
            <Field label="Телефон клиента">
              <input name="clientPhone" defaultValue={extraction.clientPhone ?? ""} className="input" />
            </Field>
            <Field label="Сумма, ₽">
              <input name="amount" inputMode="decimal" defaultValue={extraction.amount ?? ""} className="input" />
            </Field>
            <Field label="Валюта">
              <input name="currency" defaultValue={extraction.currency || "RUB"} className="input" />
            </Field>
            <Field label="Номер договора">
              <input name="contractNumber" defaultValue={extraction.contractNumber ?? ""} className="input" />
            </Field>
            <Field label="Дата возврата">
              <input type="date" name="refundDate" defaultValue={extraction.refundDate ?? ""} className="input" />
            </Field>
            <Field label="Получатель (банк)">
              <input name="bankRecipientName" defaultValue={extraction.bankRecipientName ?? ""} className="input" />
            </Field>
            <Field label="Банк">
              <input name="bankName" defaultValue={extraction.bankName ?? ""} className="input" />
            </Field>
            <Field label="БИК">
              <input name="bankBik" defaultValue={extraction.bankBik ?? ""} className="input" />
            </Field>
            <Field label="Счёт получателя">
              <input name="bankAccount" defaultValue={extraction.bankAccount ?? ""} className="input" />
            </Field>
            <div className="md:col-span-2">
              <Field label="Причина возврата">
                <textarea name="reason" rows={2} defaultValue={extraction.reason ?? ""} className="input" />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="Примечания">
                <textarea name="notes" rows={2} className="input" />
              </Field>
            </div>
          </div>

          {saved.ok ? (
            <div className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
              Возврат сохранён как черновик. Он появился в списке ниже.
            </div>
          ) : saved.error ? (
            <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
              {saved.error}
            </div>
          ) : null}

          <div className="mt-5 flex justify-end">
            <Button idle="Сохранить возврат" busy="Сохранение..." />
          </div>
        </form>
      ) : null}
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
