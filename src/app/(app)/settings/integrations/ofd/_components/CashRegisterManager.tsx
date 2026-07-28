"use client";

import { useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { editCashRegister, deleteCashRegister, toggleOfdMapping } from "../actions";

type Opt = { id: string; name: string };
type ConnOpt = { id: string; name: string };
export type CashRegisterVM = {
  id: string;
  fnNumber: string;
  kktRegNumber: string | null;
  kktName: string | null;
  connectionId: string;
  connectionName: string;
  legalEntityId: string | null;
  legalName: string | null;
  clubId: string;
  clubName: string;
  registerKind: string;
  status: string; // active | disabled | archived | deleted
  isActive: boolean;
  receipts: number;
};

const initial = { ok: false as boolean, error: undefined as string | undefined, notice: undefined as string | undefined };
const KIND_LABEL: Record<string, string> = { club_cashbox: "Касса клуба", online_cashbox: "Онлайн-касса" };
const STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: "Активна", cls: "bg-emerald-50 text-emerald-700" },
  disabled: { label: "Выключена", cls: "bg-slate-100 text-slate-500" },
  archived: { label: "Удалена (в архиве)", cls: "bg-slate-200 text-slate-600" },
  deleted: { label: "Удалена", cls: "bg-slate-200 text-slate-600" },
};
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">{pending ? "…" : label}</button>;
}

function EditForm({ vm, clubs, entities, connections }: { vm: CashRegisterVM; clubs: Opt[]; entities: Opt[]; connections: ConnOpt[] }) {
  const [state, action] = useFormState(editCashRegister, initial);
  return (
    <form action={action} className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <input type="hidden" name="mappingId" value={vm.id} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block"><span className="mb-1 block text-[11px] text-slate-500">ФН</span><input name="fnNumber" defaultValue={vm.fnNumber} className="input w-full text-sm" /></label>
        <label className="block"><span className="mb-1 block text-[11px] text-slate-500">РНМ ККТ</span><input name="kktRegNumber" defaultValue={vm.kktRegNumber ?? ""} className="input w-full text-sm" /></label>
        <label className="block"><span className="mb-1 block text-[11px] text-slate-500">Название</span><input name="kktName" defaultValue={vm.kktName ?? ""} className="input w-full text-sm" /></label>
        <label className="block"><span className="mb-1 block text-[11px] text-slate-500">Подключение</span><select name="connectionId" defaultValue={vm.connectionId} className="input w-full text-sm">{connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="block"><span className="mb-1 block text-[11px] text-slate-500">Юрлицо</span><select name="legalEntityId" defaultValue={vm.legalEntityId ?? ""} className="input w-full text-sm"><option value="">— не задано —</option>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
        <label className="block"><span className="mb-1 block text-[11px] text-slate-500">Клуб</span><select name="clubId" defaultValue={vm.clubId} className="input w-full text-sm">{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="block"><span className="mb-1 block text-[11px] text-slate-500">Тип кассы</span><select name="registerKind" defaultValue={vm.registerKind} className="input w-full text-sm"><option value="club_cashbox">Касса клуба</option><option value="online_cashbox">Онлайн-касса</option></select></label>
        <label className="block"><span className="mb-1 block text-[11px] text-slate-500">Действует с</span><input type="date" name="effectiveFrom" defaultValue={todayISO()} className="input w-full text-sm" /></label>
      </div>
      <p className="text-[11px] text-slate-500">Изменение привязки закрывает предыдущую и открывает новую с указанной даты. Прошлые чеки не меняются.</p>
      <div className="flex items-center gap-2"><Submit label="Сохранить" />{state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}{state.ok ? <span className="text-xs text-emerald-600">{state.notice}</span> : null}</div>
    </form>
  );
}

function DeleteForm({ vm }: { vm: CashRegisterVM }) {
  const [state, action] = useFormState(deleteCashRegister, initial);
  const hasHistory = vm.receipts > 0;
  return (
    <form action={action} onSubmit={(e) => { if (!window.confirm(hasHistory ? "Касса будет удалена из активных настроек. Исторические чеки и аналитика сохранятся. Продолжить?" : "Удалить пустую кассу?")) e.preventDefault(); }} className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3">
      <input type="hidden" name="mappingId" value={vm.id} />
      <p className="mb-2 text-xs text-rose-700">{hasHistory ? `У кассы ${vm.receipts} импортированных чеков — она будет архивирована, история сохранится.` : "У кассы нет чеков — будет удалена полностью."}</p>
      <button type="submit" className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-rose-600 px-4 text-sm font-medium text-white hover:bg-rose-700">Удалить кассу</button>
      {state.error ? <span className="ml-2 text-xs text-rose-700">{state.error}</span> : null}
      {state.ok ? <span className="ml-2 text-xs text-emerald-700">{state.notice}</span> : null}
    </form>
  );
}

/**
 * Mobile-first cash-register manager (§9): cards (no horizontal scroll), one «Действия» menu
 * per card (Изменить / Вкл-выкл / Удалить), and an active/deleted/all filter. Replaces the
 * cramped multi-column table.
 */
export function CashRegisterManager({ registers, clubs, entities, connections }: { registers: CashRegisterVM[]; clubs: Opt[]; entities: Opt[]; connections: ConnOpt[] }) {
  const [filter, setFilter] = useState<"active" | "deleted" | "all">("active");
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "delete" | null>(null);

  const visible = useMemo(() => registers.filter((r) => {
    const removed = r.status === "archived" || r.status === "deleted";
    return filter === "all" ? true : filter === "deleted" ? removed : !removed;
  }), [registers, filter]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        {(["active", "deleted", "all"] as const).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} className={`rounded-full px-3 py-1 font-medium ${filter === f ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>{f === "active" ? "Активные" : f === "deleted" ? "Удалённые" : "Все"}</button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">Касс нет.</div>
      ) : (
        <ul className="space-y-3">
          {visible.map((r) => {
            const st = STATUS[r.status] ?? STATUS.active;
            const isOpen = openId === r.id;
            return (
              <li key={r.id} className={`rounded-lg border p-3 ${r.status === "active" && !r.legalEntityId ? "border-amber-300 bg-amber-50/50" : "border-slate-200 bg-white"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="break-all text-sm font-semibold text-slate-800">ФН {r.fnNumber}{r.kktName ? ` · ${r.kktName}` : ""}</div>
                    <div className="text-xs text-slate-500">{r.clubName} · {r.legalName ?? "⚠ юрлицо не задано"} · {r.connectionName}</div>
                    <div className="text-[11px] text-slate-400">{KIND_LABEL[r.registerKind] ?? r.registerKind}{r.kktRegNumber ? ` · РНМ ${r.kktRegNumber}` : ""} · чеков: {r.receipts}</div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${st.cls}`}>{st.label}</span>
                </div>

                {r.status !== "archived" && r.status !== "deleted" ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button type="button" onClick={() => { setOpenId(isOpen && mode === "edit" ? null : r.id); setMode("edit"); }} className="min-h-[36px] rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50">Изменить</button>
                    <form action={toggleOfdMapping}><input type="hidden" name="mappingId" value={r.id} /><button type="submit" className="min-h-[36px] rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50">{r.isActive ? "Выключить" : "Включить"}</button></form>
                    <button type="button" onClick={() => { setOpenId(isOpen && mode === "delete" ? null : r.id); setMode("delete"); }} className="min-h-[36px] rounded-md border border-rose-300 bg-white px-3 text-xs font-medium text-rose-700 hover:bg-rose-50">Удалить</button>
                  </div>
                ) : null}

                {isOpen && mode === "edit" ? <EditForm vm={r} clubs={clubs} entities={entities} connections={connections} /> : null}
                {isOpen && mode === "delete" ? <DeleteForm vm={r} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
