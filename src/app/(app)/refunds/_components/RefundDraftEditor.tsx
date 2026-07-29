"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  changeRefundType, uploadRefundDocument, removeRefundDocument,
  saveRefundRequisites, proceedRefundDraft, cancelRefundDraft,
} from "../refund-document-actions";
import { DocumentLink } from "@/components/mobile/DocumentViewer";
import { StickyActions } from "@/components/mobile/StickyActions";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME: Record<string, true> = { "image/jpeg": true, "image/png": true, "image/webp": true, "application/pdf": true };
const ALLOWED_EXT: Record<string, true> = { jpg: true, jpeg: true, png: true, webp: true, pdf: true };
const E_TYPE = "Формат не поддерживается. Разрешены JPG, PNG, WEBP, PDF.";
const E_SIZE = "Файл слишком большой (максимум 10 МБ).";

type SlotDoc = { id: string; fileName: string; sizeText: string; isImage: boolean; href: string };
type SlotVM = { key: string; label: string; doc: SlotDoc | null };
type Requisites = { bankRecipientName: string; bankName: string; bankBik: string; bankAccount: string; bankCorrAccount: string };

function validateLocal(f: File): string | null {
  const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "";
  if (!(ALLOWED_MIME[f.type] || (!f.type && ALLOWED_EXT[ext]))) return E_TYPE;
  if (f.size === 0) return "Файл пустой.";
  if (f.size > MAX_FILE_BYTES) return E_SIZE;
  return null;
}

function SlotCard({ refundId, slot, busy, setBusy }: { refundId: string; slot: SlotVM; busy: boolean; setBusy: (b: boolean) => void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setError(null);
    const bad = validateLocal(f);
    if (bad) { setError(bad); return; }
    const url = f.type.startsWith("image/") ? URL.createObjectURL(f) : null; // local preview only
    setPreviewUrl(url);
    setUploading(true); setBusy(true);
    try {
      const fd = new FormData();
      fd.set("refundId", refundId);
      fd.set("documentType", slot.key);
      fd.append("file", f);
      const res = await uploadRefundDocument(undefined, fd);
      if (!res.ok) setError(res.error ?? "Не удалось загрузить файл.");
      else router.refresh();
    } catch (err) {
      // A THROWN error here is a transport/body-limit/network failure (not the
      // structured {ok:false} returns above). Surface an actionable message instead
      // of swallowing it silently; log for diagnostics (no file content).
      console.error("refund upload transport error", err);
      const tooLarge = f.size > MAX_FILE_BYTES;
      setError(
        tooLarge
          ? `Файл ${f.name} слишком большой (${(f.size / (1024 * 1024)).toFixed(1)} МБ). Максимум — 10 МБ.`
          : "Не удалось загрузить файл: проблема соединения или размер запроса. Проверьте интернет, формат (JPG, PNG, PDF) и размер (до 10 МБ), затем повторите.",
      );
    }
    finally { setUploading(false); setBusy(false); if (url) { URL.revokeObjectURL(url); } setPreviewUrl(null); }
  }

  async function onRemove() {
    const reason = window.prompt("Причина удаления документа:");
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("refundId", refundId); fd.set("documentId", slot.doc!.id); fd.set("reason", reason.trim());
      const res = await removeRefundDocument(undefined, fd);
      if (!res.ok) setError(res.error ?? "Не удалось удалить."); else router.refresh();
    } finally { setBusy(false); }
  }

  const doc = slot.doc;
  return (
    <div className="flex flex-col rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="text-sm font-medium text-slate-800">{slot.label}</div>
      <div className="mt-0.5 text-[11px] text-slate-400">JPG, PNG, WEBP, PDF · до 10 МБ</div>

      <div className="mt-2 flex-1">
        {uploading ? (
          <div className="flex items-center gap-3">
            {previewUrl ? <img src={previewUrl} alt="" className="h-14 w-14 rounded object-cover ring-1 ring-slate-200" /> : <div className="flex h-14 w-14 items-center justify-center rounded bg-slate-100 text-[11px] text-slate-500">PDF</div>}
            <span className="text-xs text-slate-500">Загрузка…</span>
          </div>
        ) : doc ? (
          <div className="flex items-start gap-3">
            {doc.isImage ? (
              <img src={doc.href} alt="" className="h-14 w-14 shrink-0 rounded object-cover ring-1 ring-slate-200" />
            ) : (
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-rose-50 text-[11px] font-semibold text-rose-600 ring-1 ring-rose-200">PDF</div>
            )}
            <div className="min-w-0">
              <div className="break-anywhere text-sm text-slate-800">{doc.fileName}</div>
              <div className="text-xs text-slate-500">{doc.sizeText}</div>
              {/* Actions ≥44px, spaced so Удалить isn't mis-tapped next to Заменить (spec §13). */}
              <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5">
                <DocumentLink href={doc.href} name={doc.fileName} className="inline-flex min-h-[44px] items-center px-2 text-sm font-medium text-brand-700 hover:underline" />
                <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className="inline-flex min-h-[44px] items-center px-2 text-sm font-medium text-slate-600 hover:text-slate-800 disabled:opacity-60">Заменить</button>
                <button type="button" disabled={busy} onClick={onRemove} className="inline-flex min-h-[44px] items-center px-2 text-sm font-medium text-rose-600 hover:text-rose-700 disabled:opacity-60">Удалить</button>
              </div>
            </div>
          </div>
        ) : (
          <div>
            <div className="mb-2 inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">Не загружен</div>
            <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60">Выбрать файл</button>
          </div>
        )}
      </div>

      {/* mobilefilefield-exempt: bespoke per-slot uploader — a hidden input triggered by
          the slot's own "Выбрать файл" button, with slot-scoped preview/replace and its own
          immediate upload pipeline. The shared MobileFileField (own FileList + button chrome)
          does not fit a hidden, button-driven single-slot control. */}
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={onPick} className="hidden" />
      {error ? <div className="mt-2 break-words text-xs text-rose-600">{error}</div> : null}
    </div>
  );
}

export function RefundDraftEditor({ refundId, returnType, slots, requisites, canProceed }: {
  refundId: string; returnType: string; slots: SlotVM[]; requisites: Requisites; canProceed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reqSaved, setReqSaved] = useState(false);

  async function onChangeType(next: string) {
    if (next === returnType || busy) return;
    const hasDocs = slots.some((s) => s.doc);
    if (hasDocs && !window.confirm("Смена типа удалит несовместимые документы. Продолжить?")) return;
    setBusy(true); setError(null);
    try {
      const fd = new FormData(); fd.set("refundId", refundId); fd.set("returnType", next);
      const res = await changeRefundType(undefined, fd);
      if (!res.ok) setError(res.error ?? "Не удалось сменить тип."); else router.refresh();
    } finally { setBusy(false); }
  }

  async function onSaveDraft(form: HTMLFormElement) {
    setBusy(true); setError(null); setReqSaved(false);
    try {
      const fd = new FormData(form); fd.set("refundId", refundId);
      const res = await saveRefundRequisites(undefined, fd);
      if (!res.ok) setError(res.error ?? "Не удалось сохранить."); else { setReqSaved(true); router.refresh(); }
    } finally { setBusy(false); }
  }

  async function onProceed(form: HTMLFormElement) {
    // Persist current requisites first, then validate the full set server-side.
    setBusy(true); setError(null);
    try {
      const save = new FormData(form); save.set("refundId", refundId);
      const saved = await saveRefundRequisites(undefined, save);
      if (!saved.ok) { setError(saved.error ?? "Проверьте реквизиты."); setBusy(false); return; }
      const fd = new FormData(); fd.set("refundId", refundId);
      const res = await proceedRefundDraft(undefined, fd);
      if (!res.ok) { setError(res.error ?? "Заполните все обязательные поля."); setBusy(false); return; }
      router.push(`/refunds/new/${refundId}/details`);
    } catch { setError("Ошибка."); setBusy(false); }
  }

  async function onCancel() {
    if (!window.confirm("Отменить черновик возврата?")) return;
    setBusy(true);
    try {
      const fd = new FormData(); fd.set("refundId", refundId);
      const res = await cancelRefundDraft(undefined, fd);
      if (res.ok) router.push("/refunds"); else setError(res.error ?? "Не удалось отменить.");
    } finally { setBusy(false); }
  }

  const reqFormRef = useRef<HTMLFormElement>(null);

  return (
    <div className="mx-auto w-full max-w-3xl pb-40 lg:pb-0">
      {/* Type switcher */}
      <fieldset className="mt-4">
        <legend className="mb-2 text-sm font-medium text-slate-700">Тип возврата</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Тип возврата">
          {[{ k: "membership", l: "Абонемент" }, { k: "personal_training", l: "Персональные тренировки" }].map((t) => (
            <button
              key={t.k} type="button" role="radio" aria-checked={returnType === t.k} disabled={busy}
              onClick={() => onChangeType(t.k)}
              className={`rounded-lg border px-4 py-3 text-left text-sm font-medium transition disabled:opacity-60 ${returnType === t.k ? "border-brand-500 bg-brand-50 text-brand-800 ring-1 ring-brand-300" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}
            >
              {t.l}
            </button>
          ))}
        </div>
      </fieldset>

      {/* 2×2 document slots */}
      <div className="mt-6">
        <div className="mb-2 text-sm font-medium text-slate-700">Документы</div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {slots.map((s) => <SlotCard key={s.key} refundId={refundId} slot={s} busy={busy} setBusy={setBusy} />)}
        </div>
      </div>

      {/* Requisites */}
      <form ref={reqFormRef} onSubmit={(e) => { e.preventDefault(); onSaveDraft(e.currentTarget); }} className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 text-sm font-semibold text-slate-700">Реквизиты для возврата</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2"><span className="mb-1 block text-xs font-medium text-slate-600">ФИО получателя</span>
            <input name="bankRecipientName" defaultValue={requisites.bankRecipientName} className="input w-full" /></label>
          <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Банк</span>
            <input name="bankName" defaultValue={requisites.bankName} className="input w-full" /></label>
          <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">БИК</span>
            <input name="bankBik" inputMode="numeric" defaultValue={requisites.bankBik} className="input w-full" placeholder="9 цифр" /></label>
          <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Расчётный счёт</span>
            <input name="bankAccount" inputMode="numeric" defaultValue={requisites.bankAccount} className="input w-full" placeholder="20 цифр" /></label>
          <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Корреспондентский счёт</span>
            <input name="bankCorrAccount" inputMode="numeric" defaultValue={requisites.bankCorrAccount} className="input w-full" placeholder="20 цифр" /></label>
        </div>

        {/* Desktop action row (≥lg). Mobile uses the sticky bar below. */}
        <div className="mt-4 hidden flex-wrap items-center gap-3 lg:flex">
          <button type="submit" disabled={busy} className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60">Сохранить черновик</button>
          <button type="button" disabled={busy} onClick={() => reqFormRef.current && onProceed(reqFormRef.current)} className="inline-flex min-h-[44px] items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">Далее</button>
          <button type="button" disabled={busy} onClick={onCancel} className="inline-flex min-h-[44px] items-center rounded-md border border-rose-300 bg-white px-4 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60">Отменить черновик</button>
          {reqSaved ? <span className="text-xs text-emerald-700" role="status">Сохранено</span> : null}
          {!canProceed ? <span className="text-xs text-slate-400">Для «Далее» нужен полный комплект документов и реквизиты</span> : null}
        </div>
        {error ? <p className="mt-2 text-sm text-rose-600">{error}</p> : null}
      </form>

      {/* Mobile sticky wizard nav (spec §12/§18): primary «Далее» full-width, secondary below,
          keyboard-aware, safe-area. Handlers use the form ref, so this can live outside the form. */}
      <StickyActions>
        {!canProceed ? <p className="mb-1 text-center text-[11px] text-slate-500">Для «Далее» нужен полный комплект документов и реквизиты</p> : null}
        <button type="button" disabled={busy} onClick={() => reqFormRef.current && onProceed(reqFormRef.current)} className="inline-flex min-h-[48px] w-full items-center justify-center rounded-md bg-brand-600 px-4 text-base font-semibold text-white hover:bg-brand-700 disabled:opacity-60">Далее</button>
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={busy} onClick={() => reqFormRef.current && onSaveDraft(reqFormRef.current)} className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 disabled:opacity-60">Сохранить</button>
          <button type="button" disabled={busy} onClick={onCancel} className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-md border border-rose-300 bg-white px-3 text-sm font-medium text-rose-700 disabled:opacity-60">Отменить</button>
        </div>
      </StickyActions>
    </div>
  );
}
