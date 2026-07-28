import type { SVGProps } from "react";

// Single mobile icon system (spec §2). One visual language: 24-viewBox line icons,
// currentColor stroke, uniform weight — NOT colourful emoji. Decorative icons are
// aria-hidden; icon-only buttons must supply their own aria-label.
function Svg({ children, className, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className ?? "h-5 w-5"} aria-hidden focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const MenuIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M4 6h16M4 12h16M4 18h16" /></Svg>;
export const CloseIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const ChevronDownIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M6 9l6 6 6-6" /></Svg>;
export const FilterIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M3 5h18l-7 8v6l-4-2v-4z" /></Svg>;
export const CameraIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M3 8h3l2-2h8l2 2h3v11H3z" /><circle cx="12" cy="13" r="3.2" /></Svg>;
export const PaperclipIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.3 3.3 0 015 4.5l-8.6 8.6a1.7 1.7 0 01-2.4-2.4L14 7" /></Svg>;
export const InfoIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.5" /></Svg>;
export const SwitchIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M4 8h13l-3-3M20 16H7l3 3" /></Svg>;
export const ArrowRightIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>;
export const ExternalLinkIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M14 5h5v5M19 5l-8 8M12 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-6" /></Svg>;
export const DownloadIcon = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M12 4v11M8 11l4 4 4-4M5 20h14" /></Svg>;

// Per-page navigation icons. Keys match AppPage. A missing key falls back to a dot.
const PAGE_PATHS: Record<string, JSX.Element> = {
  workspace: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11" /></>,
  dashboard: <><path d="M4 11l8-6 8 6" /><path d="M6 10v9h12v-9" /></>,
  analytics: <><path d="M5 20V10M12 20V4M19 20v-7" /></>,
  ofd_sales: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>,
  expenses: <><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></>,
  collections: <><path d="M4 7h13a3 3 0 013 3v6a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2h11" /><circle cx="17" cy="13" r="1.2" /></>,
  invoices: <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4M10 12h5M10 16h5" /></>,
  payments: <><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M4 9h16M8 3v4M16 3v4" /></>,
  mandatory_payments: <><path d="M8 3h8v8l-4-2.5L8 11z" /><path d="M8 14h8M8 18h5" /></>,
  balances: <><path d="M4 10l8-5 8 5" /><path d="M5 10v8M12 10v8M19 10v8M4 20h16" /></>,
  employees: <><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0112 0M16 6a3 3 0 010 6M21 20a5 5 0 00-4-5" /></>,
  payroll: <><circle cx="8" cy="9" r="4" /><path d="M12 6.5a4 4 0 010 5M8 7.5v3M6.6 9h2.8" /></>,
  refunds: <><path d="M9 7L4 12l5 5" /><path d="M4 12h11a5 5 0 015 5v1" /></>,
  budgets: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.8" fill="currentColor" /></>,
  documents: <><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></>,
  activity: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
  users: <><circle cx="8" cy="15" r="3" /><path d="M10 13l7-7 3 3-1 1-1.5-1.5M14 9l1.5 1.5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></>,
};

export function NavIcon({ page, className }: { page: string; className?: string }) {
  const inner = PAGE_PATHS[page];
  if (!inner) return <span className={`inline-block rounded-full bg-current opacity-40 ${className ?? "h-5 w-5"}`} aria-hidden />;
  return <Svg className={className}>{inner}</Svg>;
}

// Small status dot for tone labels (replaces 🟢🟡🔴). Colour via className.
export function StatusDot({ className }: { className?: string }) {
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${className ?? "bg-slate-400"}`} aria-hidden />;
}
