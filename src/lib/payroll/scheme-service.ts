// STAGE 12: server-side creation of VERSIONED pay-scheme rows. Two entry points share
// one safe committing helper:
//   createCommittedVersion  — a new committed (active/scheduled) version in a logical key,
//                             closing the previously-open interval (append-only; the old
//                             row's params are never touched — only its effectiveTo/status)
//   materializeApprovedSchemeChange — idempotently turn an approved future_scheme_change
//                             PayrollChangeRequest into ONE real new version (the STAGE 12
//                             main goal). Repeat calls return the existing version.
import type { Prisma, PrismaClient, EmployeePayScheme } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validateSchemeParams } from "@/lib/payroll/scheme";
import { applyOverridesToParams, type ChangeFieldType } from "@/lib/payroll/change-request";
import { nextVersion, categoryOfPosition, committedStatusFor, logicalSchemeKey } from "@/lib/payroll/scheme-version";

type Db = PrismaClient | Prisma.TransactionClient;

export type VersionScope = {
  companyId: string;
  clubId: string;
  employeeId: string | null;
  position: string | null;
};

/**
 * Append a COMMITTED version (active or scheduled by date) to a logical key and close the
 * previously-open interval at the new boundary. Append-forward only: the new effectiveFrom
 * must be strictly later than every existing version in the key (never rewrites history or
 * a used snapshot). Returns the created row. Runs inside the caller's transaction.
 */
export async function createCommittedVersion(
  db: Db,
  args: {
    scope: VersionScope;
    schemeType: string;
    params: Record<string, unknown>;
    effectiveFrom: Date;
    at: Date; // reference instant (usually now) to decide scheduled vs active
    approvedById: string;
    createdByUserId: string;
    sourceChangeRequestId?: string | null;
    comment?: string | null;
  },
): Promise<EmployeePayScheme> {
  const { scope, schemeType, params, effectiveFrom, at } = args;
  const existing = await db.employeePayScheme.findMany({
    where: { companyId: scope.companyId, clubId: scope.clubId, employeeId: scope.employeeId, position: scope.position },
    orderBy: [{ effectiveFrom: "desc" }],
  });
  // Append-forward guard: never insert into or before existing history.
  const latest = existing.reduce<number>((max, s) => Math.max(max, s.effectiveFrom.getTime()), -Infinity);
  if (existing.length > 0 && effectiveFrom.getTime() <= latest) {
    throw new Error("Новая версия должна вступать в силу позже всех существующих (история не перезаписывается).");
  }
  // Close the previously-open committed interval at the new boundary (supersede).
  const openPrev = existing.find((s) => s.effectiveTo == null && ["active", "scheduled", "approved"].includes(s.status));
  if (openPrev) {
    await db.employeePayScheme.update({
      where: { id: openPrev.id },
      data: { effectiveTo: effectiveFrom, status: "superseded" },
    });
  }
  const version = nextVersion(existing);
  const status = committedStatusFor(effectiveFrom, at);
  return db.employeePayScheme.create({
    data: {
      companyId: scope.companyId,
      clubId: scope.clubId,
      employeeId: scope.employeeId,
      position: scope.position,
      payrollCategory: categoryOfPosition(scope.position),
      schemeType,
      paramsJson: JSON.stringify(params),
      effectiveFrom,
      effectiveTo: null,
      version,
      status,
      supersedesSchemeId: openPrev?.id ?? null,
      sourceChangeRequestId: args.sourceChangeRequestId ?? null,
      approvedById: args.approvedById,
      approvedAt: at,
      activatedAt: status === "active" ? at : null,
      comment: args.comment ?? null,
      createdByUserId: args.createdByUserId,
    },
  });
}

export type MaterializeResult =
  | { ok: true; scheme: EmployeePayScheme; alreadyExisted: boolean }
  | { ok: false; error: string };

/**
 * Materialise an approved future_scheme_change (spec §8). IDEMPOTENT: the version carries
 * `sourceChangeRequestId @unique`, so a repeat call returns the existing version and never
 * creates a duplicate. The proposed value is merged onto the calc's base snapshot params
 * (same override maths as apply) and stamped as an EMPLOYEE-SPECIFIC version — the shared
 * category scheme and all past snapshots stay untouched. On failure the request is NOT
 * marked applied (safe retry).
 */
export async function materializeApprovedSchemeChange(
  requestId: string,
  actorUserId: string,
  at: Date,
): Promise<MaterializeResult> {
  const req = await prisma.payrollChangeRequest.findUnique({ where: { id: requestId } });
  if (!req) return { ok: false, error: "Заявка не найдена" };
  if (req.requestType !== "future_scheme_change") return { ok: false, error: "Заявка не является изменением схемы с будущей даты" };
  if (!["approved_pending_scheme_creation", "approved"].includes(req.status) && req.status !== "applied") {
    return { ok: false, error: "Заявку нельзя материализовать в текущем статусе" };
  }
  if (!req.effectiveFrom) return { ok: false, error: "Не указана дата вступления в силу" };
  if (!req.targetField) return { ok: false, error: "Не указано изменяемое поле" };

  // Idempotency: return the existing version if this request already materialised.
  const existingVersion = await prisma.employeePayScheme.findUnique({ where: { sourceChangeRequestId: requestId } });
  if (existingVersion) {
    if (req.status !== "applied") await prisma.payrollChangeRequest.update({ where: { id: requestId }, data: { status: "applied", appliedAt: at, appliedById: actorUserId } }).catch(() => {});
    return { ok: true, scheme: existingVersion, alreadyExisted: true };
  }
  if (req.status === "applied") return { ok: false, error: "Заявка помечена применённой, но версия схемы не найдена — обратитесь к администратору." };

  const calc = req.payrollCalculationId ? await prisma.payrollCalculation.findUnique({ where: { id: req.payrollCalculationId } }) : null;
  if (!calc || !calc.schemeSnapshotJson) return { ok: false, error: "Базовый расчёт/снимок схемы не найден" };
  let snap: { schemeType?: string; params?: Record<string, unknown> };
  try {
    snap = JSON.parse(calc.schemeSnapshotJson);
  } catch {
    return { ok: false, error: "Снимок схемы повреждён" };
  }
  if (!snap.schemeType) return { ok: false, error: "В снимке нет типа схемы" };

  let proposedValue: unknown;
  try {
    proposedValue = JSON.parse(req.proposedValueJson);
  } catch {
    return { ok: false, error: "Некорректное предложенное значение" };
  }
  const merged = applyOverridesToParams(snap.schemeType, snap.params ?? {}, [
    { requestId, targetField: req.targetField, fieldType: req.fieldType as ChangeFieldType, value: proposedValue, appliedAt: at.toISOString() },
  ]);
  if (!merged.ok) return { ok: false, error: merged.error };
  const params = (merged.scheme as { params: Record<string, unknown> }).params;
  // Final structural/bounds re-validation.
  const revalidate = validateSchemeParams(snap.schemeType, params);
  if (!revalidate.ok) return { ok: false, error: revalidate.error };

  // STAGE 13 (§21): scope decides employee-specific vs category-level version. A
  // payroll_category request materialises a version with employeeId=null for the whole
  // category of the club; employee-specific versions still take priority in the resolver.
  const categoryScope = req.schemeScope === "payroll_category";
  const scope = {
    companyId: req.companyId,
    clubId: req.clubId,
    employeeId: categoryScope ? null : req.employeeId,
    position: calc.roleSnapshot,
  };

  try {
    const scheme = await prisma.$transaction(async (tx) => {
      const created = await createCommittedVersion(tx, {
        scope,
        schemeType: snap.schemeType!,
        params,
        effectiveFrom: req.effectiveFrom!,
        at,
        approvedById: req.reviewedById ?? actorUserId,
        createdByUserId: req.requestedById,
        sourceChangeRequestId: requestId,
        comment: `Материализовано из заявки ${requestId}: ${req.reason}`,
      });
      await tx.payrollChangeRequest.update({ where: { id: requestId }, data: { status: "applied", appliedAt: at, appliedById: actorUserId, payrollSchemeId: created.id } });
      return created;
    });
    return { ok: true, scheme, alreadyExisted: false };
  } catch (e) {
    // Unique race → someone else materialised concurrently: return theirs.
    const raced = await prisma.employeePayScheme.findUnique({ where: { sourceChangeRequestId: requestId } });
    if (raced) return { ok: true, scheme: raced, alreadyExisted: true };
    return { ok: false, error: `Не удалось создать версию схемы: ${(e as Error).message}` };
  }
}
