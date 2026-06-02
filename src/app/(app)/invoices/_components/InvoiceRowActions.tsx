import type { InvoiceStatus } from "@/lib/invoices";
import { setInvoiceStatus } from "../actions";

const BTN_BASE =
  "inline-flex items-center justify-center rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

export function InvoiceRowActions({
  invoiceId,
  status,
}: {
  invoiceId: string;
  status: InvoiceStatus;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusForm
        invoiceId={invoiceId}
        target="paid"
        disabled={status === "paid"}
        label="Оплачено"
        className="border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
      />
      <StatusForm
        invoiceId={invoiceId}
        target="rejected"
        disabled={status === "rejected"}
        label="Отклонить"
        className="border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
      />
      <StatusForm
        invoiceId={invoiceId}
        target="unpaid"
        disabled={status === "unpaid"}
        label="Вернуть в неоплачено"
        className="border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
      />
    </div>
  );
}

function StatusForm({
  invoiceId,
  target,
  label,
  disabled,
  className,
}: {
  invoiceId: string;
  target: InvoiceStatus;
  label: string;
  disabled?: boolean;
  className: string;
}) {
  const action = setInvoiceStatus.bind(null, invoiceId, target);
  return (
    <form action={action}>
      <button type="submit" disabled={disabled} className={`${BTN_BASE} ${className}`}>
        {label}
      </button>
    </form>
  );
}
