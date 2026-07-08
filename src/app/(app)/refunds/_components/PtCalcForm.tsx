"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatKopeks } from "@/lib/money";
import { savePersonalTrainingInputs, calculatePersonalTrainingRefund } from "../refund-document-actions";

type Trainer = { id: string; fullName: string; dismissed: boolean };
type Info = { clientName: string; clubName: string; returnTypeLabel: string; docsComplete: boolean; requisitesOk: boolean };
type Defaults = {
  applicationDate: string; contractAmountRub: string; terminationPriceRub: string;
  contractSessions: string; usedSessions: string; serviceNotProvided: boolean;
  calculationMethod: string; alternativeReason: string; trainerEmployeeId: string;
};
type Result = {
  mode: "not_provided" | "contract_rate" | "average_rate"; unavailable: boolean;
  contractAmountKopeks: number; trainerName: string; contractSessions: number; usedSessions: number;
  perSessionKopeks: number; usedAmountKopeks: number; preRoundKopeks: number; resultAmountKopeks: number | null;
  baseDate: string | null; plannedDate: string | null; adjustmentReason: string | null;
  reasonComment: string | null; refusalDraftText: string | null; unavailableReason: string | null; zeroRemaining: boolean;
};

const fmtDate = (isoStr: string | null) => { if (!isoStr) return "—"; const m = isoStr.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}.${m[2]}.${m[1]}` : isoStr; };
const METHOD_LABEL: Record<string, string> = { contract_rate: "Согласно условиям договора", average_rate: "По средней стоимости тренировки", not_provided: "Услуга не оказывалась" };

export function PtCalcForm({ refundId, expectedUpdatedAt, info, trainers, defaults, result, backHref }: {
  refundId: string; expectedUpdatedAt: string; info: Info; trainers: Trainer[];
  defaults: Defaults; result: Result | null; backHref: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [method, setMethod] = useState(defaults.calculationMethod || "contract_rate");
  const [notProvided, setNotProvided] = useState(defaults.serviceNotProvided);

  async function run(action: (p: undefined, fd: FormData) => Promise<{ ok: boolean; error?: string }>, isCalc: boolean) {
    if (busy || !formRef.current) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const fd = new FormData(formRef.current);
      fd.set("refundId", refundId); fd.set("expectedUpdatedAt", expectedUpdatedAt);
      const res = await action(undefined, fd);
      if (!res.ok) { setError(res.error ?? "Ошибка."); setBusy(false); return; }
      if (!isCalc) setSaved(true);
      router.refresh(); setBusy(false);
    } catch { setError("Ошибка."); setBusy(false); }
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="mt-4 grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm sm:grid-cols-2">
        <div><span className="text-slate-500">Клиент: </span>{info.clientName}</div>
        <div><span className="text-slate-500">Клуб: </span>{info.clubName}</div>
        <div className="sm:col-span-2"><span className="text-emerald-700">✓ Документы готовы</span><span className="ml-3 text-emerald-700">✓ Реквизиты заполнены</span></div>
      </div>

      <form ref={formRef} onSubmit={(e) => { e.preventDefault(); run(calculatePersonalTrainingRefund, true); }} className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Дата написания заявления</span>
            <input type="date" name="applicationDate" defaultValue={defaults.applicationDate} className="input w-full" /></label>
          <label className="flex items-center gap-2 self-end pb-2">
            <input type="checkbox" name="serviceNotProvided" checked={notProvided} onChange={(e) => setNotProvided(e.target.checked)} className="h-4 w-4" />
            <span className="text-sm font-medium text-slate-700">Услуга не оказывалась</span>
          </label>

          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Сумма договора, ₽</span>
            <input name="contractAmount" inputMode="decimal" defaultValue={defaults.contractAmountRub} placeholder="0,00" className="input w-full" /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Стоимость тренировки при расторжении, ₽</span>
            <input name="terminationPrice" inputMode="decimal" defaultValue={defaults.terminationPriceRub} placeholder="0,00" className="input w-full" /></label>

          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Количество тренировок по договору</span>
            <input name="contractSessions" inputMode="numeric" defaultValue={defaults.contractSessions} className="input w-full" /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Проведено тренировок</span>
            <input name="usedSessions" inputMode="numeric" defaultValue={defaults.usedSessions} className="input w-full" /></label>

          <label className="block sm:col-span-2"><span className="mb-1 block text-sm font-medium text-slate-700">Тренер</span>
            <select name="trainerEmployeeId" defaultValue={defaults.trainerEmployeeId} className="input w-full">
              <option value="" disabled>Выберите тренера</option>
              {trainers.map((t) => <option key={t.id} value={t.id}>{t.fullName}{t.dismissed ? " — Уволен" : ""}</option>)}
            </select></label>
        </div>

        {/* Calculation variant */}
        <fieldset className="mt-4">
          <legend className="mb-2 text-sm font-medium text-slate-700">Способ расчёта</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Способ расчёта">
            {[{ k: "contract_rate", l: "Согласно условиям договора", h: "Используется стоимость одной тренировки при расторжении, указанная в договоре." },
              { k: "average_rate", l: "По средней стоимости тренировки", h: "Стоимость одной тренировки рассчитывается как сумма договора, делённая на количество тренировок." }].map((v) => (
              <label key={v.k} className={`cursor-pointer rounded-lg border px-4 py-3 text-sm ${method === v.k ? "border-brand-500 bg-brand-50 ring-1 ring-brand-300" : "border-slate-300 bg-white hover:bg-slate-50"}`}>
                <input type="radio" name="calculationMethod" value={v.k} checked={method === v.k} onChange={() => setMethod(v.k)} className="sr-only" />
                <div className="font-medium text-slate-800">{v.l}</div>
                <div className="mt-0.5 text-xs text-slate-500">{v.h}</div>
              </label>
            ))}
          </div>
        </fieldset>

        {method === "average_rate" && !notProvided ? (
          <label className="mt-4 block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Почему выбран этот способ расчёта</span>
            <textarea name="alternativeReason" defaultValue={defaults.alternativeReason} rows={2} maxLength={2000} className="input w-full" placeholder="Объясните, почему не применяется стоимость тренировки при расторжении из договора" />
          </label>
        ) : (
          <input type="hidden" name="alternativeReason" value={defaults.alternativeReason} />
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" disabled={busy} onClick={() => run(savePersonalTrainingInputs, false)} className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60">Сохранить черновик</button>
          <button type="submit" disabled={busy} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">{busy ? "…" : "Рассчитать"}</button>
          {saved ? <span className="text-xs text-emerald-700" role="status">Черновик сохранён</span> : null}
        </div>
        {error ? <p className="mt-2 text-sm text-rose-600">{error}</p> : null}
      </form>

      {result ? (
        result.unavailable ? (
          <div className="mt-6 rounded-lg border border-rose-300 bg-white p-5 shadow-sm">
            <div className="inline-flex rounded-full bg-rose-100 px-3 py-1 text-sm font-semibold text-rose-800">Возврат не принимается</div>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
              <Row label="Сумма договора" value={formatKopeks(result.contractAmountKopeks)} />
              <Row label="Тренер" value={result.trainerName} />
              <Row label="Стоимость тренировки при расторжении" value={formatKopeks(result.perSessionKopeks)} />
              <Row label="Проведено тренировок" value={String(result.usedSessions)} />
              <Row label="Результат расчёта" value={formatKopeks(result.preRoundKopeks)} />
            </dl>
            {result.unavailableReason ? <p className="mt-2 text-sm text-rose-700">{result.unavailableReason}</p> : null}
            {result.refusalDraftText ? (
              <div className="mt-3">
                <div className="text-xs font-medium text-slate-600">Проект ответа клиенту</div>
                <p className="mt-1 whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-700">{result.refusalDraftText}</p>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-sm font-semibold text-slate-700">Результат расчёта</div>
            {result.mode === "not_provided" ? (
              <p className="mt-2 rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800">Услуга не оказывалась — к возврату рассчитана полная сумма договора.</p>
            ) : result.zeroRemaining ? (
              <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">Все тренировки по договору использованы. Расчётная сумма возврата равна 0 ₽.</p>
            ) : null}
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
              <Row label="Сумма договора" value={formatKopeks(result.contractAmountKopeks)} />
              <Row label="Тренер" value={result.trainerName} />
              <Row label="Куплено тренировок" value={String(result.contractSessions)} />
              <Row label="Проведено тренировок" value={String(result.usedSessions)} />
              <Row label="Способ расчёта" value={METHOD_LABEL[result.mode]} />
              {result.mode !== "not_provided" ? <Row label={result.mode === "average_rate" ? "Средняя стоимость (справочно)" : "Стоимость тренировки"} value={formatKopeks(result.perSessionKopeks)} /> : null}
              {result.mode !== "not_provided" ? <Row label="Использованная сумма" value={formatKopeks(result.usedAmountKopeks)} /> : null}
              {result.mode !== "not_provided" ? <Row label="Сумма до округления" value={formatKopeks(result.preRoundKopeks)} /> : null}
            </dl>
            <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2">
              <div className="text-xs text-emerald-700">Итоговая сумма возврата (округление вверх до рубля)</div>
              <div className="text-xl font-semibold text-emerald-800">{formatKopeks(result.resultAmountKopeks ?? 0)}</div>
            </div>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
              <Row label="Базовая дата возврата" value={fmtDate(result.baseDate)} />
              <Row label="Плановая дата возврата" value={fmtDate(result.plannedDate)} />
            </dl>
            {result.adjustmentReason ? <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{result.adjustmentReason}</p> : null}
            {result.mode === "average_rate" && result.reasonComment ? <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">Обоснование: {result.reasonComment}</p> : null}
          </div>
        )
      ) : null}

      <div className="mt-4 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        После реализации этапа согласования возврат можно будет отправить региональному директору.
      </div>
      <div className="mt-4"><a href={backHref} className="text-sm font-medium text-slate-600 hover:text-slate-800">← Назад к документам и реквизитам</a></div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div><dt className="inline text-slate-500">{label}: </dt><dd className="inline text-slate-800">{value}</dd></div>;
}
