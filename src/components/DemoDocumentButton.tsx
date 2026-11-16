"use client";
import { useActionState } from "react";
import { fillDemoDocuments } from "@/app/demo/actions";

export function DemoDocumentButton({ kind, id }: { kind: "expense" | "refund"; id: string }) {
  const [state, action, pending] = useActionState(fillDemoDocuments, undefined);
  return <form action={action} className="my-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
    <p className="mb-2">Используйте вымышленный PDF{kind === "refund" ? " и нулевые тестовые реквизиты" : ""}. Реальные документы и банковские данные загружать не нужно.</p>
    <input type="hidden" name="kind" value={kind} /><input type="hidden" name="id" value={id} />
    <button disabled={pending} className="rounded border bg-white px-3 py-2">{pending ? "Подготовка…" : "Заполнить синтетический комплект"}</button>
    {state?.error && <p role="alert" className="mt-2 text-red-700">{state.error}</p>}
    {state?.ok && <p role="status" className="mt-2">Синтетический комплект готов</p>}
  </form>;
}
