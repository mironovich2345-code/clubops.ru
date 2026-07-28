import type { ButtonHTMLAttributes, ReactNode } from "react";

// Unified mobile button system (Part 2 §1). One set of variants — not utility classes
// scattered per page. All share radius/font/focus; heights meet touch targets (≥44px,
// primary CTA 48px). Centered icon+label group. Works as <button> or, via `asChild`
// styling, applied to links through `buttonClass`.

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BASE = "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 disabled:opacity-60 disabled:pointer-events-none";
const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700",
  secondary: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
  danger: "border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:bg-slate-900 dark:text-rose-300",
  ghost: "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
};

/** Class string for the shared button look — use on <Link>/<a>/server-action buttons
 *  that can't be this component. `size`: cta=48px, md=44px, sm=36px. `block`=full-width. */
export function buttonClass(opts: { variant?: ButtonVariant; size?: "cta" | "md" | "sm"; block?: boolean } = {}): string {
  const { variant = "primary", size = "md", block = false } = opts;
  const h = size === "cta" ? "min-h-[48px] px-5" : size === "sm" ? "min-h-[36px] px-3" : "min-h-[44px] px-4";
  return `${BASE} ${VARIANT[variant]} ${h} ${block ? "w-full" : ""}`;
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "cta" | "md" | "sm"; block?: boolean };

function Btn({ variant = "primary", size = "md", block, className = "", ...rest }: BtnProps) {
  return <button {...rest} className={`${buttonClass({ variant, size, block })} ${className}`} />;
}

export const PrimaryButton = (p: Omit<BtnProps, "variant">) => <Btn variant="primary" {...p} />;
export const SecondaryButton = (p: Omit<BtnProps, "variant">) => <Btn variant="secondary" {...p} />;
export const DangerButton = (p: Omit<BtnProps, "variant">) => <Btn variant="danger" {...p} />;
export const GhostButton = (p: Omit<BtnProps, "variant">) => <Btn variant="ghost" {...p} />;

/** Icon-only button — REQUIRES aria-label (enforced by the required prop). 44×44. */
export function IconButton({ label, variant = "ghost", className = "", children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; variant?: ButtonVariant }) {
  return <button {...rest} aria-label={label} className={`${BASE} ${VARIANT[variant]} h-11 w-11 shrink-0 ${className}`}>{children}</button>;
}

/**
 * Row of action buttons (Part 2 §1). One child → full-width primary. Two children →
 * grid 1fr/1fr with 12px gap that stacks to one column below the safe width. Three or
 * more long buttons in a row are not allowed — pass ≤2 (put extras in a menu/sheet).
 */
export function ActionButtonRow({ children }: { children: ReactNode }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : [children];
  if (items.length <= 1) return <div className="grid grid-cols-1">{items}</div>;
  return <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">{items}</div>;
}

/** Segmented control for 2–3 mutually exclusive options (Part 2 §1). */
export function SegmentedControl({ children }: { children: ReactNode }) {
  return <div className="inline-flex rounded-lg bg-slate-100 p-1 dark:bg-slate-800">{children}</div>;
}
export function segmentClass(active: boolean): string {
  return `inline-flex min-h-[40px] items-center justify-center rounded-md px-4 text-sm font-medium transition ${active ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100" : "text-slate-500 hover:text-slate-700 dark:text-slate-400"}`;
}
