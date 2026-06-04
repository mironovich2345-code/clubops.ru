"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { ExpenseExtraction } from "@/lib/ai/expense-analyzer";
import { UPLOAD_ERROR_MESSAGES, type UploadErrorCode } from "@/lib/upload-errors";
import { uploadAndAnalyzeExpense, saveExpense } from "../actions";
import { PayrollUpload } from "./PayrollUpload";

type ClubOption = { id: string; name: string; city: string };
type CategoryOption = { key: string; label: string };

type AnalyzeState = {
  ok: boolean;
  errorCode?: UploadErrorCode;
  clubId?: string;
  storageKey?: string;
  fileName?: string;
  fileMime?: string;
  fileSize?: number;
  extraction?: ExpenseExtraction;
};
type SaveState = { ok: boolean; error?: string; expenseId?: string };

const analyzeInitial: AnalyzeState = { ok: false };
const saveInitial: SaveState = { ok: false };

const CONFIDENCE_LABELS: Record<string, string> = { low: "низкая", medium: "средняя", high: "высокая" };
const TYPE_OPTIONS = [
  { value: "receipt", label: "Чек" },
  { value: "transfer", label: "Перевод" },
  { value: "manual", label: "Вручную" },
];

// Top-level document kind selector.
type DocKind = "receipt" | "transfer" | "payroll_statement" | "manual";
const DOC_KINDS: { value: DocKind; label: string }[] = [
  { value: "receipt", label: "Чек" },
  { value: "transfer", label: "Перевод" },
  { value: "payroll_statement", label: "Зарплатная ведомость" },
  { value: "manual", label: "Вручную" },
];

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

export function ExpenseUpload({
  clubs,
  categories,
  companyName,
}: {
  clubs: ClubOption[];
  categories: readonly CategoryOption[];
  companyName: string;
}) {
  const [docKind, setDocKind] = useState<DocKind>("receipt");

  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4">
        <div className="mb-2 text-sm font-semibold text-slate-700">Тип документа</div>
        <div className="flex flex-wrap gap-2">
          {DOC_KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              onClick={() => setDocKind(k.value)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
                docKind === k.value
                  ? "border-brand-300 bg-brand-600 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      {docKind === "payroll_statement" ? (
        <PayrollUpload clubs={clubs} companyName={companyName} />
      ) : (
        <DocumentExpenseForm
          clubs={clubs}
          categories={categories}
          companyName={companyName}
          docKind={docKind}
        />
      )}
    </div>
  );
}

function DocumentExpenseForm({
  clubs,
  categories,
  companyName,
  docKind,
}: {
  clubs: ClubOption[];
  categories: readonly CategoryOption[];
  companyName: string;
  docKind: DocKind;
}) {
  const [analyze, analyzeAction] = useFormState(uploadAndAnalyzeExpense, analyzeInitial);
  const [saved, saveAction] = useFormState(saveExpense, saveInitial);
  // Controlled so the selected club survives the form reset after a form action.
  const [clubId, setClubId] = useState(clubs.length === 1 ? clubs[0].id : "");

  const extraction = analyze.ok ? analyze.extraction : undefined;
  // Default the review "Тип" to the AI result, falling back to the chosen kind.
  const typeDefault =
    extraction && extraction.type !== "manual" ? extraction.type : docKind === "payroll_statement" ? "manual" : docKind;

  return (
    <div>
      <form action={analyzeAction} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Компания">
          <input value={companyName} disabled className="input bg-slate-50 text-slate-500" />
        </Field>
        <Field label="Клуб">
          <select
            name="clubId"
            required
            value={clubId}
            onChange={(e) => setClubId(e.target.value)}
            className="input"
          >
            <option value="" disabled>Выберите клуб</option>
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.city}
              </option>
            ))}
          </select>
        </Field>
        <div className="md:col-span-2">
          <Field label="Файл (JPG, PNG, WEBP, PDF — до 10 МБ; необязательно для ручного ввода)">
            <input
              type="file"
              name="file"
              accept=".jpg,.jpeg,.png,.webp,.pdf"
              className="input file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1 file:text-sm file:text-slate-700"
            />
          </Field>
        </div>
        <div className="md:col-span-2 flex items-center justify-between gap-3">
          {!analyze.ok && analyze.errorCode ? (
            <span className="text-sm text-rose-600">{UPLOAD_ERROR_MESSAGES[analyze.errorCode]}</span>
          ) : (
            <span />
          )}
          <Button idle="Распознать / заполнить" busy="Обработка..." />
        </div>
      </form>

      {analyze.ok && extraction ? (
        <form action={saveAction} className="mt-6 border-t border-slate-200 pt-5">
          <input type="hidden" name="clubId" value={analyze.clubId} />
          <input type="hidden" name="storageKey" value={analyze.storageKey ?? ""} />
          <input type="hidden" name="fileName" value={analyze.fileName ?? ""} />
          <input type="hidden" name="fileMime" value={analyze.fileMime ?? ""} />
          <input type="hidden" name="fileSize" value={analyze.fileSize ?? ""} />
          <input type="hidden" name="confidence" value={extraction.confidence} />
          <input type="hidden" name="rawExtractedJson" value={JSON.stringify(extraction)} />

          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-slate-700">Проверьте поля расхода</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                extraction.mode === "ai"
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                  : "bg-slate-100 text-slate-600 ring-slate-200"
              }`}
            >
              {extraction.mode === "ai" ? "Распознано с помощью ИИ" : "Режим ручного заполнения"}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                extraction.confidence === "high"
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                  : extraction.confidence === "medium"
                    ? "bg-amber-50 text-amber-800 ring-amber-200"
                    : "bg-slate-100 text-slate-600 ring-slate-200"
              }`}
            >
              Уверенность: {CONFIDENCE_LABELS[extraction.confidence] ?? extraction.confidence}
            </span>
          </div>

          {extraction.warnings.length > 0 ? (
            <ul className="mb-4 space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
              {extraction.warnings.map((w, i) => (
                <li key={i}>• {w}</li>
              ))}
            </ul>
          ) : null}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Тип">
              <select name="type" defaultValue={typeDefault} className="input">
                {TYPE_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Статья расхода">
              <select name="category" defaultValue={extraction.expenseCategory ?? ""} className="input">
                <option value="" disabled>
                  Выберите статью
                </option>
                {categories.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Магазин">
              <input name="vendorName" defaultValue={extraction.vendorName ?? ""} className="input" />
            </Field>
            <Field label="Получатель перевода">
              <input name="recipientName" defaultValue={extraction.recipientName ?? ""} className="input" />
            </Field>
            <div className="md:col-span-2">
              <Field label="Комментарий перевода">
                <input
                  name="transferComment"
                  defaultValue={extraction.transferComment ?? ""}
                  placeholder="назначение платежа"
                  className="input"
                />
              </Field>
            </div>
            <Field label="Сумма, ₽">
              <input name="amount" inputMode="decimal" defaultValue={extraction.amount ?? ""} className="input" />
            </Field>
            <Field label="Валюта">
              <input name="currency" defaultValue={extraction.currency || "RUB"} className="input" />
            </Field>
            <Field label="Дата покупки">
              <input type="date" name="purchaseDate" defaultValue={extraction.purchaseDate ?? ""} className="input" />
            </Field>
            <Field label="Адрес">
              <input name="address" defaultValue={extraction.address ?? ""} className="input" />
            </Field>
            <div className="md:col-span-2">
              <Field label="Список покупок (по строке на позицию)">
                <textarea name="items" rows={3} defaultValue={extraction.items.join("\n")} className="input" />
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
              Расход сохранён. Он появился в списке ниже.
            </div>
          ) : saved.error ? (
            <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
              {saved.error}
            </div>
          ) : null}

          <div className="mt-5 flex justify-end">
            <Button idle="Сохранить расход" busy="Сохранение..." />
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
