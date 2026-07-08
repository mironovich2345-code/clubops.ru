"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createSimplifiedExpenseDraft } from "../simplified-actions";
import { uploadExpenseDocuments } from "../document-actions";

type Category = { key: string; name: string };
type Employee = { id: string; name: string };

// Client-side convenience mirror of the server rules (server stays authoritative).
const MAX_FILES = 3;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB / file
const ALLOWED_EXT: Record<string, true> = { jpg: true, jpeg: true, png: true, webp: true, pdf: true };
const ALLOWED_MIME: Record<string, true> = {
  "image/jpeg": true, "image/png": true, "image/webp": true, "application/pdf": true,
};
const E_TYPE = "Формат не поддерживается. Разрешены JPG, PNG, WEBP, PDF.";
const E_SIZE = "Файл слишком большой (максимум 10 МБ).";
const E_DUP = "Файл уже добавлен.";
const E_MAX = "Можно прикрепить не более 3 файлов.";

type Picked = { key: string; file: File; uploaded: boolean; error?: string };

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function validateFile(f: File): string | null {
  const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "";
  const typeOk = ALLOWED_MIME[f.type] || (!f.type && ALLOWED_EXT[ext]);
  if (!typeOk) return E_TYPE;
  if (f.size === 0) return "Файл пустой.";
  if (f.size > MAX_FILE_BYTES) return E_SIZE;
  return null;
}

export function SimpleExpenseForm({
  categories, employees, defaultPaidById,
}: {
  categories: Category[];
  employees: Employee[];
  defaultPaidById: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A draft is created at most once; a repeated click reuses this id (no dupes).
  const draftIdRef = useRef<string | null>(null);

  const [category, setCategory] = useState("");
  const [files, setFiles] = useState<Picked[]>([]);
  const [rejections, setRejections] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seq, setSeq] = useState(0); // stable keys without Date.now()/random

  if (categories.length === 0) {
    return <div className="rounded-md bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">Нет активных статей расходов. Обратитесь к главному бухгалтеру.</div>;
  }

  const atMax = files.length >= MAX_FILES;

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-selecting the same file after removal
    if (picked.length === 0) return;
    const rej: string[] = [];
    let n = seq;
    setFiles((prev) => {
      const next = [...prev];
      for (const f of picked) {
        if (next.length >= MAX_FILES) { rej.push(E_MAX); continue; }
        if (next.some((x) => x.file.name === f.name && x.file.size === f.size)) { rej.push(`${f.name}: ${E_DUP}`); continue; }
        const bad = validateFile(f);
        if (bad) { rej.push(`${f.name}: ${bad}`); continue; }
        next.push({ key: `f${n++}`, file: f, uploaded: false });
      }
      return next;
    });
    setSeq(n);
    setRejections(rej);
  }

  function removeFile(key: string) {
    setFiles((prev) => prev.filter((f) => f.key !== key));
    setRejections([]);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return; // guard against double-click / repeated submit
    setError(null);
    setRejections([]);
    if (files.length < 1) { setError("Прикрепите хотя бы один документ."); return; }
    if (files.some((f) => f.error)) { setError("Уберите некорректные файлы перед созданием."); return; }

    setBusy(true);
    try {
      // 1. Create the draft once; reuse on retry so clicks never duplicate it.
      let id = draftIdRef.current;
      if (!id) {
        const fd = new FormData(formRef.current!);
        const res = await createSimplifiedExpenseDraft(undefined, fd);
        if (!res.ok || !res.expenseId) { setError(res.error ?? "Не удалось создать расход."); setBusy(false); return; }
        id = res.expenseId;
        draftIdRef.current = id;
      }

      // 2. Upload each not-yet-uploaded file; keep successes on partial failure.
      let anyFailed = false;
      const updated = [...files];
      for (let i = 0; i < updated.length; i++) {
        if (updated[i].uploaded) continue;
        const ufd = new FormData();
        ufd.set("expenseId", id);
        ufd.set("documentType", "receipt");
        ufd.append("documents", updated[i].file);
        const ur = await uploadExpenseDocuments(undefined, ufd);
        if (ur.ok && ur.uploaded) {
          updated[i] = { ...updated[i], uploaded: true, error: undefined };
        } else {
          anyFailed = true;
          updated[i] = { ...updated[i], error: ur.error ?? "Не удалось загрузить файл." };
        }
      }
      setFiles(updated);

      if (anyFailed) {
        setError("Черновик сохранён, но не все файлы загрузились. Исправьте отмеченные файлы и повторите.");
        setBusy(false);
        return;
      }

      // 3. Everything uploaded → open the draft.
      router.push(`/expenses/${id}`);
    } catch {
      setError("Произошла ошибка. Черновик сохранён — повторите загрузку.");
      setBusy(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} noValidate={false} className="mx-auto flex w-full max-w-md flex-col gap-4">
      {/* Category name carried so the title is built from the human label. */}
      <input type="hidden" name="categoryName" value={categories.find((c) => c.key === category)?.name ?? ""} />

      {/* 1. Статья расходов */}
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Статья расходов</span>
        <select name="category" required value={category} onChange={(e) => setCategory(e.target.value)} className="input w-full">
          <option value="" disabled>Выберите статью</option>
          {categories.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
        </select>
      </label>

      {/* 2. Сумма */}
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Сумма, ₽</span>
        <input name="amount" required inputMode="decimal" placeholder="0,00" className="input w-full" />
      </label>

      {/* 3. Дата */}
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Дата</span>
        <input type="date" name="expenseDate" required defaultValue={todayISO()} max={todayISO()} className="input w-full" />
      </label>

      {/* 4. Комментарий */}
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Комментарий</span>
        <textarea name="comment" required rows={2} maxLength={2000} className="input w-full" />
      </label>

      {/* 5. Список покупок/оплат */}
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Список покупок/оплат</span>
        <textarea name="shoppingList" required rows={3} maxLength={5000} className="input w-full" placeholder="Например: бумага, мыло, пакеты" />
      </label>

      {/* 6. Кто оплатил */}
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Кто оплатил</span>
        <select name="paidByUserId" required defaultValue={defaultPaidById} className="input w-full">
          <option value="" disabled>Выберите сотрудника</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </label>

      {/* 7. Подтверждающие документы */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div className="text-sm font-medium text-slate-700">Подтверждающие документы</div>
        <p className="mt-1 text-xs text-slate-500">Прикрепите от 1 до 3 файлов: чек, подтверждение перевода, фото или PDF.</p>

        {files.length > 0 ? (
          <ul className="mt-3 divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
            {files.map((f) => (
              <li key={f.key} className="flex items-start justify-between gap-3 p-2">
                <div className="min-w-0">
                  <div className="break-all text-sm text-slate-800">{f.file.name}</div>
                  <div className="text-xs text-slate-500">
                    {formatSize(f.file.size)}
                    {f.uploaded ? <span className="ml-2 text-emerald-600">загружено</span> : null}
                  </div>
                  {f.error ? <div className="mt-0.5 break-words text-xs text-rose-600">{f.error}</div> : null}
                </div>
                {!f.uploaded ? (
                  <button type="button" onClick={() => removeFile(f.key)} disabled={busy} className="shrink-0 text-xs font-medium text-rose-600 hover:text-rose-700 disabled:opacity-60">
                    Удалить
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-2 text-xs text-slate-500">Файлы: {files.length} из {MAX_FILES}</div>

        {atMax ? (
          <p className="mt-2 text-xs text-amber-700">Можно прикрепить не более 3 файлов.</p>
        ) : (
          <label className="mt-2 block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Добавить файл (JPG, PNG, WEBP, PDF)</span>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={onPick}
              disabled={busy || atMax}
              className="block w-full text-sm"
            />
          </label>
        )}

        {rejections.length > 0 ? (
          <ul className="mt-2 space-y-0.5 text-xs text-rose-600">
            {rejections.map((r, i) => <li key={i} className="break-words">{r}</li>)}
          </ul>
        ) : null}
      </div>

      {/* 8. Основная кнопка */}
      <button type="submit" disabled={busy} className="w-full rounded-md bg-brand-600 px-4 py-3 text-base font-medium text-white hover:bg-brand-700 disabled:opacity-60">
        {busy ? "Создание…" : "Создать расход"}
      </button>
      {error ? <p className="text-sm text-rose-600">{error}</p> : null}
    </form>
  );
}
