"use client";

import { useEffect, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { InvoiceExtraction } from "@/lib/ai/invoice-analyzer";
import { UPLOAD_ERROR_MESSAGES, type UploadErrorCode } from "@/lib/upload-errors";
import { uploadAndAnalyzeInvoice, createAndSubmitInvoice } from "../actions";

// Random per-form idempotency key. Regenerated after a successful create so the
// next invoice is not deduped against the previous one. Falls back gracefully
// where crypto.randomUUID is unavailable.
function newSubmissionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `sub-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

type ClubOption = { id: string; name: string; city: string };
type EntityOption = { id: string; name: string; type: string; inn: string | null; kpp: string | null; bankName: string | null; accountNumber: string | null };
type EntitiesByClub = Record<string, EntityOption[]>;

function norm(v: string | null | undefined): string {
  return String(v ?? "").replace(/\s/g, "").toLowerCase();
}

type AnalyzeState = {
  ok: boolean;
  errorCode?: UploadErrorCode;
  clubId?: string;
  storageKey?: string;
  fileName?: string;
  fileMime?: string;
  fileSize?: number;
  extraction?: InvoiceExtraction;
  payerName?: string | null;
  payerCheck?: "match" | "mismatch" | "unknown";
};
type SaveState = { ok: boolean; error?: string; invoiceId?: string };

const CONFIDENCE_LABELS: Record<string, string> = {
  low: "низкая",
  medium: "средняя",
  high: "высокая",
};

const SOURCE_MODE_LABELS: Record<string, string> = {
  image: "Изображение",
  pdf_text: "Текст PDF",
  pdf_rendered_image: "PDF → изображение",
  pdf_vision: "Страницы PDF",
  unavailable: "Не подготовлено",
};

const analyzeInitial: AnalyzeState = { ok: false };
const saveInitial: SaveState = { ok: false };

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

export function InvoiceUpload({
  clubs,
  categories,
  companyName,
  legalEntitiesByClub,
}: {
  clubs: ClubOption[];
  categories: readonly { key: string; label: string }[];
  companyName: string;
  legalEntitiesByClub: EntitiesByClub;
}) {
  const [analyze, analyzeAction] = useFormState(uploadAndAnalyzeInvoice, analyzeInitial);
  const [saved, saveAction] = useFormState(createAndSubmitInvoice, saveInitial);
  // Controlled so the selected club survives the form reset React performs after
  // a form action (otherwise the dropdown would clear on a failed upload).
  const [clubId, setClubId] = useState(clubs.length === 1 ? clubs[0].id : "");
  const [legalEntityId, setLegalEntityId] = useState("");
  // Idempotency key — regenerated after each successful create.
  const [submissionId, setSubmissionId] = useState(newSubmissionId);
  useEffect(() => {
    if (saved.ok) setSubmissionId(newSubmissionId());
  }, [saved]);

  const extraction = analyze.ok ? analyze.extraction : undefined;
  const reviewReady = Boolean(analyze.ok && extraction);
  const entities = legalEntitiesByClub[analyze.clubId ?? ""] ?? [];
  const selectedEntity = entities.find((e) => e.id === legalEntityId);
  // Payer-vs-entity check is a warning only (never blocks save).
  const payerMismatch =
    selectedEntity != null &&
    ((norm(extraction?.payerInn) && selectedEntity.inn && norm(extraction?.payerInn) !== norm(selectedEntity.inn)) ||
      (norm(extraction?.payerName) && norm(extraction?.payerName) !== norm(selectedEntity.name)));

  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 text-sm font-semibold text-slate-700">Загрузка счёта (фото / PDF)</div>

      {/* Step 1: upload + analyze */}
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
          <Field label="Файл (JPG, PNG, WEBP, PDF — до 10 МБ)">
            <input
              type="file"
              name="file"
              required
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
          <Button idle="Загрузить и распознать" busy="Распознавание..." />
        </div>
      </form>

      {/* Step 2: editable review + save */}
      {reviewReady && extraction ? (
        <form action={saveAction} className="mt-6 border-t border-slate-200 pt-5">
          <input type="hidden" name="clubId" value={analyze.clubId} />
          <input type="hidden" name="clientSubmissionId" value={submissionId} />
          <input type="hidden" name="storageKey" value={analyze.storageKey} />
          <input type="hidden" name="fileName" value={analyze.fileName} />
          <input type="hidden" name="fileMime" value={analyze.fileMime} />
          <input type="hidden" name="fileSize" value={analyze.fileSize} />
          <input type="hidden" name="confidence" value={extraction.confidence} />
          <input type="hidden" name="rawExtractedJson" value={JSON.stringify(extraction)} />
          <input type="hidden" name="payerName" value={extraction.payerName ?? ""} />
          <input type="hidden" name="payerInn" value={extraction.payerInn ?? ""} />
          <input type="hidden" name="payerKpp" value={extraction.payerKpp ?? ""} />

          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-slate-700">Проверьте распознанные поля</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                extraction.mode === "ai"
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                  : "bg-slate-100 text-slate-600 ring-slate-200"
              }`}
            >
              {extraction.mode !== "ai"
                ? "Режим ручного заполнения"
                : extraction.provider === "yandex"
                  ? "Документ распознан через Yandex OCR"
                  : "Распознано с помощью ИИ"}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
              Обработка: {SOURCE_MODE_LABELS[extraction.sourceMode] ?? extraction.sourceMode}
            </span>
            {extraction.errorCode ? (
              <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-200">
                Техническая проблема — не низкая уверенность ИИ
              </span>
            ) : extraction.mode === "ai" ? (
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
            ) : null}
          </div>

          {extraction.warnings.length > 0 ? (
            <ul className="mb-4 space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
              {extraction.warnings.map((w, i) => (
                <li key={i}>• {w}</li>
              ))}
            </ul>
          ) : null}

          <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            <div>
              <span className="text-slate-500">Плательщик из счёта: </span>
              <span className="font-medium text-slate-800">
                {extraction.payerName ?? "— не распознан —"}
              </span>
            </div>
            <div className="mt-1">
              <span className="text-slate-500">Проверка плательщика: </span>
              {analyze.payerCheck === "match" ? (
                <span className="font-medium text-emerald-700">
                  Плательщик совпадает с выбранной компанией
                </span>
              ) : analyze.payerCheck === "mismatch" ? (
                <span className="font-medium text-amber-700">
                  Плательщик в счёте не совпадает с выбранной компанией
                </span>
              ) : (
                <span className="text-slate-500">плательщик не распознан</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Контрагент">
              <input name="counterpartyName" defaultValue={extraction.counterpartyName ?? ""} className="input" />
              <span className="mt-1 block text-xs text-slate-400">Поставщик / получатель оплаты</span>
            </Field>
            <Field label="ИНН">
              <input name="counterpartyInn" defaultValue={extraction.counterpartyInn ?? ""} className="input" />
            </Field>
            <Field label="КПП">
              <input name="counterpartyKpp" defaultValue={extraction.counterpartyKpp ?? ""} className="input" />
            </Field>
            <Field label="Банк">
              <input name="counterpartyBankName" defaultValue={extraction.counterpartyBankName ?? ""} className="input" />
            </Field>
            <Field label="БИК">
              <input name="counterpartyBankBik" defaultValue={extraction.counterpartyBankBik ?? ""} className="input" />
            </Field>
            <Field label="Расчётный счёт">
              <input name="counterpartyAccount" defaultValue={extraction.counterpartyAccount ?? ""} className="input" />
            </Field>
            <Field label="Корр. счёт">
              <input name="counterpartyCorrAccount" defaultValue={extraction.counterpartyCorrAccount ?? ""} className="input" />
            </Field>
            <Field label="Статья расходов">
              <select name="expenseCategory" defaultValue={extraction.expenseCategory ?? ""} className="input">
                <option value="">—</option>
                {categories.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Юрлицо">
              <select
                name="legalEntityId"
                value={legalEntityId}
                onChange={(e) => setLegalEntityId(e.target.value)}
                className="input"
              >
                <option value="">— не выбрано —</option>
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.type === "ip" ? "ИП" : "ООО"})
                  </option>
                ))}
              </select>
              {payerMismatch ? (
                <span className="mt-1 block text-xs text-amber-700">
                  Плательщик в счёте не совпадает с выбранным юрлицом
                </span>
              ) : null}
              {selectedEntity ? (
                <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <div className="font-medium text-slate-800">{selectedEntity.name}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                    {selectedEntity.inn ? <span>ИНН {selectedEntity.inn}</span> : null}
                    {selectedEntity.kpp ? <span>КПП {selectedEntity.kpp}</span> : null}
                    {selectedEntity.bankName ? <span>Банк: {selectedEntity.bankName}</span> : null}
                    {selectedEntity.accountNumber ? <span>Р/с {selectedEntity.accountNumber}</span> : null}
                  </div>
                </div>
              ) : null}
            </Field>
            <Field label="Сумма, ₽">
              <input name="amount" inputMode="decimal" defaultValue={extraction.amount ?? ""} className="input" />
            </Field>
            <Field label="Валюта">
              <input name="currency" defaultValue={extraction.currency || "RUB"} className="input" />
            </Field>
            <Field label="Номер счёта">
              <input name="invoiceNumber" defaultValue={extraction.invoiceNumber ?? ""} className="input" />
            </Field>
            <Field label="Дата счёта">
              <input type="date" name="invoiceDate" defaultValue={extraction.invoiceDate ?? ""} className="input" />
            </Field>
            <Field label="Срок оплаты">
              <input type="date" name="dueDate" defaultValue={extraction.dueDate ?? ""} className="input" />
            </Field>
            <div className="md:col-span-2">
              <Field label="Примечания">
                <textarea name="notes" rows={2} className="input" />
              </Field>
            </div>
          </div>

          {saved.ok ? (
            <div className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
              Счёт создан и отправлен региональному директору.
            </div>
          ) : saved.error ? (
            <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
              {saved.error}
            </div>
          ) : null}

          <div className="mt-5 flex flex-col items-end gap-2">
            <Button idle="Создать счёт" busy="Отправка..." />
            <p className="text-xs text-slate-500">После создания счёт будет отправлен региональному директору на проверку.</p>
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
