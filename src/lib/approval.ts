import type { Role } from "@/lib/auth";

// Shared approval workflow: draft -> needs_review -> approved_by_regional/owner
// -> paid (or rejected). Role rules: manager sends; regional director approves/
// rejects; accountant (or owner) pays; owner can approve/reject/pay.

export type ApprovalStatus =
  | "draft"
  | "needs_review"
  | "approved_by_regional"
  | "approved_by_chief_accountant"
  | "approved_by_owner" // legacy — kept readable/payable, never produced by new actions
  | "paid"
  | "rejected";

export const APPROVAL_STATUSES: ApprovalStatus[] = [
  "draft",
  "needs_review",
  "approved_by_regional",
  "approved_by_chief_accountant",
  "approved_by_owner",
  "paid",
  "rejected",
];

export const APPROVAL_STATUS_LABELS: Record<string, string> = {
  draft: "Черновик",
  needs_review: "На согласовании",
  approved_by_regional: "Согласовано регионалом",
  approved_by_chief_accountant: "Согласовано главным бухгалтером",
  approved_by_owner: "Согласовано собственником",
  paid: "Оплачено",
  rejected: "Отклонено",
};

// Approver-routing denial messages (duplicated as plain strings so this pure,
// client-importable module never pulls in server-only access helpers).
const APPROVAL_REGIONAL_ONLY_MSG = "Согласование доступно региональному директору этого клуба";
const APPROVAL_FALLBACK_CHIEF_MSG =
  "Согласование может выполнить главный бухгалтер, так как региональный директор не назначен";

/** Resolved by the caller before applying an action: whether an ACTIVE regional
 * approver exists for the club, and whether the actor created the record. */
export type ApprovalContext = { hasActiveRegional: boolean; isCreator: boolean };

export type ApprovalAction = "send_to_review" | "approve" | "reject" | "pay";

export const APPROVAL_ACTION_LABELS: Record<ApprovalAction, string> = {
  send_to_review: "Отправить на согласование",
  approve: "Согласовать",
  reject: "Отклонить",
  pay: "Отметить оплачено",
};

type TransitionResult = { ok: true; to: ApprovalStatus } | { ok: false; error: string };

function has(roles: readonly Role[], role: Role): boolean {
  return roles.includes(role);
}

const APPROVAL_REJECTABLE = ["needs_review", "approved_by_regional", "approved_by_chief_accountant", "approved_by_owner"];
// Canonical "approved, awaiting payment" set — the single source of truth for
// invoice/refund statuses that are committed obligations but not yet paid.
// MUST include approved_by_chief_accountant (the chief-accountant fallback
// approver when a club has no active regional director). Reused by budget
// "used" totals and dashboard debt/cash-gap so they never undercount.
export const APPROVED_UNPAID_STATUSES = ["approved_by_regional", "approved_by_chief_accountant", "approved_by_owner"];
const APPROVAL_PAYABLE = APPROVED_UNPAID_STATUSES;

/**
 * Pure decision table. Approval routes by club: an ACTIVE regional approver
 * (opts.hasActiveRegional) approves/rejects; otherwise the chief accountant does
 * as fallback. The creator may never approve their own record. Owner / GD are
 * strategic (read-only) and take NO action.
 */
export function applyApprovalAction(
  action: ApprovalAction,
  status: string,
  roles: readonly Role[],
  opts: ApprovalContext,
): TransitionResult {
  const isRegional = has(roles, "regional_director");
  const isChief = has(roles, "chief_accountant");
  const isAccountant = has(roles, "accountant"); // chief inherits accountant
  const isManager = has(roles, "manager");

  switch (action) {
    case "send_to_review":
      if (status !== "draft") return { ok: false, error: "Отправить на согласование можно только черновик" };
      if (!(isManager || isRegional)) return { ok: false, error: "Недостаточно прав" };
      return { ok: true, to: "needs_review" };

    case "approve": {
      if (status !== "needs_review") return { ok: false, error: "Согласовать можно документ на согласовании" };
      if (opts.isCreator) return { ok: false, error: "Нельзя согласовать собственный возврат" };
      if (opts.hasActiveRegional) {
        if (isRegional) return { ok: true, to: "approved_by_regional" };
        return { ok: false, error: APPROVAL_REGIONAL_ONLY_MSG };
      }
      if (isChief) return { ok: true, to: "approved_by_chief_accountant" };
      return { ok: false, error: APPROVAL_FALLBACK_CHIEF_MSG };
    }

    case "reject": {
      if (!APPROVAL_REJECTABLE.includes(status)) return { ok: false, error: "Отклонить можно документ на согласовании" };
      if (opts.hasActiveRegional) {
        if (isRegional) return { ok: true, to: "rejected" };
        return { ok: false, error: APPROVAL_REGIONAL_ONLY_MSG };
      }
      if (isChief) return { ok: true, to: "rejected" };
      return { ok: false, error: APPROVAL_FALLBACK_CHIEF_MSG };
    }

    case "pay":
      // Accountant / chief accountant only; owner is strategic (read-only).
      if (!isAccountant) return { ok: false, error: "Недостаточно прав для отметки об оплате" };
      if (APPROVAL_PAYABLE.includes(status)) return { ok: true, to: "paid" };
      return { ok: false, error: "Оплатить можно только согласованный документ" };
  }
}

/** Actions the actor can currently perform — drives which buttons are shown. */
export function availableApprovalActions(status: string, roles: readonly Role[], opts: ApprovalContext): ApprovalAction[] {
  return (Object.keys(APPROVAL_ACTION_LABELS) as ApprovalAction[]).filter(
    (action) => applyApprovalAction(action, status, roles, opts).ok,
  );
}

/** Paid documents are locked except for the accountant (chief inherits it).
 * Owner is strategic (read-only); the updateRefund action additionally blocks all
 * strategic roles. */
export function canEditApproval(status: string, roles: readonly Role[]): boolean {
  if (status !== "paid") return true;
  return has(roles, "accountant");
}
