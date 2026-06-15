import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AccessContext } from "@/lib/access";
import { type Role, highestRole, isKnownRole } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/navigation";

// ---------------------------------------------------------------------------
// Human-readable labels for the existing audit action codes. We do NOT change
// audit storage — this only maps the stored `action` string to Russian text.
// ---------------------------------------------------------------------------

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  // Sales
  "sale.created": "Создана продажа",
  "sale.confirmed": "Подтверждена продажа",
  "sale.rejected": "Отклонена продажа",
  "sale.canceled": "Отменена продажа",
  // Sales plans
  "sales_plan.created": "Создан план продаж",
  "sales_plan.updated": "Обновлён план продаж",
  // Sales reports (сменные отчёты)
  "sales_report.created": "Создан сменный отчёт",
  "sales_report.verified": "Подтверждён сменный отчёт",
  "sales_report.confirmed": "Подтверждён сменный отчёт",
  "sales_report.unconfirmed": "Отменено подтверждение отчёта",
  "sales_report.confirm_blocked": "Подтверждение отчёта заблокировано проверкой",
  "sales_report.rejected": "Отклонён сменный отчёт",
  "sales_report.canceled": "Отменён сменный отчёт",
  "sales_report.comment_added": "Добавлен комментарий к отчёту",
  "sales_report.document_uploaded": "Загружен документ к отчёту",
  "sales_report.encashment_document_uploaded": "Загружен документ инкассации",
  "sales_report.manager_selected": "Выбран менеджер смены",
  // Club employees (сотрудники клубов — не системные пользователи)
  "employee.created": "Добавлен сотрудник",
  "employee.dismissed": "Сотрудник уволен",
  "employee.updated": "Обновлён сотрудник",
  // Legal entities
  "legal_entity.created": "Создано юрлицо",
  "legal_entity.updated": "Обновлено юрлицо",
  "legal_entity.activated": "Юрлицо активировано",
  "legal_entity.deactivated": "Юрлицо деактивировано",
  "legal_entity.attached": "Юрлицо привязано к клубу",
  "legal_entity.detached": "Юрлицо отвязано от клуба",
  // Invoices
  "invoice.uploaded": "Загружен счёт",
  "invoice.extracted": "Распознан счёт",
  "invoice.created": "Создан счёт",
  "invoice.updated": "Обновлён счёт",
  "invoice.sent_to_review": "Счёт отправлен на проверку",
  "invoice.approved": "Согласован счёт",
  "invoice.rejected": "Отклонён счёт",
  "invoice.paid": "Счёт оплачен",
  "invoice.canceled": "Отменён счёт",
  // Expenses
  "expense.uploaded": "Загружен расход",
  "expense.extracted": "Распознан расход",
  "expense.created": "Создан расход",
  "expense.updated": "Обновлён расход",
  // Excel imports (safety layer)
  "import.created": "Импорт завершён",
  "import.duplicate_file_blocked": "Импорт заблокирован (дубль файла)",
  "import.row_duplicate_skipped": "Пропущены дубли строк при импорте",
  "import.reverted": "Импорт отменён",
  "import.revert_failed": "Не удалось отменить импорт",
  "import.reverted_by_bulk_cancel": "Импорт отменён (массовая отмена расходов)",
  "import.reverted_by_expense_cancel": "Импорт отменён (отмена расхода)",
  // Payroll
  "payroll_statement.uploaded": "Загружена ведомость",
  "payroll_statement.extracted": "Распознана ведомость",
  "payroll_statement.created": "Создана ведомость",
  "payroll_statement.duplicate_rows_skipped": "Пропущены дубли в ведомости",
  // Refunds
  "refund.uploaded": "Загружен возврат",
  "refund.extracted": "Распознан возврат",
  "refund.created": "Создан возврат",
  "refund.updated": "Обновлён возврат",
  "refund.sent_to_review": "Возврат отправлен на проверку",
  "refund.approved": "Согласован возврат",
  "refund.rejected": "Отклонён возврат",
  "refund.paid": "Возврат оплачен",
  // Budgets
  "budget.created": "Создан лимит бюджета",
  "budget.updated": "Обновлён лимит бюджета",
  "budget_approval.created": "Запрошено согласование бюджета",
  "budget_approval.approved": "Одобрено превышение бюджета",
  "budget_approval.rejected": "Отклонено превышение бюджета",
  // Legacy budget workflow (historical rows)
  "budget.exceeded": "Превышен бюджет",
  "budget_request.created": "Создан запрос на превышение бюджета",
  "budget_request.approved": "Одобрен запрос на превышение бюджета",
  "budget_request.rejected": "Отклонён запрос на превышение бюджета",
  "budget_request.escalated": "Запрос на превышение бюджета эскалирован",
  // Users / access
  "role.invited": "Отправлено приглашение",
  "invite.accepted": "Приглашение принято",
  "access.granted": "Выдан доступ",
  "access.removed": "Удалён доступ",
  // Organisation
  "company.created": "Создана компания",
  "company.updated": "Обновлена компания",
  "club.created": "Создан клуб",
  "club.updated": "Обновлён клуб",
  "club.archived": "Клуб архивирован",
  "club.restored": "Клуб восстановлен",
  "onboarding.completed": "Завершён онбординг",
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

// Object (entity) label derived from the action prefix.
const OBJECT_BY_PREFIX: Record<string, string> = {
  sale: "Продажа",
  sales_plan: "План продаж",
  sales_report: "Сменный отчёт",
  employee: "Сотрудник",
  legal_entity: "Юрлицо",
  invoice: "Счёт",
  expense: "Расход",
  payroll_statement: "Ведомость",
  refund: "Возврат",
  budget: "Бюджет",
  budget_approval: "Бюджет",
  budget_request: "Бюджет",
  role: "Пользователь",
  invite: "Пользователь",
  access: "Доступ",
  company: "Компания",
  club: "Клуб",
  onboarding: "Онбординг",
};

export function auditObjectLabel(action: string): string {
  const prefix = action.split(".")[0];
  return OBJECT_BY_PREFIX[prefix] ?? "—";
}

export type AuditResultTone = "ok" | "reject" | "neutral";

export function auditResult(action: string): { label: string; tone: AuditResultTone } {
  if (action.endsWith(".rejected")) return { label: "Отклонено", tone: "reject" };
  if (action.endsWith(".canceled")) return { label: "Отменено", tone: "neutral" };
  return { label: "Успешно", tone: "ok" };
}

// ---------------------------------------------------------------------------
// Action-type filter categories. Each maps to one or more action prefixes.
// ---------------------------------------------------------------------------

export const ACTIVITY_TYPES = [
  { key: "all", label: "Все", prefixes: [] as string[] },
  { key: "sales", label: "Продажи", prefixes: ["sale", "sales_report"] },
  { key: "expenses", label: "Расходы", prefixes: ["expense", "payroll_statement"] },
  { key: "invoices", label: "Счета", prefixes: ["invoice"] },
  { key: "refunds", label: "Возвраты", prefixes: ["refund"] },
  { key: "budgets", label: "Бюджеты", prefixes: ["budget", "budget_approval", "budget_request"] },
  { key: "users", label: "Пользователи", prefixes: ["role", "invite", "access"] },
  { key: "plans", label: "Планы", prefixes: ["sales_plan"] },
] as const;

export type ActivityTypeKey = (typeof ACTIVITY_TYPES)[number]["key"];

export const ACTIVITY_RANGES = [
  { key: "today", label: "Сегодня" },
  { key: "week", label: "Неделя" },
  { key: "month", label: "Месяц" },
  { key: "custom", label: "Период" },
] as const;

export type ActivityRange = (typeof ACTIVITY_RANGES)[number]["key"] | "all";

export type ActivityFilters = {
  range: ActivityRange;
  from?: Date;
  to?: Date;
  userId?: string;
  clubId?: string;
  type?: ActivityTypeKey;
};

export const ACTIVITY_PAGE_SIZE = 50;

function typePrefixes(type: ActivityTypeKey | undefined): string[] {
  const found = ACTIVITY_TYPES.find((t) => t.key === type);
  return found ? [...found.prefixes] : [];
}

function dateRangeWhere(filters: ActivityFilters, now: Date): Prisma.DateTimeFilter | undefined {
  switch (filters.range) {
    case "today": {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { gte: start };
    }
    case "week":
      return { gte: new Date(now.getTime() - 7 * 86_400_000) };
    case "month":
      return { gte: new Date(now.getTime() - 30 * 86_400_000) };
    case "custom": {
      const f: Prisma.DateTimeFilter = {};
      if (filters.from) f.gte = filters.from;
      if (filters.to) f.lte = new Date(filters.to.getFullYear(), filters.to.getMonth(), filters.to.getDate(), 23, 59, 59, 999);
      return f.gte || f.lte ? f : undefined;
    }
    default:
      return undefined; // "all"
  }
}

/**
 * Build the AuditLog where clause for the viewer. Security-critical:
 *  - always pinned to the selected company (no cross-company leak),
 *  - club restricted to allowedClubIds for non-company-wide roles (no cross-club
 *    leak),
 *  - marketer / no company => null (no access).
 */
export function buildActivityWhere(
  ctx: AccessContext,
  filters: ActivityFilters,
  now: Date,
): Prisma.AuditLogWhereInput | null {
  const companyId = ctx.selectedCompanyId;
  if (!companyId) return null;
  const role = highestRole(ctx.effectiveRoles);
  if (!role || role === "marketer") return null;

  const and: Prisma.AuditLogWhereInput[] = [{ companyId }];

  // Role-based row scope.
  if (role === "owner" || role === "general_director") {
    // All company activity (every club + company-level events).
  } else if (role === "regional_director") {
    and.push({ clubId: { in: ctx.allowedClubIds } });
  } else if (role === "manager") {
    and.push({ OR: [{ clubId: { in: ctx.allowedClubIds } }, { userId: ctx.user.id }] });
  } else if (role === "accountant") {
    and.push({ OR: [{ clubId: { in: ctx.allowedClubIds } }, { clubId: null }, { userId: ctx.user.id }] });
  } else {
    and.push({ userId: ctx.user.id });
  }

  // Date range.
  const dateWhere = dateRangeWhere(filters, now);
  if (dateWhere) and.push({ createdAt: dateWhere });

  // By user.
  if (filters.userId) and.push({ userId: filters.userId });

  // By club — only honoured when within the viewer's allowed clubs.
  if (filters.clubId) {
    if (ctx.allowedClubIds.includes(filters.clubId)) and.push({ clubId: filters.clubId });
    else and.push({ id: "__no_such_row__" }); // invalid club selection -> empty result
  }

  // By action type (category).
  const prefixes = typePrefixes(filters.type);
  if (prefixes.length > 0) {
    and.push({ OR: prefixes.map((p) => ({ action: { startsWith: `${p}.` } })) });
  }

  return { AND: and };
}

export type ActivityRow = {
  id: string;
  createdAt: Date;
  userName: string;
  roleLabel: string;
  companyName: string;
  clubName: string;
  action: string;
  actionLabel: string;
  objectLabel: string;
  result: { label: string; tone: AuditResultTone };
};

/** Resolve actor names/roles + club names for a set of raw audit rows. */
async function enrichActivity(
  companyId: string,
  companyName: string,
  rows: Array<{ id: string; createdAt: Date; action: string; userId: string | null; clubId: string | null }>,
): Promise<ActivityRow[]> {
  const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
  const clubIds = [...new Set(rows.map((r) => r.clubId).filter((x): x is string => !!x))];

  const [users, clubs, companyAccess, clubAccess] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, role: true } })
      : Promise.resolve([]),
    clubIds.length
      ? prisma.club.findMany({ where: { id: { in: clubIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    userIds.length
      ? prisma.companyUserAccess.findMany({ where: { companyId, userId: { in: userIds } }, select: { userId: true, role: true } })
      : Promise.resolve([]),
    userIds.length
      ? prisma.clubUserAccess.findMany({ where: { userId: { in: userIds }, club: { companyId } }, select: { userId: true, role: true } })
      : Promise.resolve([]),
  ]);

  const userMap = new Map(users.map((u) => [u.id, u]));
  const clubMap = new Map(clubs.map((c) => [c.id, c.name]));
  const rolesByUser = new Map<string, Role[]>();
  for (const a of [...companyAccess, ...clubAccess]) {
    if (!isKnownRole(a.role)) continue;
    const arr = rolesByUser.get(a.userId) ?? [];
    arr.push(a.role as Role);
    rolesByUser.set(a.userId, arr);
  }

  return rows.map((r) => {
    const u = r.userId ? userMap.get(r.userId) : null;
    const scoped = r.userId ? rolesByUser.get(r.userId) : undefined;
    const best =
      scoped && scoped.length ? highestRole(scoped) : u && isKnownRole(u.role) ? (u.role as Role) : null;
    return {
      id: r.id,
      createdAt: r.createdAt,
      userName: u?.name ?? "Система",
      roleLabel: best ? ROLE_LABELS[best] ?? best : "—",
      companyName,
      clubName: r.clubId ? clubMap.get(r.clubId) ?? "—" : "—",
      action: r.action,
      actionLabel: auditActionLabel(r.action),
      objectLabel: auditObjectLabel(r.action),
      result: auditResult(r.action),
    };
  });
}

export type ActivityPage = {
  rows: ActivityRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

/** Paginated, scoped activity log (newest first). */
export async function getActivityLog(
  ctx: AccessContext,
  companyName: string,
  filters: ActivityFilters,
  page: number,
): Promise<ActivityPage> {
  const pageSize = ACTIVITY_PAGE_SIZE;
  const where = buildActivityWhere(ctx, filters, new Date());
  if (!where || !ctx.selectedCompanyId) {
    return { rows: [], total: 0, page: 1, pageSize, totalPages: 0 };
  }
  const [total, raw] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  const rows = await enrichActivity(ctx.selectedCompanyId, companyName, raw);
  return { rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Recent activity for the dashboard block (scoped, newest first). */
export async function getRecentActivity(
  ctx: AccessContext,
  companyName: string,
  limit = 5,
): Promise<ActivityRow[]> {
  const where = buildActivityWhere(ctx, { range: "all" }, new Date());
  if (!where || !ctx.selectedCompanyId) return [];
  const raw = await prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: limit });
  return enrichActivity(ctx.selectedCompanyId, companyName, raw);
}
