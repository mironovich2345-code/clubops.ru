"use client";

import { useEffect, useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { MobileFileField } from "@/components/mobile/MobileFileField";
import { UPLOAD_ERROR_MESSAGES, type UploadErrorCode } from "@/lib/upload-errors";
import { uploadAndAnalyzePayroll, savePayrollStatement } from "../payroll-actions";

type ClubOption = { id: string; name: string; city: string };
type Confidence = "low" | "medium" | "high";
type RowView = {
  employeeName: string | null;
  role: string | null;
  amount: number | null;
  isSigned: boolean;
  signatureConfidence: Confidence;
};
type EditableRow = {
  employeeName: string;
  role: string;
  amount: string;
  isSigned: boolean;
  signatureConfidence: Confidence;
};

type AnalyzeState = {
  ok: boolean;
  errorCode?: UploadErrorCode;
  clubId?: string;
  storageKey?: string;
  fileName?: string;
  fileMime?: string;
  fileSize?: number;
  period?: string | null;
  rows?: RowView[];
  blocked?: boolean;
  mode?: "ai" | "mock";
  warnings?: string[];
};
type SaveState = {
  ok: boolean;
  error?: string;
  message?: string;
  totalSignedKopeks?: number;
  newSignedKopeks?: number;
  skippedRows?: number;
  expenseCreated?: boolean;
};

const analyzeInitial: AnalyzeState = { ok: false };
const saveInitial: SaveState = { ok: false };

function toEditable(rows: RowView[]): EditableRow[] {
  return rows.map((r) => ({
    employeeName: r.employeeName ?? "",
    role: r.role ?? "",
    amount: r.amount != null ? String(r.amount) : "",
    isSigned: r.isSigned,
    signatureConfidence: r.signatureConfidence,
  }));
}

function fmtRub(kopeks: number): string {
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(kopeks / 100);
}

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

export function PayrollUpload({ clubs, companyName }: { clubs: ClubOption[]; companyName: string }) {
  const [analyze, analyzeAction] = useFormState(uploadAndAnalyzePayroll, analyzeInitial);
  const [saved, saveAction] = useFormState(savePayrollStatement, saveInitial);
  const [clubId, setClubId] = useState(clubs.length === 1 ? clubs[0].id : "");
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [period, setPeriod] = useState("");

  // Seed the editable table from the latest analysis result.
  useEffect(() => {
    if (analyze.ok) {
      setRows(toEditable(analyze.rows ?? []));
      setPeriod(analyze.period ?? "");
    }
  }, [analyze]);

  const signedTotalKopeks = useMemo(
    () =>
      rows.reduce((sum, r) => {
        if (!r.isSigned) return sum;
        const n = Number(r.amount.replace(",", "."));
        return Number.isFinite(n) && n > 0 ? sum + Math.round(n * 100) : sum;
      }, 0),
    [rows],
  );

  const rowsJson = useMemo(
    () =>
      JSON.stringify(
        rows.map((r) => ({
          employeeName: r.employeeName.trim() || null,
          role: r.role.trim() || null,
          amount: Number(r.amount.replace(",", ".")) || 0,
          isSigned: r.isSigned,
          signatureConfidence: r.signatureConfidence,
        })),
      ),
    [rows],
  );

  function updateRow(i: number, patch: Partial<EditableRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { employeeName: "", role: "", amount: "", isSigned: false, signatureConfidence: "low" }]);
  }
  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  const analyzed = analyze.ok;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 text-sm font-semibold text-slate-700">
        Зарплатная ведомость (учитываются только подписанные строки)
      </div>

      {/* Step 1: choose club + optional file -> analyze (or start manual) */}
      <form action={analyzeAction} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Компания">
          <input value={companyName} disabled className="input bg-slate-50 text-slate-500" />
        </Field>
        <Field label="Клуб">
          <select name="clubId" required value={clubId} onChange={(e) => setClubId(e.target.value)} className="input">
            <option value="" disabled>Выберите клуб</option>
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.city}
              </option>
            ))}
          </select>
        </Field>
        <div className="md:col-span-2">
          <Field label="Файл ведомости (JPG, PNG, WEBP, PDF — до 10 МБ; можно без файла и заполнить вручную)">
            <MobileFileField name="file" maxFiles={1} />
          </Field>
        </div>
        <div className="md:col-span-2 flex items-center justify-between gap-3">
          {!analyze.ok && analyze.errorCode ? (
            <span className="text-sm text-rose-600">{UPLOAD_ERROR_MESSAGES[analyze.errorCode]}</span>
          ) : (
            <span />
          )}
          <Button idle="Распознать / заполнить вручную" busy="Обработка..." />
        </div>
      </form>

      {analyzed ? (
        <div className="mt-6 border-t border-slate-200 pt-5">
          {analyze.blocked ? (
            <div className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
              {(analyze.warnings ?? []).join(" ") || "ИИ для ведомостей отключён — заполните строки вручную."}
            </div>
          ) : (analyze.warnings ?? []).length > 0 ? (
            <ul className="mb-4 space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
              {(analyze.warnings ?? []).map((w, i) => (
                <li key={i}>• {w}</li>
              ))}
            </ul>
          ) : null}

          <div className="mb-3 flex flex-wrap items-end gap-3">
            <Field label="Период (необязательно)">
              <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="например, июнь 2026" className="input" />
            </Field>
          </div>

          <div className="overflow-x-auto rounded-md border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <Th>Сотрудник</Th>
                  <Th>Роль</Th>
                  <Th className="text-right">Сумма, ₽</Th>
                  <Th className="text-center">Подпись</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                      Строк нет. Добавьте строки вручную.
                    </td>
                  </tr>
                ) : (
                  rows.map((r, i) => (
                    <tr key={i} className={r.isSigned ? "" : "bg-slate-50/50"}>
                      <td className="px-3 py-2">
                        <input
                          value={r.employeeName}
                          onChange={(e) => updateRow(i, { employeeName: e.target.value })}
                          className="input"
                          placeholder="ФИО"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={r.role}
                          onChange={(e) => updateRow(i, { role: e.target.value })}
                          className="input"
                          placeholder="должность"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={r.amount}
                          inputMode="decimal"
                          onChange={(e) => updateRow(i, { amount: e.target.value })}
                          className="input text-right"
                          placeholder="0"
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <label className="inline-flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={r.isSigned}
                            onChange={(e) => updateRow(i, { isSigned: e.target.checked })}
                          />
                          {r.isSigned && r.signatureConfidence === "low" ? (
                            <span className="text-xs text-amber-600">не уверенно</span>
                          ) : null}
                        </label>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => removeRow(i)}
                          className="text-xs text-slate-400 hover:text-rose-600"
                        >
                          удалить
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={addRow}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              + Добавить строку
            </button>
            <div className="text-sm text-slate-700">
              Сумма подписанных строк:{" "}
              <span className="font-semibold text-slate-900">{fmtRub(signedTotalKopeks)}</span>
            </div>
          </div>

          {/* Step 2: save (server dedups and computes the new amount to count) */}
          <form action={saveAction} className="mt-5">
            <input type="hidden" name="clubId" value={analyze.clubId ?? clubId} />
            <input type="hidden" name="period" value={period} />
            <input type="hidden" name="rowsJson" value={rowsJson} />
            <input type="hidden" name="storageKey" value={analyze.storageKey ?? ""} />
            <input type="hidden" name="fileName" value={analyze.fileName ?? ""} />
            <input type="hidden" name="fileMime" value={analyze.fileMime ?? ""} />
            <input type="hidden" name="fileSize" value={analyze.fileSize ?? ""} />
            <input type="hidden" name="rawJson" value="" />

            {saved.ok ? (
              <div className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
                {saved.message
                  ? saved.message
                  : `Учтена новая сумма ${fmtRub(saved.newSignedKopeks ?? 0)} (подписано всего ${fmtRub(saved.totalSignedKopeks ?? 0)}` +
                    `${saved.skippedRows ? `, пропущено уже учтённых строк: ${saved.skippedRows}` : ""}). Расход по статье «Зарплата» создан.`}
              </div>
            ) : saved.error ? (
              <div className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
                {saved.error}
              </div>
            ) : null}

            <div className="flex justify-end">
              <Button idle="Сохранить ведомость" busy="Сохранение..." />
            </div>
          </form>
        </div>
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

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className ?? ""}`}>
      {children}
    </th>
  );
}
