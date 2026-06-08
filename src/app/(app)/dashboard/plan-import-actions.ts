"use server";

import * as XLSX from "xlsx";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canManageSalesPlans } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { getCurrentAccessContext, getCurrentCompanyAndClub, getClubsInScope, recordAudit } from "@/lib/access";
import { PLAN_TYPES } from "@/lib/sales-plans";
import { isUploadedFile } from "@/lib/uploaded-file";

export type ImportError = { row: number; club: string; issue: string };
export type ImportResult = {
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  errors: ImportError[];
};
export type ImportState = { ok: boolean; error?: string; result?: ImportResult };

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

function parseMonthCell(cell: unknown): string | null {
  if (cell == null || cell === "") return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (cell instanceof Date) return `${cell.getFullYear()}-${pad(cell.getMonth() + 1)}`;
  if (typeof cell === "number") {
    const d = new Date(Date.UTC(1899, 11, 30) + cell * 86_400_000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  }
  const s = String(cell).trim();
  return /^\d{4}-\d{2}$/.test(s) ? s : null;
}

/** {empty} | {value} | {error} for a plan amount cell. */
function parseAmountCell(cell: unknown): { empty?: true; value?: number; error?: true } {
  if (cell == null || String(cell).trim() === "") return { empty: true };
  const n = typeof cell === "number" ? cell : Number(String(cell).replace(",", ".").replace(/\s/g, ""));
  if (!Number.isFinite(n) || n < 0) return { error: true };
  return { value: n };
}

export async function importSalesPlans(_prev: ImportState | undefined, formData: FormData): Promise<ImportState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа" };
  if (!canManageSalesPlans(ctx.effectiveRoles)) {
    return { ok: false, error: "Загружать планы может только Ген.директор" };
  }
  const companyId = ctx.selectedCompanyId;

  const fileEntry = formData.get("file");
  if (!isUploadedFile(fileEntry) || fileEntry.size === 0) return { ok: false, error: "Выберите файл (.xlsx, .xls или .csv)" };

  let rows: unknown[][];
  try {
    const buf = Buffer.from(await fileEntry.arrayBuffer());
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, blankrows: false });
  } catch {
    return { ok: false, error: "Не удалось прочитать файл. Поддерживаются .xlsx, .xls, .csv" };
  }

  const scope = await getCurrentCompanyAndClub(ctx.user);
  const clubs = await getClubsInScope(scope); // scope-restricted clubs (no cross-club)
  const byName = new Map<string, { id: string; name: string; city: string }>();
  for (const c of clubs) byName.set(norm(c.name), c);

  const result: ImportResult = { processed: 0, created: 0, updated: 0, skipped: 0, errors: [] };
  const seen = new Set<string>(); // clubId|month within this file

  // Row 0 is the header.
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (row.every((c) => c == null || String(c).trim() === "")) continue;
    result.processed++;
    const rowNo = i + 1;
    const cityCell = row[0];
    const nameCell = row[1];
    const clubLabel = `${String(nameCell ?? "").trim()} (${String(cityCell ?? "").trim()})`;

    const club = byName.get(norm(nameCell));
    if (!club) {
      result.errors.push({ row: rowNo, club: clubLabel, issue: "Клуб не найден в доступной компании" });
      continue;
    }
    if (norm(cityCell) !== norm(club.city)) {
      result.errors.push({ row: rowNo, club: clubLabel, issue: "Город не совпадает с клубом" });
      continue;
    }
    const month = parseMonthCell(row[2]);
    if (!month) {
      result.errors.push({ row: rowNo, club: clubLabel, issue: "Неверный формат месяца (нужно ГГГГ-ММ)" });
      continue;
    }
    const dupKey = `${club.id}|${month}`;
    if (seen.has(dupKey)) {
      result.errors.push({ row: rowNo, club: clubLabel, issue: "Дубликат строки (клуб + месяц)" });
      continue;
    }

    const amounts = PLAN_TYPES.map((t, idx) => ({ type: t.key, parsed: parseAmountCell(row[3 + idx]) }));
    const badAmount = amounts.find((a) => a.parsed.error);
    if (badAmount) {
      result.errors.push({ row: rowNo, club: clubLabel, issue: "Сумма должна быть неотрицательным числом" });
      continue;
    }

    // Row is valid — apply each non-empty plan type.
    seen.add(dupKey);
    for (const a of amounts) {
      if (a.parsed.empty) {
        result.skipped++;
        continue;
      }
      const targetAmountKopeks = rublesToKopeks(a.parsed.value!);
      const existing = await prisma.salesPlan.findFirst({
        where: { companyId, clubId: club.id, month, planType: a.type },
        select: { id: true },
      });
      if (existing) {
        await prisma.salesPlan.update({ where: { id: existing.id }, data: { targetAmountKopeks } });
        result.updated++;
      } else {
        await prisma.salesPlan.create({
          data: { companyId, clubId: club.id, month, planType: a.type, targetAmountKopeks, createdByUserId: ctx.user.id },
        });
        result.created++;
      }
    }
  }

  await recordAudit({
    action: "sales_plan.imported",
    entityType: "SalesPlan",
    companyId,
    userId: ctx.user.id,
    metadata: {
      processed: result.processed,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      errors: result.errors.length,
    },
  });

  revalidatePath("/dashboard");
  return { ok: true, result };
}
