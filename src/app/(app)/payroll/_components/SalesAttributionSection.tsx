"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { applyPeriodSalesAction, setManualSalesOverride, type SalesActionState } from "../sales-actions";
import { formatKopeks } from "@/lib/money";

const initial: SalesActionState = { ok: false };

export type SalesVM = {
  automaticKopeks: number;
  manualOverrideKopeks: number | null;
  effectiveKopeks: number;
  source: string;
  receiptCount: number;
  refundKopeks: number;
  unmatchedReceiptCount: number;
  disputedRefundCount: number;
  syncedAt: string | null;
};

const SOURCE_LABEL: Record<string, string> = { manual: "ручной ввод", ofd_confirmed: "ОФД (подтверждённые чеки)", mixed: "смешанный" };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">{pending ? "..." : label}</button>;
}

/**
 * "Продажи и возвраты" block (spec §30) for categories with personal sales. Shows the OFD
 * automatic figure, manual override, effective sales, receipt/refund/unmatched counts and the
 * last sync. Preview and apply run through the same attribution service server-side. Manager
 * never sees raw JSON. Locked periods are read-only (buttons hidden by canManage).
 */
export function SalesAttributionSection({ calculationId, periodId, vm, canManage }: { calculationId: string; periodId: string; vm: SalesVM; canManage: boolean }) {
  const [applyState, apply] = useFormState(applyPeriodSalesAction, initial);
  const [manualState, setManual] = useFormState(setManualSalesOverride, initial);
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800/70">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">Продажи и возвраты</div>
        <span className="text-[11px] text-slate-400">Источник: {SOURCE_LABEL[vm.source] ?? vm.source}{vm.syncedAt ? ` · синхр. ${vm.syncedAt}` : ""}</span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <Field label="Продажи ОФД" value={formatKopeks(vm.automaticKopeks + vm.refundKopeks)} />
        <Field label="Возвраты" value={`−${formatKopeks(vm.refundKopeks)}`} />
        <Field label="Автоматически (нетто)" value={formatKopeks(vm.automaticKopeks)} />
        <Field label="Ручная корректировка" value={vm.manualOverrideKopeks == null ? "—" : formatKopeks(vm.manualOverrideKopeks)} />
        <Field label="Эффективная выручка" value={formatKopeks(vm.effectiveKopeks)} accent />
        <Field label="Чеков" value={String(vm.receiptCount)} />
      </dl>

      {vm.unmatchedReceiptCount > 0 || vm.disputedRefundCount > 0 ? (
        <div className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          {vm.unmatchedReceiptCount > 0 ? `Не привязано чеков: ${vm.unmatchedReceiptCount}. ` : ""}
          {vm.disputedRefundCount > 0 ? `Спорных возвратов: ${vm.disputedRefundCount}. ` : ""}
          Разберите в разделе «Кассиры ОФД».
        </div>
      ) : null}

      {canManage ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <form action={apply} onSubmit={(e) => { if (!window.confirm("Обновить продажи из ОФД для всего периода?")) e.preventDefault(); }}>
            <input type="hidden" name="periodId" value={periodId} />
            <Submit label="Обновить продажи из ОФД" />
          </form>
          <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">{open ? "Скрыть ручной ввод" : "Ввести вручную"}</button>
          {applyState.error ? <span className="w-full text-xs text-rose-600">{applyState.error}</span> : null}
          {applyState.ok && applyState.notice ? <span className="w-full text-xs text-emerald-600">{applyState.notice}</span> : null}
        </div>
      ) : null}

      {canManage && open ? (
        <form action={setManual} className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <input type="hidden" name="calculationId" value={calculationId} />
          <label className="block">
            <span className="mb-1 block text-[11px] text-slate-500">Ручная выручка, ₽ (перекрывает ОФД)</span>
            <input name="manualSales" type="number" min="0" step="0.01" defaultValue={vm.manualOverrideKopeks != null ? (vm.manualOverrideKopeks / 100).toString() : ""} className="input w-40 text-sm" />
          </label>
          <label className="block grow">
            <span className="mb-1 block text-[11px] text-slate-500">Комментарий</span>
            <input name="manualSalesComment" className="input w-full text-sm" />
          </label>
          <Submit label="Сохранить" />
          <button type="submit" name="clear" value="1" className="min-h-[44px] rounded-lg border border-slate-300 px-3 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300">Снять корректировку</button>
          {manualState.error ? <span className="w-full text-xs text-rose-600">{manualState.error}</span> : null}
          {manualState.ok && manualState.notice ? <span className="w-full text-xs text-emerald-600">{manualState.notice}</span> : null}
        </form>
      ) : null}
    </div>
  );
}

function Field({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return <div><dt className="text-[11px] text-slate-400">{label}</dt><dd className={`tabular-nums ${accent ? "font-semibold text-slate-900 dark:text-slate-100" : "text-slate-700 dark:text-slate-300"}`}>{value}</dd></div>;
}
