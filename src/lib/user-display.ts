// Centralized historical user-name display (Part 5). ONE rule reused across
// financial, approval, payment, audit and user-history views so a deleted user's
// former name still shows with a clear marker — the email never replaces the
// name in ordinary historical views. firstName/lastName are preserved on
// deletion, so a deleted user keeps a human name.
export const DELETED_ACCOUNT_SUFFIX = "аккаунт удалён";

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

/** Human display name; appends "— аккаунт удалён" for tombstoned users. */
export function formatUserDisplayName(user: DisplayUser): string {
  if (!user) return "Неизвестный пользователь";
  const name = baseName(user);
  return user.deletedAt ? `${name} — ${DELETED_ACCOUNT_SUFFIX}` : name;
}
