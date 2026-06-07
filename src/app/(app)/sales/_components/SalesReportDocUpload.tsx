"use client";

import { useFormStatus } from "react-dom";
import { uploadSalesReportDocuments } from "../report-actions";
import { REPORT_ACCEPT_ATTR } from "@/lib/sales-report-rows";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Загрузка..." : "Загрузить"}
    </button>
  );
}

export function SalesReportDocUpload({ reportId }: { reportId: string }) {
  return (
    <form action={uploadSalesReportDocuments} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="reportId" value={reportId} />
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Документы (фото, PDF, Excel, CSV)</span>
        <input
          type="file"
          name="files"
          multiple
          accept={REPORT_ACCEPT_ATTR}
          className="input file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1 file:text-sm file:text-slate-700"
        />
      </label>
      <Submit />
    </form>
  );
}
