"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatKopeks } from "@/lib/money";
import { saveMembershipInputs, calculateMembershipRefund } from "../refund-document-actions";

type Result = {
  mode: "formula" | "before_start" | "not_provided"; durationDays: number; refundableDays: number | null;
  contractAmountKopeks: number; dayPriceKopeksApprox: number; preRoundKopeks: number; resultAmountKopeks: number;
  baseDate: string | null; plannedDate: string | null; adjustmentReason: string | null; durationWarning: boolean; zeroRemaining: boolean;
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

export function MembershipCalcForm({
  refundId, expectedUpdatedAt, info, defaults, result, backHref,
}: {
  refundId: string;
  expectedUpdatedAt: string;
  info: { clientName: string; clubName: string; returnTypeLabel: string; docsComplete: boolean; requisitesOk: boolean };
  defaults: { serviceStartDate: string; serviceEndDate: string; applicationDate: string; contractAmountRub: string; serviceNotProvided: boolean };
  result: Result | null;
  backHref: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notProvided, setNotProvided] = useState(defaults.serviceNotProvided);

  async function run(action: (p: undefined, fd: FormData) => Promise<{ ok: boolean; error?: string }>, isCalc: boolean) {
    if (busy || !formRef.current) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const fd = new FormData(formRef.current);
      fd.set("refundId", refundId);
      fd.set("expectedUpdatedAt", expectedUpdatedAt);
      const res = await action(undefined, fd);
      if (!res.ok) { setError(res.error ?? "Ошибка."); setBusy(false); return; }
      if (!isCalc) setSaved(true);
      router.refresh();
      setBusy(false);
    } catch { setError("Ошибка."); setBusy(false); }
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      {/* Summary */}
      <div className="mt-4 grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm sm:grid-cols-2">
        <div><span className="text-slate-500">Клиент: </span>{info.clientName}</div>
        <div><span className="text-slate-500">Клуб: </span>{info.clubName}</div>
        <div><span className="text-slate-500">Тип возврата: </span>{info.returnTypeLabel}</div>
        <div>
          <span className="text-emerald-700">✓ Документы готовы</span>
          <span className="ml-3 text-emerald-700">✓ Реквизиты заполнены</span>
        </div>
      </div>

      {/* Inputs */}
      <form ref={formRef} onSubmit={(e) => { e.preventDefault(); run(calculateMembershipRefund, true); }} className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Дата начала оказания услуги</span>
            <input type="date" name="serviceStartDate" defaultValue={defaults.serviceStartDate} className="input w-full" /></label>

          <label className="flex items-center gap-2 self-end pb-2">
            <input type="checkbox" name="serviceNotProvided" checked={notProvided} onChange={(e) => setNotProvided(e.target.checked)} className="h-4 w-4" />
            <span className="text-sm font-medium text-slate-700">Услуга не оказывалась</span>
          </label>

          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Дата окончания оказания услуги</span>
            <input type="date" name="serviceEndDate" defaultValue={defaults.serviceEndDate} className="input w-full" /></label>

          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Дата написания заявления</span>
            <input type="date" name="applicationDate" defaultValue={defaults.applicationDate} className="input w-full" /></label>

          <label className="block sm:col-span-2 sm:max-w-xs"><span className="mb-1 block text-sm font-medium text-slate-700">Сумма договора, ₽</span>
            <input name="contractAmount" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" defaultValue={defaults.contractAmountRub} placeholder="0,00" className="input w-full" /></label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" disabled={busy} onClick={() => run(saveMembershipInputs, false)} className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60">Сохранить черновик</button>
          <button type="submit" disabled={busy} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">{busy ? "…" : "Рассчитать"}</button>
          {saved ? <span className="text-xs text-emerald-700" role="status">Черновик сохранён</span> : null}
        </div>
        {error ? <p className="mt-2 text-sm text-rose-600">{error}</p> : null}
      </form>

      {/* Result card */}
      {result ? (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-sm font-semibold text-slate-700">Результат расчёта</div>

          {result.mode === "not_provided" ? (
            <p className="mt-2 rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800">Услуга не оказывалась — к возврату рассчитана полная сумма договора.</p>
          ) : result.mode === "before_start" ? (
            <p className="mt-2 rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800">Заявление подано до начала оказания услуги, поэтому к возврату рассчитана полная сумма договора.</p>
          ) : result.zeroRemaining ? (
            <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">На дату заявления срок оказания услуги завершён. Расчётная сумма возврата равна 0 ₽.</p>
          ) : (
            <p className="mt-2 text-sm text-slate-600">Формула: <span className="font-medium">Сумма договора × оставшиеся дни ÷ общий срок услуги</span></p>
          )}

          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
            <Row label="Сумма договора" value={formatKopeks(result.contractAmountKopeks)} />
            <Row label="Общий срок услуги" value={`${result.durationDays} дн.`} />
            {result.mode === "formula" ? <Row label="Оставшиеся дни" value={`${result.refundableDays ?? 0} дн.`} /> : null}
            {result.mode === "formula" ? <Row label="Стоимость дня (справочно)" value={formatKopeks(result.dayPriceKopeksApprox)} /> : null}
            {result.mode === "formula" && !result.zeroRemaining ? <Row label="Сумма до округления" value={formatKopeks(result.preRoundKopeks)} /> : null}
          </dl>

          <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2">
            <div className="text-xs text-emerald-700">Итоговая сумма возврата (округление вверх до рубля)</div>
            <div className="text-xl font-semibold text-emerald-800">{formatKopeks(result.resultAmountKopeks)}</div>
          </div>

          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
            <Row label="Базовая дата возврата" value={fmtDate(result.baseDate)} />
            <Row label="Плановая дата возврата" value={fmtDate(result.plannedDate)} />
          </dl>
          {result.adjustmentReason ? <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{result.adjustmentReason}</p> : null}
          {result.durationWarning ? <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">Период услуги отличается от обычных 30–31 дней. Проверьте даты договора.</p> : null}

          {/* Phase 2A: sending is not yet available. */}
          <div className="mt-4 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-500">
            После реализации этапа согласования возврат можно будет отправить региональному директору.
          </div>
        </div>
      ) : null}

      <div className="mt-4">
        <a href={backHref} className="text-sm font-medium text-slate-600 hover:text-slate-800">← Назад к документам и реквизитам</a>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div><dt className="inline text-slate-500">{label}: </dt><dd className="inline text-slate-800">{value}</dd></div>;
}
