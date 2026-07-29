import type { ReactNode } from "react";

// Shared date/month field (UI consistency §6). The WRAPPER owns border/background/
// padding/height (48px); the native input is transparent with no padding so iOS
// date/month controls stop looking oversized and match neighbouring selects. 16px
// font (no iOS zoom), w-full min-w-0 (never exceeds the card). Uses semantic tokens.
export function DateField({
  label,
  name,
  defaultValue,
  type = "date",
  required,
  min,
  max,
  ariaLabel,
}: {
  label?: ReactNode;
  name: string;
  defaultValue?: string;
  type?: "date" | "month" | "datetime-local" | "time";
  required?: boolean;
  min?: string;
  max?: string;
  ariaLabel?: string;
}) {
  // Root is a <div> (not <label>) so it can nest safely inside an existing <label>
  // (e.g. a form field that already renders its own label + span). When used standalone
  // the label text is a <span> and the input carries an aria-label for its name.
  return (
    <div className="min-w-0">
      {label ? <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">{label}</span> : null}
      <span className="flex h-12 w-full max-w-full items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3">
        <input
          type={type}
          name={name}
          defaultValue={defaultValue}
          required={required}
          min={min}
          max={max}
          aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
          className="w-full min-w-0 border-0 bg-transparent p-0 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-0"
          style={{ fontSize: 16 }}
        />
      </span>
    </div>
  );
}

export function MonthField(props: Omit<Parameters<typeof DateField>[0], "type">) {
  return <DateField type="month" {...props} />;
}
