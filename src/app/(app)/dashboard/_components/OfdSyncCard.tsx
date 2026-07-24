"use client";

import { useFormState, useFormStatus } from "react-dom";
import { triggerOfdSync, type DashboardSyncState } from "../ofd-actions";
import type { OfdSyncHealthState } from "@/lib/ofd/health";

const initial: DashboardSyncState = { ok: false };

const STATE_STYLE: Record<OfdSyncHealthState, { dot: string; label: string }> = {
  healthy: { dot: "bg-emerald-500", label: "В норме" },
  running: { dot: "bg-sky-500", label: "Выполняется" },
  delayed: { dot: "bg-amber-500", label: "Задержка синхронизации" },
  failed: { dot: "bg-rose-500", label: "Ошибка последнего запуска" },
  never_synced: { dot: "bg-slate-400", label: "Ещё не синхронизировалось" },
  disabled: { dot: "bg-slate-300", label: "Отключено" },
};

const fmtWhen = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
};

function SyncButton({ canTrigger }: { canTrigger: boolean }) {
  const { pending } = useFormStatus();
  if (!canTrigger) return null;
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Синхронизация…" : "Синхронизировать"}
    </button>
  );
}

export function OfdSyncCard({
  state,
  provider,
  connectionCount,
  lastSuccessAt,
  lastRunAt,
  lastRunStatus,
  imported,
  found,
  canTrigger,
}: {
  state: OfdSyncHealthState;
  provider: string;
  connectionCount: number;
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  imported: number;
  found: number;
  canTrigger: boolean;
}) {
  const [formState, action] = useFormState(triggerOfdSync, initial);
  const style = STATE_STYLE[state];

  return (
    <div className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${style.dot}`} aria-hidden />
            Данные ОФД
            <span className="text-xs font-normal text-slate-400">· {style.label}</span>
          </div>
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <div><dt className="inline">Последняя успешная: </dt><dd className="inline font-medium text-slate-700 dark:text-slate-300">{fmtWhen(lastSuccessAt)}</dd></div>
            <div><dt className="inline">Последний запуск: </dt><dd className="inline font-medium text-slate-700 dark:text-slate-300">{fmtWhen(lastRunAt)}{lastRunStatus ? ` (${lastRunStatus})` : ""}</dd></div>
            <div><dt className="inline">Источник: </dt><dd className="inline font-medium text-slate-700 dark:text-slate-300">{provider}</dd></div>
            <div><dt className="inline">Подключений: </dt><dd className="inline font-medium text-slate-700 dark:text-slate-300">{connectionCount}</dd></div>
            <div><dt className="inline">Загружено/новых: </dt><dd className="inline font-medium text-slate-700 dark:text-slate-300">{found}/{imported}</dd></div>
          </dl>
          {formState.notice ? <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{formState.notice}</div> : null}
          {formState.error ? <div className="mt-2 text-xs text-rose-600 dark:text-rose-400">{formState.error}</div> : null}
        </div>
        <form action={action}>
          <SyncButton canTrigger={canTrigger} />
        </form>
      </div>
    </div>
  );
}
