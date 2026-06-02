"use client";

import { useFormState, useFormStatus } from "react-dom";
import { formatKopeks } from "@/lib/money";
import type { ImportPreview } from "@/lib/import";
import {
  previewImport,
  runImport,
  type PreviewState,
  type ImportResultState,
} from "../actions";

type ClubOption = { id: string; name: string; city: string };

const previewInitial: PreviewState = { ok: false };
const importInitial: ImportResultState = { ok: false };

function PreviewButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Чтение файла..." : "Загрузить файл"}
    </button>
  );
}

function ImportButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Импорт..." : "Импортировать"}
    </button>
  );
}

export function ImportForm({ clubs }: { clubs: ClubOption[] }) {
  const [previewState, previewAction] = useFormState(previewImport, previewInitial);
  const [importState, importAction] = useFormState(runImport, importInitial);

  const preview = previewState.preview;
  const hasRows = preview ? preview.candidates.length > 0 : false;

  return (
    <div className="space-y-6">
      <form
        action={previewAction}
        className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Клуб</span>
            <select
              name="clubId"
              required
              defaultValue=""
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="" disabled>
                Выберите клуб
              </option>
              {clubs.map((club) => (
                <option key={club.id} value={club.id}>
                  {club.name} — {club.city}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Файл (.xlsx / .csv)</span>
            <input
              type="file"
              name="file"
              required
              accept=".xlsx,.csv"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1 file:text-sm file:text-slate-700"
            />
          </label>
        </div>

        {!previewState.ok && previewState.error ? (
          <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
            {previewState.error}
          </div>
        ) : null}

        <div className="mt-5 flex justify-end">
          <PreviewButton />
        </div>
      </form>

      {previewState.ok && preview ? (
        <PreviewBlock
          preview={preview}
          clubId={previewState.clubId ?? ""}
          importAction={importAction}
          importState={importState}
          hasRows={hasRows}
        />
      ) : null}
    </div>
  );
}

function PreviewBlock({
  preview,
  clubId,
  importAction,
  importState,
  hasRows,
}: {
  preview: ImportPreview;
  clubId: string;
  importAction: (formData: FormData) => void;
  importState: ImportResultState;
  hasRows: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 text-sm font-semibold text-slate-700">Предпросмотр</div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Продажи, строк" value={String(preview.salesCount)} />
        <Stat label="Расходы, строк" value={String(preview.expensesCount)} />
        <Stat label="Сумма продаж" value={formatKopeks(preview.salesTotalKopeks)} />
        <Stat label="Сумма расходов" value={formatKopeks(preview.expensesTotalKopeks)} />
      </div>

      {preview.warnings.length > 0 ? (
        <ul className="mt-4 space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
          {preview.warnings.map((w, i) => (
            <li key={i}>• {w}</li>
          ))}
        </ul>
      ) : null}

      {importState.ok ? (
        <div className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
          Импортировано: продажи — {importState.importedSales}, расходы —{" "}
          {importState.importedExpenses}. Пропущено (дубликаты/ошибки):{" "}
          {importState.skipped}. Данные уже видны на страницах «Продажи» и «Расходы».
        </div>
      ) : importState.error ? (
        <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
          {importState.error}
        </div>
      ) : null}

      {hasRows && !importState.ok ? (
        <form action={importAction} className="mt-5 flex justify-end">
          <input type="hidden" name="clubId" value={clubId} />
          <input type="hidden" name="candidates" value={JSON.stringify(preview.candidates)} />
          <ImportButton />
        </form>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-900">{value}</div>
    </div>
  );
}
