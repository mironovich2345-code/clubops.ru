import type { ReactNode } from "react";
import { DocumentLink } from "./DocumentViewer";
import { StatusBadge } from "./StatusBadge";
import { buttonClass } from "./buttons";

/**
 * Shared document row for finance detail pages (refunds / invoices / expenses).
 * One consistent layout instead of a wrapping "label · filename · Открыть" line:
 *  - the slot label on its own muted line;
 *  - the filename on its own line, truncating when long (full name in `title`);
 *  - a compact secondary "Открыть" action on the right (opens the shared viewer).
 * Every row shares the same min height so a mixed list of loaded / not-loaded
 * documents stays visually even (spec §1: одинаковая высота строк).
 */
export function FileRow({
  label,
  filename,
  href,
  mime,
  missingText = "не загружен",
}: {
  label: ReactNode;
  filename?: string | null;
  href?: string | null;
  mime?: string;
  missingText?: string;
}) {
  const present = Boolean(href && filename);
  return (
    <div className="flex min-h-[56px] items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-xs font-medium text-slate-500">{label}</div>
        {present ? (
          <div className="truncate text-sm text-slate-800" title={filename ?? undefined}>{filename}</div>
        ) : (
          <div className="text-sm text-rose-600">{missingText}</div>
        )}
      </div>
      {present ? (
        <DocumentLink href={href!} name={filename!} mime={mime} className={`${buttonClass({ variant: "secondary", size: "sm" })} shrink-0`}>
          Открыть
        </DocumentLink>
      ) : (
        <StatusBadge tone="danger" className="shrink-0">нет файла</StatusBadge>
      )}
    </div>
  );
}
