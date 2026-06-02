import type { InvoiceStatus } from "@/lib/invoices";

type DisplayStatus = "unpaid" | "paid" | "rejected" | "overdue";

const LABELS: Record<DisplayStatus, string> = {
  unpaid: "Не оплачен",
  paid: "Оплачен",
  rejected: "Отклонён",
  overdue: "Просрочен",
};

const STYLES: Record<DisplayStatus, string> = {
  unpaid: "bg-amber-50 text-amber-700 ring-amber-200",
  paid: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  rejected: "bg-slate-100 text-slate-600 ring-slate-200",
  overdue: "bg-rose-50 text-rose-700 ring-rose-200",
};

export function effectiveStatus(
  status: InvoiceStatus,
  dueDate: Date,
  now: number = Date.now(),
): DisplayStatus {
  if (status === "paid" || status === "rejected") return status;
  if (status === "overdue") return "overdue";
  return dueDate.getTime() < now ? "overdue" : "unpaid";
}

export function StatusBadge({
  status,
  dueDate,
}: {
  status: InvoiceStatus;
  dueDate: Date;
}) {
  const display = effectiveStatus(status, dueDate);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STYLES[display]}`}
    >
      {LABELS[display]}
    </span>
  );
}
