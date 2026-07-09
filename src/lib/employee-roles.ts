// Pure helpers for general_director manager↔regional_director conversions.
// No server imports — reused by the role-change server actions and mirrored by
// the pilot. The DB transaction lives in the action; this only classifies role
// state and centralizes the eligibility rules + messages.

// Roles that make a user ineligible for a manager↔regional conversion (they are
// not operational line roles a GD reassigns this way).
export const CONVERSION_BLOCKING_ROLES = [
  "owner", "general_director", "accountant", "chief_accountant",
] as const;

export type RoleShape = "manager" | "regional" | "mixed" | "other" | "none";

/**
 * Classify a user's effective roles WITHIN one company for a role conversion.
 * `systemAdmin` (a global User.systemRole) blocks unconditionally.
 *  - "manager"  → only manager access (promotable)
 *  - "regional" → only regional_director access (demotable)
 *  - "mixed"    → both manager and regional in the same company (block, never
 *                 silently normalize)
 *  - "other"    → holds a blocking role / unknown state (block)
 *  - "none"     → no access in this company (block)
 */
export function classifyRoleShape(roles: readonly string[], systemAdmin: boolean): RoleShape {
  if (systemAdmin) return "other";
  const set = new Set(roles);
  if (set.size === 0) return "none";
  if ((CONVERSION_BLOCKING_ROLES as readonly string[]).some((r) => set.has(r))) return "other";
  const hasManager = set.has("manager");
  const hasRegional = set.has("regional_director");
  if (hasManager && hasRegional) return "mixed";
  if (hasRegional) return "regional";
  if (hasManager) return "manager";
  return "other";
}

export type Eligibility = { ok: true } | { ok: false; error: string };

/** Can this user be PROMOTED manager → regional_director? */
export function canPromoteToRegional(shape: RoleShape): Eligibility {
  switch (shape) {
    case "manager": return { ok: true };
    case "regional": return { ok: false, error: "Сотрудник уже является региональным директором." };
    case "mixed": return { ok: false, error: "У сотрудника противоречивые роли. Обратитесь к администратору." };
    case "none": return { ok: false, error: "Сотрудник не входит в вашу организацию." };
    default: return { ok: false, error: "Эту роль нельзя повысить." };
  }
}

/** Can this user be DEMOTED regional_director → manager? */
export function canDemoteToManager(shape: RoleShape): Eligibility {
  switch (shape) {
    case "regional": return { ok: true };
    case "manager": return { ok: false, error: "Сотрудник уже является управляющим." };
    case "mixed": return { ok: false, error: "У сотрудника противоречивые роли. Обратитесь к администратору." };
    case "none": return { ok: false, error: "Сотрудник не входит в вашу организацию." };
    default: return { ok: false, error: "Эту роль нельзя понизить." };
  }
}

/** Validate the selected club ids for a PROMOTION (>=1, deduped). */
export function normalizeSelectedClubIds(raw: string[]): string[] {
  return [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
}
