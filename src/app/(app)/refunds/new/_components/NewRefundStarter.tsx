"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createRefundDraft } from "../../refund-document-actions";

type Club = { id: string; name: string };

export function NewRefundStarter({ clubs, defaultClubId }: { clubs: Club[]; defaultClubId: string }) {
  const router = useRouter();
  const [clubId, setClubId] = useState(defaultClubId);
  const [returnType, setReturnType] = useState<string>("membership");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCreate() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.set("clubId", clubId);
      fd.set("returnType", returnType);
      const res = await createRefundDraft(undefined, fd);
      if (res.ok && res.refundId) router.push(`/refunds/new/${res.refundId}`);
      else { setError(res.error ?? "Не удалось создать черновик."); setBusy(false); }
    } catch { setError("Ошибка."); setBusy(false); }
  }

  return (
    <div className="mx-auto mt-4 w-full max-w-lg rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      {clubs.length > 1 ? (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Клуб</span>
          <select value={clubId} onChange={(e) => setClubId(e.target.value)} className="input w-full">
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      ) : (
        <div className="text-sm text-slate-600">Клуб: <span className="font-medium text-slate-800">{clubs[0]?.name ?? "—"}</span></div>
      )}

      <fieldset className="mt-4">
        <legend className="mb-2 text-sm font-medium text-slate-700">Тип возврата</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Тип возврата">
          {[{ k: "membership", l: "Абонемент" }, { k: "personal_training", l: "Персональные тренировки" }].map((t) => (
            <button key={t.k} type="button" role="radio" aria-checked={returnType === t.k} onClick={() => setReturnType(t.k)}
              className={`rounded-lg border px-4 py-3 text-left text-sm font-medium ${returnType === t.k ? "border-brand-500 bg-brand-50 text-brand-800 ring-1 ring-brand-300" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>
              {t.l}
            </button>
          ))}
        </div>
      </fieldset>

      <button type="button" disabled={busy || !clubId} onClick={onCreate} className="mt-4 w-full rounded-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
        {busy ? "Создание…" : "Создать черновик"}
      </button>
      {error ? <p className="mt-2 text-sm text-rose-600">{error}</p> : null}
    </div>
  );
}
