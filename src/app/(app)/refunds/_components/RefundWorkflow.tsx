"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { submitRefundToRegional, approveRefundByRegional, returnRefundForCorrection } from "../refund-document-actions";

/**
 * Manager: the FINAL wizard action — one click creates the refund (finalises the draft) and
 * sends it to the regional director. No separate "Отправить" step, no confirm modal. On
 * return-for-correction the same control resubmits (`resubmit`). Disabled with a hint if the
 * refund is not yet complete; readiness is re-checked on the server.
 */
export function SubmitToRegional({ refundId, ready, readyError, resubmit = false }: { refundId: string; ready: boolean; readyError: string | null; resubmit?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit() {
    if (busy) return; // guard double-click; server compare-and-set makes it idempotent
    setBusy(true); setError(null);
    try {
      const fd = new FormData(); fd.set("refundId", refundId);
      const res = await submitRefundToRegional(undefined, fd);
      if (!res.ok) { setError(res.error ?? "Не удалось создать возврат."); setBusy(false); return; }
      router.push(`/refunds/${refundId}?submitted=1`);
    } catch { setError("Ошибка."); setBusy(false); }
  }

  return (
    <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-sm font-semibold text-slate-700">{resubmit ? "Повторная отправка" : "Создание возврата"}</div>
      {!ready ? <p className="mt-1 text-xs text-amber-700">{readyError ?? "Заполните возврат полностью, затем создайте — он уйдёт региональному директору."}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy || !ready} onClick={onSubmit} className="min-h-[44px] rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {busy ? "Создание…" : resubmit ? "Исправить и отправить повторно" : "Создать возврат"}
        </button>
        {error ? <span className="text-sm text-rose-600">{error}</span> : null}
      </div>
      {ready && !resubmit ? <p className="mt-2 text-xs text-slate-500">После создания возврат будет отправлен региональному директору на проверку.</p> : null}
    </div>
  );
}

/** Regional director: approve → accounting, or return for correction (comment required). */
export function RegionalReview({ refundId }: { refundId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReturn, setShowReturn] = useState(false);
  const [comment, setComment] = useState("");

  async function approve() {
    if (busy) return;
    if (!window.confirm("Согласовать возврат и передать в бухгалтерию?")) return;
    setBusy(true); setError(null);
    try {
      const fd = new FormData(); fd.set("refundId", refundId);
      const res = await approveRefundByRegional(undefined, fd);
      if (!res.ok) { setError(res.error ?? "Ошибка."); setBusy(false); return; }
      router.refresh();
    } catch { setError("Ошибка."); setBusy(false); }
  }
  async function returnForCorrection() {
    if (busy) return;
    if (comment.trim().length < 5) { setError("Комментарий об исправлении обязателен (не менее 5 символов)."); return; }
    setBusy(true); setError(null);
    try {
      const fd = new FormData(); fd.set("refundId", refundId); fd.set("comment", comment.trim());
      const res = await returnRefundForCorrection(undefined, fd);
      if (!res.ok) { setError(res.error ?? "Ошибка."); setBusy(false); return; }
      router.refresh();
    } catch { setError("Ошибка."); setBusy(false); }
  }

  return (
    <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-sm font-semibold text-slate-700">Решение регионального директора</div>
      {!showReturn ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" disabled={busy} onClick={approve} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60">Согласовать</button>
          <button type="button" disabled={busy} onClick={() => setShowReturn(true)} className="rounded-md border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-60">Вернуть на исправление</button>
        </div>
      ) : (
        <div className="mt-3">
          <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Комментарий (что исправить)</span>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={2000} className="input w-full" placeholder="Опишите, что нужно исправить" /></label>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button type="button" disabled={busy} onClick={returnForCorrection} className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60">Отправить на исправление</button>
            <button type="button" disabled={busy} onClick={() => { setShowReturn(false); setError(null); }} className="text-sm text-slate-500 hover:text-slate-700">Отмена</button>
          </div>
        </div>
      )}
      {error ? <p className="mt-2 text-sm text-rose-600">{error}</p> : null}
    </div>
  );
}
