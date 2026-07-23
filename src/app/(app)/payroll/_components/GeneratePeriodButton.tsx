"use client";

import { useFormStatus } from "react-dom";
import { generateCalculations } from "../periods/actions";

function Btn({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
    >
      {pending ? "Формирование..." : label}
    </button>
  );
}

export function GeneratePeriodButton({ periodId, hasCalcs }: { periodId: string; hasCalcs: boolean }) {
  return (
    <form action={generateCalculations}>
      <input type="hidden" name="periodId" value={periodId} />
      <Btn label={hasCalcs ? "Обновить состав из закреплений" : "Сформировать расчёты по закреплениям"} />
    </form>
  );
}
