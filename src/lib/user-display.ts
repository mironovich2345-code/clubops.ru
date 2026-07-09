// Centralized historical user-name display. ONE rule reused across financial,
// approval, payment, audit and user-history views. A deleted (tombstoned) user
// is shown as a fixed, non-identifying label — NEVER their former name, email or
// the technical tombstone email — so account deletion actually removes the
// person's identity from every historical view while the record stays linked.
export const DELETED_ACCOUNT_LABEL = "Удалённый пользователь";

export type DisplayUser = {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  deletedAt?: Date | null;
} | null | undefined;

function baseName(user: NonNullable<DisplayUser>): string {
  if (user.name && user.name.trim()) return user.name.trim();
  const composed = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  if (composed) return composed;
  return "Пользователь";
}

/** Human display name. A tombstoned user always shows «Удалённый пользователь»
 * (identity hidden); active users show their name as before. */
export function formatUserDisplayName(user: DisplayUser): string {
  if (!user) return "Неизвестный пользователь";
  if (user.deletedAt) return DELETED_ACCOUNT_LABEL;
  return baseName(user);
}
