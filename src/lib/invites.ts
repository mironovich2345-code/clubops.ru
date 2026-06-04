import { randomBytes } from "node:crypto";
import { hashToken } from "@/lib/auth";

export const INVITE_TTL_DAYS = 7;

/** Creates a raw token (shown once) and its stored hash. */
export function generateInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

export function hashInviteToken(token: string): string {
  return hashToken(token);
}

export function inviteExpiry(): Date {
  return new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function isInviteExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() < Date.now();
}

// Roles assigned at club level (manager). Everything else is company level.
export function isClubScopedRole(role: string): boolean {
  return role === "manager";
}

export const INVITE_ROLE_LABELS: Record<string, string> = {
  owner: "Собственник",
  general_director: "Ген.директор",
  regional_director: "Региональный директор",
  manager: "Управляющий",
  accountant: "Бухгалтер",
  marketer: "Маркетолог",
};
