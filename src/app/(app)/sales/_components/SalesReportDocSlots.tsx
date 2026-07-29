"use client";

import { useFormStatus } from "react-dom";
import { uploadSalesReportDocSlots } from "../report-actions";
import { MobileFileField } from "@/components/mobile/MobileFileField";
import { REPORT_ACCEPT_ATTR } from "@/lib/sales-report-rows";

// Labeled upload slots shown on the report detail page (one input per type).
const SLOTS: ReadonlyArray<{ type: string; label: string }> = [
  { type: "ooo_report", label: "Отчёт ООО" },
  { type: "ip_report", label: "Отчёт ИП" },
  { type: "encashment", label: "Инкассация" },
  { type: "withdrawal", label: "Изъятие" },
  { type: "other", label: "Другое" },
];

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Загрузка..." : "Загрузить документы"}
    </button>
  );
}

export function SalesReportDocSlots({ reportId }: { reportId: string }) {
  return (
    <form action={uploadSalesReportDocSlots} className="space-y-3">
      <input type="hidden" name="reportId" value={reportId} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SLOTS.map((slot) => (
          <div key={slot.type} className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">{slot.label}</span>
            <MobileFileField name={`file_${slot.type}`} accept={REPORT_ACCEPT_ATTR} maxFiles={slot.type === "other" ? 5 : 1} />
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500">Прикрепите файлы к нужным слотам и нажмите «Загрузить документы». Можно загружать по одному типу за раз.</p>
      <Submit />
    </form>
  );
}
