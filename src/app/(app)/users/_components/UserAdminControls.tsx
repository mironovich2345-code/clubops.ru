"use client";

import { useFormState, useFormStatus } from "react-dom";
import { adminRevokeUserSessions, adminSetUserActive } from "../actions";

type State = { ok: boolean; error?: string };
const initial: State = { ok: false };

function Btn({ label, tone = "slate", confirm }: { label: string; tone?: "slate" | "rose" | "emerald"; confirm?: string }) {
  const { pending } = useFormStatus();
  const cls =
    tone === "rose" ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
    : tone === "emerald" ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-60 ${cls}`}
    >
      {pending ? "..." : label}
    </button>
  );
}

export function UserAdminControls({
  targetUserId,
  isActive,
  sessionCount,
}: {
  targetUserId: string;
  isActive: boolean;
  sessionCount: number;
}) {
  const [revokeState, revokeAction] = useFormState(adminRevokeUserSessions, initial);
  const [activeState, activeAction] = useFormState(adminSetUserActive, initial);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-slate-500">Активных сессий: {sessionCount}</span>
      <div className="flex flex-wrap gap-1.5">
        <form action={revokeAction}>
          <input type="hidden" name="targetUserId" value={targetUserId} />
          <Btn label="Завершить все сессии" confirm="Завершить все сессии этого пользователя?" />
        </form>
        <form action={activeAction}>
          <input type="hidden" name="targetUserId" value={targetUserId} />
          <input type="hidden" name="active" value={isActive ? "false" : "true"} />
          {isActive ? (
            <Btn label="Отключить" tone="rose" confirm="Отключить пользователя? Все его сессии будут завершены." />
          ) : (
            <Btn label="Включить" tone="emerald" />
          )}
        </form>
      </div>
      {revokeState.error ? <span className="text-xs text-rose-600">{revokeState.error}</span> : null}
      {activeState.error ? <span className="text-xs text-rose-600">{activeState.error}</span> : null}
    </div>
  );
}
