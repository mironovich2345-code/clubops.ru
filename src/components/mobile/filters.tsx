import type { ReactNode } from "react";
import { buttonClass } from "./buttons";

// Shared mobile filter layout (Part 2 §6). Consistent spacing/columns + a unified
// Apply/Reset row across pages — desktop layout stays whatever the page wraps.

/** Filter fields in one mobile column (equal 2 columns from 380px if `two`), gap 12px.
 *  Inputs/selects should be `w-full` (global CSS already clamps them). */
export function MobileFilterStack({ two = false, children }: { two?: boolean; children: ReactNode }) {
  return <div className={`grid grid-cols-1 gap-3 ${two ? "min-[380px]:grid-cols-2" : ""}`}>{children}</div>;
}

/** Apply (primary) + optional Reset (secondary). Full-width stacked on mobile; on desktop
 *  they size to content. `applyProps`/`resetProps` are passed to the button/link. */
export function FilterActionRow({
  applyLabel = "Показать",
  resetHref,
  resetLabel = "Сбросить",
  applyFormId,
}: {
  applyLabel?: string;
  resetHref?: string;
  resetLabel?: string;
  applyFormId?: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2 lg:flex lg:w-auto">
      <button type="submit" form={applyFormId} className={buttonClass({ variant: "primary" })}>{applyLabel}</button>
      {resetHref ? (
        <a href={resetHref} className={buttonClass({ variant: "secondary" })}>{resetLabel}</a>
      ) : null}
    </div>
  );
}

/** Labeled field wrapper — mobile-consistent label→control spacing. Control (input/select/
 *  date) passed as children; global CSS makes native controls full-width + clamped. */
export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">{label}</span>
      {children}
    </label>
  );
}
