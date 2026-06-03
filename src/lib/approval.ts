import type { Role } from "@/lib/auth";

// Shared approval workflow: draft -> needs_review -> approved_by_regional/owner
// -> paid (or rejected). Role rules: manager sends; regional director approves/
// rejects; accountant (or owner) pays; owner can approve/reject/pay.

export type ApprovalStatus =
  | "draft"
  | "needs_review"
  | "approved_by_regional"
  | "approved_by_owner"
  | "paid"
  | "rejected";

export const APPROVAL_STATUSES: ApprovalStatus[] = [
  "draft",
  "needs_review",
  "approved_by_regional",
  "approved_by_owner",
  "paid",
  "rejected",
];

export const APPROVAL_STATUS_LABELS: Record<string, string> = {
  draft: "Черновик",
  needs_review: "На согласовании",
  approved_by_regional: "Согласовано регионалом",
  approved_by_owner: "Согласовано собственником",
  paid: "Оплачено",
  rejected: "Отклонено",
};

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

/** Pure decision table — the single source of truth for who may do what. */
export function applyApprovalAction(
  action: ApprovalAction,
  status: string,
  roles: readonly Role[],
): TransitionResult {
  const isOwner = has(roles, "owner");
  const isRegional = has(roles, "regional_director");
  const isAccountant = has(roles, "accountant");
  const isManager = has(roles, "manager");

  switch (action) {
    case "send_to_review":
      if (status !== "draft") return { ok: false, error: "Отправить на согласование можно только черновик" };
      if (!(isManager || isRegional || isOwner)) return { ok: false, error: "Недостаточно прав" };
      return { ok: true, to: "needs_review" };

    case "approve":
      if (!(isRegional || isOwner)) return { ok: false, error: "Недостаточно прав для согласования" };
      if (isOwner) {
        if (status === "needs_review" || status === "approved_by_regional") {
          return { ok: true, to: "approved_by_owner" };
        }
        return { ok: false, error: "Согласовать можно документ на согласовании" };
      }
      if (status === "needs_review") return { ok: true, to: "approved_by_regional" };
      return { ok: false, error: "Согласовать можно документ на согласовании" };

    case "reject":
      if (!(isRegional || isOwner)) return { ok: false, error: "Недостаточно прав для отклонения" };
      if (status === "needs_review" || status === "approved_by_regional") {
        return { ok: true, to: "rejected" };
      }
      return { ok: false, error: "Отклонить можно документ на согласовании" };

    case "pay":
      if (!(isAccountant || isOwner)) return { ok: false, error: "Недостаточно прав для отметки об оплате" };
      if (status === "approved_by_regional" || status === "approved_by_owner") {
        return { ok: true, to: "paid" };
      }
      return { ok: false, error: "Оплатить можно только согласованный документ" };
  }
}

/** Actions the actor can currently perform — drives which buttons are shown. */
export function availableApprovalActions(status: string, roles: readonly Role[]): ApprovalAction[] {
  return (Object.keys(APPROVAL_ACTION_LABELS) as ApprovalAction[]).filter(
    (action) => applyApprovalAction(action, status, roles).ok,
  );
}

/** Paid documents are locked except for owner/accountant. */
export function canEditApproval(status: string, roles: readonly Role[]): boolean {
  if (status !== "paid") return true;
  return has(roles, "owner") || has(roles, "accountant");
}
