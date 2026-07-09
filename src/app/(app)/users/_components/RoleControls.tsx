"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { promoteToRegional, demoteToManager } from "../role-actions";

type Club = { id: string; name: string };
type State = { ok: boolean; error?: string };
const init: State = { ok: false };

function SubmitBtn({ label, disabled }: { label: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending || disabled} className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
      {pending ? "..." : label}
    </button>
  );
}

/** GD-only manager↔regional controls for one employee. `shape` is the user's
 * role state in this company ("manager" → promote, "regional" → demote). */
export function RoleControls({ userId, userName, shape, clubs }: { userId: string; userName: string; shape: "manager" | "regional"; clubs: Club[] }) {
  const [open, setOpen] = useState(false);

  if (clubs.length === 0) return null;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        {shape === "manager" ? "Повысить до регионального директора" : "Назначить управляющим"}
      </button>
    );
  }

  return (
    <div className="rounded-md border border-slate-300 bg-slate-50 p-3">
      {shape === "manager"
        ? <PromoteForm userId={userId} userName={userName} clubs={clubs} onClose={() => setOpen(false)} />
        : <DemoteForm userId={userId} userName={userName} clubs={clubs} onClose={() => setOpen(false)} />}
    </div>
  );
}

function PromoteForm({ userId, userName, clubs, onClose }: { userId: string; userName: string; clubs: Club[]; onClose: () => void }) {
  const [state, action] = useFormState(promoteToRegional, init);
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="userId" value={userId} />
      <div className="text-xs font-semibold text-slate-700">Клубы регионального директора</div>
      <div className="max-h-40 space-y-1 overflow-y-auto">
        {clubs.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" name="clubIds" value={c.id} checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
            {c.name}
          </label>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">
        {userName} потеряет роль управляющего и получит доступ регионального директора к выбранным клубам
        {selected.length > 0 ? `: ${clubs.filter((c) => selected.includes(c.id)).map((c) => c.name).join(", ")}` : ""}.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitBtn label="Подтвердить" disabled={selected.length === 0} />
        <button type="button" onClick={onClose} className="text-xs text-slate-500 underline">Отмена</button>
        {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
      </div>
    </form>
  );
}

function DemoteForm({ userId, userName, clubs, onClose }: { userId: string; userName: string; clubs: Club[]; onClose: () => void }) {
  const [state, action] = useFormState(demoteToManager, init);
  const [clubId, setClubId] = useState("");

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="userId" value={userId} />
      <label className="block text-xs font-semibold text-slate-700">
        Клуб управляющего
        <select name="clubIds" value={clubId} onChange={(e) => setClubId(e.target.value)} className="input mt-1">
          <option value="" disabled>Выберите клуб</option>
          {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <p className="text-[11px] text-slate-500">
        {userName} потеряет доступ регионального директора и станет управляющим клуба
        {clubId ? `: ${clubs.find((c) => c.id === clubId)?.name}` : ""}.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitBtn label="Подтвердить" disabled={!clubId} />
        <button type="button" onClick={onClose} className="text-xs text-slate-500 underline">Отмена</button>
        {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
      </div>
    </form>
  );
}
