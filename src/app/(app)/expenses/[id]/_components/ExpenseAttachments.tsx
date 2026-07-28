"use client";

import { useFormState, useFormStatus } from "react-dom";
import { uploadExpenseDocuments, removeExpenseDocument } from "../../document-actions";
import { DocumentLink } from "@/components/mobile/DocumentViewer";

type Attachment = {
  key: string;
  kind: "legacy" | "document";
  id: string | null;
  filename: string;
  typeLabel: string | null;
  sizeText: string | null;
  createdText: string | null;
  previewHref: string;
  downloadHref: string;
  canPreview: boolean;
  canRemove: boolean;
};

type UploadState = { ok: boolean; uploaded?: number; errors?: string[]; error?: string };
type RemoveState = { ok: boolean; error?: string };
const uploadInitial: UploadState = { ok: false };
const removeInitial: RemoveState = { ok: false };

function UploadButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
      {pending ? "Загрузка…" : "Загрузить"}
    </button>
  );
}

function RemoveForm({ expenseId, documentId }: { expenseId: string; documentId: string }) {
  const [state, action] = useFormState(removeExpenseDocument, removeInitial);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        const reason = window.prompt("Причина удаления документа:");
        const input = e.currentTarget.querySelector<HTMLInputElement>('input[name="reason"]');
        if (!reason || !reason.trim()) { e.preventDefault(); return; }
        if (input) input.value = reason.trim();
      }}
      className="inline"
    >
      <input type="hidden" name="expenseId" value={expenseId} />
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="reason" value="" />
      <button type="submit" className="inline-flex min-h-[44px] items-center px-2 text-sm font-medium text-rose-600 hover:text-rose-700">Удалить</button>
      {state.error ? <span className="ml-2 text-xs text-rose-600">{state.error}</span> : null}
    </form>
  );
}

export function ExpenseAttachments({
  expenseId,
  attachments,
  editable,
  maxDocuments,
}: {
  expenseId: string;
  attachments: Attachment[];
  editable: boolean;
  /** When set (simplified v2 = 3), enforces the 1–3 supporting-file rule in the UI. */
  maxDocuments?: number;
}) {
  const [uploadState, uploadAction] = useFormState(uploadExpenseDocuments, uploadInitial);
  // Active ExpenseDocument rows only (legacy single file does not count toward the 3).
  const docCount = attachments.filter((a) => a.kind === "document").length;
  const atMax = maxDocuments !== undefined && docCount >= maxDocuments;

  return (
    <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-1 text-sm font-semibold text-slate-700">Подтверждающие документы</div>
      {maxDocuments !== undefined ? (
        <div className="mb-3 text-xs text-slate-500">Файлы: {docCount} из {maxDocuments}</div>
      ) : null}

      {attachments.length === 0 ? (
        <div className="text-sm text-slate-500">Документы не прикреплены.</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {attachments.map((a) => (
            <li key={a.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-900">{a.filename}</div>
                <div className="text-xs text-slate-500">
                  {[a.typeLabel, a.sizeText, a.createdText, a.kind === "legacy" ? "старый формат" : null].filter(Boolean).join(" · ")}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                {a.canPreview ? (
                  <DocumentLink href={a.previewHref} name={a.filename} />
                ) : (
                  <a href={a.previewHref} target="_blank" rel="noreferrer" className="inline-flex min-h-[44px] items-center px-2 text-sm font-medium text-brand-700 hover:underline">Скачать</a>
                )}
                {a.canPreview ? (
                  <a href={a.downloadHref} className="inline-flex min-h-[44px] items-center px-2 text-sm font-medium text-slate-500 hover:text-slate-700">Скачать</a>
                ) : null}
                {editable && a.canRemove && a.id ? <RemoveForm expenseId={expenseId} documentId={a.id} /> : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editable ? (
        <form action={uploadAction} className="mt-4 flex flex-col gap-2 border-t border-slate-200 pt-4">
          <input type="hidden" name="expenseId" value={expenseId} />
          {maxDocuments !== undefined ? (
            <p className="text-xs text-slate-500">Прикрепите от 1 до 3 файлов: чек, подтверждение перевода, фото или PDF.</p>
          ) : null}
          {atMax ? (
            <p className="text-xs text-amber-700">Можно прикрепить не более 3 файлов.</p>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">Тип документа</span>
                <select name="documentType" defaultValue="receipt" className="input">
                  <option value="receipt">Чек</option>
                  <option value="payment_confirmation">Подтверждение оплаты</option>
                  <option value="other">Другое</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">Чек/документы (JPEG, PNG, WEBP, PDF; можно несколько)</span>
                <input type="file" name="documents" multiple accept="image/jpeg,image/png,image/webp,application/pdf" className="block w-full text-sm" />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <UploadButton />
                {uploadState.uploaded ? <span className="text-xs text-emerald-700">Загружено: {uploadState.uploaded}</span> : null}
                {uploadState.error ? <span className="text-xs text-rose-600">{uploadState.error}</span> : null}
              </div>
            </>
          )}
          {uploadState.errors?.length ? (
            <ul className="text-xs text-rose-600">
              {uploadState.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
