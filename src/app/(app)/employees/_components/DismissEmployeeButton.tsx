"use client";

import { dismissClubEmployee } from "../actions";

export function DismissEmployeeButton({ id, name }: { id: string; name: string }) {
  return (
    <form
      action={dismissClubEmployee}
      onSubmit={(e) => {
        if (!window.confirm(`Пометить сотрудника «${name}» как уволенного?`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300"
      >
        Пометить как уволен
      </button>
    </form>
  );
}
