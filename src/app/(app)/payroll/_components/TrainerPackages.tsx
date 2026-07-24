"use client";

import { useFormState, useFormStatus } from "react-dom";
import { addTrainerPackage, removeTrainerPackage, confirmTrainerPackage, recordTrainerFinalSettlement, type TrainerState } from "../periods/trainer-actions";
import { formatKopeks } from "@/lib/money";

const initial: TrainerState = { ok: false };

export type TrainerSummaryVM = {
  soldPackages: number;
  salesTotalKopeks: number;
  refundsTotalKopeks: number;
  accrualKopeks: number;
  totalSessions: number;
  providedSessions: number;
  allowedPayoutKopeks: number;
  creditKopeks: number;
};
export type TrainerPackageVM = {
  id: string;
  clientRef: string | null;
  contractNumber: string | null;
  contractAmountKopeks: number;
  sessionCount: number;
  providedSessions: number;
  refundKopeks: number;
  trainerRateBp: number | null;
  seniorTrainerConfirmed: boolean;
};

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex items-center justify-center rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? "…" : label}
    </button>
  );
}

function AddPackageForm({ calculationId }: { calculationId: string }) {
  const [state, action] = useFormState(addTrainerPackage, initial);
  return (
    <form action={action} className="mt-3 grid grid-cols-1 gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-4 dark:border-slate-800">
      <input type="hidden" name="calculationId" value={calculationId} />
      <Field name="clientRef" label="Клиент (ID/ФИО)" />
      <Field name="contractNumber" label="№ договора" />
      <Field name="saleDate" label="Дата продажи" type="date" />
      <Field name="contractAmount" label="Сумма договора, ₽" type="number" />
      <Field name="sessionCount" label="Тренировок в пакете" type="number" />
      <Field name="trainerRatePercent" label="Ставка тренера, % (опц.)" type="number" placeholder="40 / 50" />
      <Field name="providedSessions" label="Проведено" type="number" />
      <Field name="returnedSessions" label="Возвращено" type="number" />
      <Field name="refund" label="Сумма возврата, ₽" type="number" />
      <label className="block">
        <span className="mb-1 block text-[11px] text-slate-500">Источник</span>
        <select name="source" defaultValue="manual" className="input w-full text-sm">
          <option value="manual">Вручную</option>
          <option value="import">Импорт</option>
          <option value="integration">Интеграция</option>
        </select>
      </label>
      <Field name="documentKey" label="Документ/подпись (опц.)" />
      <div className="flex items-end sm:col-span-2">
        <Submit label="Добавить пакет" />
        {state.error ? <span className="ml-3 text-xs text-rose-600">{state.error}</span> : null}
      </div>
    </form>
  );
}

function Field({ name, label, type = "text", placeholder }: { name: string; label: string; type?: string; placeholder?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-slate-500">{label}</span>
      <input name={name} type={type} min={type === "number" ? "0" : undefined} step={type === "number" ? "0.01" : undefined} placeholder={placeholder} className="input w-full text-sm" />
    </label>
  );
}

export function TrainerPackages({
  calculationId,
  summary,
  paidKopeks,
  employeeDebtKopeks,
  packages,
  canManage,
  locked,
  employeeDismissed,
}: {
  calculationId: string;
  summary: TrainerSummaryVM | null;
  paidKopeks: number;
  employeeDebtKopeks: number;
  packages: TrainerPackageVM[];
  canManage: boolean;
  locked: boolean;
  employeeDismissed: boolean;
}) {
  const [finalState, finalAction] = useFormState(recordTrainerFinalSettlement, initial);
  const s = summary;
  return (
    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800/70">
      <div className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">Тренер ТЗ · пакеты</div>

      {s ? (
        <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          <Metric label="Продано пакетов" value={String(s.soldPackages)} />
          <Metric label="Сумма продаж" value={formatKopeks(s.salesTotalKopeks)} />
          <Metric label="Начисление тренера" value={formatKopeks(s.accrualKopeks)} />
          <Metric label="Проведено тренировок" value={`${s.providedSessions} / ${s.totalSessions}`} />
          <Metric label="Стоимость проведённых" value={formatKopeks(s.allowedPayoutKopeks)} />
          <Metric label="Уже выплачено" value={formatKopeks(paidKopeks)} />
          <Metric label="Допустимо к выплате" value={formatKopeks(s.allowedPayoutKopeks)} />
          <Metric label="Кредит тренера" value={formatKopeks(s.creditKopeks)} accent={s.creditKopeks > 0} />
          <Metric label="Возвраты" value={formatKopeks(s.refundsTotalKopeks)} />
          <Metric label="Остаточный долг" value={formatKopeks(employeeDebtKopeks)} accent={employeeDebtKopeks > 0} />
        </div>
      ) : null}

      {packages.length > 0 ? (
        <ul className="mb-2 space-y-1">
          {packages.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-slate-600 dark:text-slate-300">
                {p.clientRef ?? "клиент"}{p.contractNumber ? ` · №${p.contractNumber}` : ""} · {formatKopeks(p.contractAmountKopeks)} · {p.providedSessions}/{p.sessionCount} занятий
                {p.trainerRateBp != null ? ` · ${(p.trainerRateBp / 100).toFixed(0)}%` : ""}
                {p.refundKopeks > 0 ? ` · возврат ${formatKopeks(p.refundKopeks)}` : ""}
                {p.seniorTrainerConfirmed ? <span className="ml-1 text-emerald-600">✓ подтверждено</span> : <span className="ml-1 text-amber-600">не подтверждено</span>}
              </span>
              {canManage && !locked ? (
                <span className="flex gap-2">
                  {!p.seniorTrainerConfirmed ? (
                    <form action={confirmTrainerPackage}>
                      <input type="hidden" name="packageId" value={p.id} />
                      <button type="submit" className="text-slate-500 hover:text-emerald-600">подтвердить</button>
                    </form>
                  ) : null}
                  <form action={removeTrainerPackage} onSubmit={(e) => { if (!window.confirm("Удалить пакет?")) e.preventDefault(); }}>
                    <input type="hidden" name="packageId" value={p.id} />
                    <button type="submit" className="text-slate-400 hover:text-rose-600">✕</button>
                  </form>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mb-2 text-xs text-slate-400">Пакеты не добавлены.</div>
      )}

      {canManage && !locked ? <AddPackageForm calculationId={calculationId} /> : null}

      {canManage && employeeDismissed && s && s.creditKopeks > 0 ? (
        <form action={finalAction} className="mt-3 flex items-center gap-3">
          <input type="hidden" name="calculationId" value={calculationId} />
          <button type="submit" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
            Окончательный расчёт (удержать кредит {formatKopeks(s.creditKopeks)})
          </button>
          {finalState.ok ? <span className="text-xs text-emerald-600">{finalState.notice}</span> : finalState.error ? <span className="text-xs text-rose-600">{finalState.error}</span> : null}
        </form>
      ) : null}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className={`tabular-nums font-medium ${accent ? "text-rose-600 dark:text-rose-400" : "text-slate-800 dark:text-slate-100"}`}>{value}</span>
    </div>
  );
}
