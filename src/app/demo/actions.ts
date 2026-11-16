"use server";
import { revalidatePath } from "next/cache";
import { prepareDemoDocuments } from "@/lib/demo/documents";

export async function fillDemoDocuments(_prev: { ok: boolean; error?: string } | undefined, data: FormData) {
  const kind = String(data.get("kind") ?? "");
  const id = String(data.get("id") ?? "");
  const result = await prepareDemoDocuments(kind, id);
  if (result.ok) {
    revalidatePath(`/expenses/${id}`);
    revalidatePath(`/refunds/new/${id}`);
    revalidatePath(`/refunds/new/${id}/details`);
  }
  return result;
}
