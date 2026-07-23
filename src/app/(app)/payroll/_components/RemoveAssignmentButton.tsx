"use client";

import { removeClubAssignment } from "../actions";

export function RemoveAssignmentButton({ employeeId, assignmentId }: { employeeId: string; assignmentId: string }) {
  return (
    <form
      action={removeClubAssignment}
      onSubmit={(e) => {
        if (!window.confirm("Убрать это закрепление?")) e.preventDefault();
      }}
    >
      <input type="hidden" name="employeeId" value={employeeId} />
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <button
        type="submit"
        className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300"
      >
        Убрать
      </button>
    </form>
  );
}
