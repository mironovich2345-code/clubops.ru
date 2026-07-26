"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { proposeChange, type ChangeRequestState } from "../change-requests/actions";
import { STATUS_LABEL, FIELD_TYPE_LABEL } from "@/lib/payroll/change-request";
import { formatKopeks } from "@/lib/money";

const initial: ChangeRequestState = { ok: false };

// Allowed scheme fields for THIS calc (server passes the whitelist for the scheme type).
export type ProposeFieldOption = { key: string; fieldType: string; unit: string; labelRu: string; currentDisplay: string };
export type ChangeRequestRow = {
  id: string;
  requestType: string;
  fieldType: string;
  targetField: string | null;
  status: string;
  impactKopeks: number | null;
  impactUncomputable: boolean;
  revision: number;
};

const toneCls: Record<string, string> = {
  amber: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  sky: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  emerald: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  rose: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  slate: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
};

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex items-center justify-center rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? "..." : "Отправить на согласование"}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_LABEL[status] ?? { label: status, tone: "slate" as const };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${toneCls[s.tone]}`}>{s.label}</span>;
}

/**
 * Regional director: "Предложить изменение" + the existing "Изменения и согласования"
 * list for this calculation. A pending proposal does NOT affect the total — the impact
 * shown is only a preview until a GD/owner approves it.
 */
export function ProposeChangeSection({
  calculationId,
  fields,
  requests,
  canPropose,
  unitHint,
}: {
  calculationId: string;
  fields: ProposeFieldOption[];
  requests: ChangeRequestRow[];
  canPropose: boolean;
  unitHint?: Record<string, string>;
}) {
  const [state, action] = useFormState(proposeChange, initial);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string>("one_time_bonus"); // "one_time_bonus" | field key
  const [horizon, setHorizon] = useState<"period_adjustment" | "future_scheme_change">("period_adjustment");

  const field = useMemo(() => fields.find((f) => f.key === kind), [fields, kind]);
  const unitLabel = field ? unitHint?.[field.unit] ?? "" : "₽";

  return (
    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800/70">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">Изменения и согласования</div>
        {canPropose ? (
          <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">
            {open ? "Скрыть" : "Предложить изменение"}
          </button>
        ) : null}
      </div>

      {requests.length === 0 ? (
        <div className="mb-2 text-xs text-slate-400">Заявок на изменение нет.</div>
      ) : (
        <ul className="mb-3 space-y-1">
          {requests.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-slate-600 dark:text-slate-300">
                {FIELD_TYPE_LABEL[r.fieldType] ?? r.fieldType}
                {r.targetField && r.targetField !== "one_time_bonus" ? ` · ${r.targetField}` : ""}
                {r.revision > 1 ? <span className="text-slate-400"> · ред. {r.revision}</span> : null}
                {" — "}
                {r.impactUncomputable ? (
                  <span className="text-amber-600">влияние не рассчитано</span>
                ) : r.impactKopeks != null ? (
                  <span className={r.impactKopeks >= 0 ? "text-emerald-600" : "text-rose-600"}>{r.impactKopeks >= 0 ? "+" : "−"}{formatKopeks(Math.abs(r.impactKopeks))}</span>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <StatusBadge status={r.status} />
                <Link href={`/payroll/change-requests/${r.id}`} className="text-brand-700 hover:underline dark:text-brand-300">открыть</Link>
              </span>
            </li>
          ))}
        </ul>
      )}

      {canPropose && open ? (
        <form action={action} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <input type="hidden" name="calculationId" value={calculationId} />
          <input type="hidden" name="requestType" value={horizon} />
          <input type="hidden" name="fieldType" value={kind === "one_time_bonus" ? "one_time_bonus" : field?.fieldType ?? ""} />
          {kind !== "one_time_bonus" ? <input type="hidden" name="targetField" value={kind} /> : null}

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-500">Что изменить</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)} className="input w-full text-sm">
                <option value="one_time_bonus">Разовая премия</option>
                {fields.map((f) => (
                  <option key={f.key} value={f.key}>{f.labelRu} ({FIELD_TYPE_LABEL[f.fieldType] ?? f.fieldType})</option>
                ))}
              </select>
            </label>

            {kind === "one_time_bonus" ? (
              <label className="block">
                <span className="mb-1 block text-[11px] text-slate-500">Сумма премии, ₽</span>
                <input name="bonusAmount" type="number" min="0" step="0.01" className="input w-full text-sm" />
              </label>
            ) : (
              <label className="block">
                <span className="mb-1 block text-[11px] text-slate-500">
                  Новое значение{unitLabel ? `, ${unitLabel}` : ""} {field ? <span className="text-slate-400">· сейчас: {field.currentDisplay}</span> : null}
                </span>
                <input name="proposedValue" type="number" min="0" step="0.01" className="input w-full text-sm" />
              </label>
            )}
          </div>

          {kind !== "one_time_bonus" ? (
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-600 dark:text-slate-300">
              <label className="inline-flex items-center gap-1">
                <input type="radio" name="horizon" checked={horizon === "period_adjustment"} onChange={() => setHorizon("period_adjustment")} />
                Разово в этом периоде
              </label>
              <label className="inline-flex items-center gap-1">
                <input type="radio" name="horizon" checked={horizon === "future_scheme_change"} onChange={() => setHorizon("future_scheme_change")} />
                С будущей даты (новая схема)
              </label>
              {horizon === "future_scheme_change" ? (
                <>
                  <label className="inline-flex items-center gap-1">
                    Действует с:
                    <input name="effectiveFrom" type="date" className="input text-xs" />
                  </label>
                  <label className="inline-flex items-center gap-1">
                    Область:
                    <select name="schemeScope" defaultValue="employee" className="input text-xs">
                      <option value="employee">Этот сотрудник</option>
                      <option value="payroll_category">Вся категория клуба</option>
                    </select>
                  </label>
                </>
              ) : null}
            </div>
          ) : null}

          <label className="mt-2 block">
            <span className="mb-1 block text-[11px] text-slate-500">Причина / обоснование для ГД (обязательно)</span>
            <textarea name="reason" required rows={2} className="input w-full text-sm" />
          </label>
          <label className="mt-2 block">
            <span className="mb-1 block text-[11px] text-slate-500">Комментарий (необязательно)</span>
            <input name="regionalComment" className="input w-full text-sm" />
          </label>

          <div className="mt-2 flex items-center gap-3">
            <Submit />
            {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
            {state.ok && state.notice ? <span className="text-xs text-emerald-600">{state.notice}</span> : null}
          </div>
          <p className="mt-2 text-[11px] text-slate-400">Предложение не влияет на расчёт, пока его не согласует ГД или собственник.</p>
        </form>
      ) : null}
    </div>
  );
}
