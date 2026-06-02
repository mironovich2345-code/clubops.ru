import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createHmac, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export type Role = "owner" | "regional_director" | "manager" | "accountant";

export type AppPage =
  | "dashboard"
  | "expenses"
  | "invoices"
  | "sales"
  | "imports"
  | "documents"
  | "users";

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
};

const ROLE_PAGE_ACCESS: Record<Role, ReadonlyArray<AppPage>> = {
  owner: ["dashboard", "expenses", "invoices", "sales", "imports", "documents", "users"],
  regional_director: ["dashboard", "expenses", "invoices", "sales", "imports", "documents"],
  manager: ["dashboard", "expenses", "sales", "documents"],
  accountant: ["expenses", "invoices", "documents"],
};

export function canAccessPage(role: Role, page: AppPage): boolean {
  return ROLE_PAGE_ACCESS[role].includes(page);
}

export function pagesForRole(role: Role): ReadonlyArray<AppPage> {
  return ROLE_PAGE_ACCESS[role];
}

export function landingPageForRole(role: Role): AppPage {
  return ROLE_PAGE_ACCESS[role][0];
}

function asRole(role: string): Role {
  return role in ROLE_PAGE_ACCESS ? (role as Role) : "manager";
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ---------------------------------------------------------------------------
// Sessions (DB-backed, httpOnly cookie holding a random token)
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "club_ops_session";
const SESSION_TTL_DAYS = 30;
// SESSION_SECRET keys the token HMAC: a leaked tokenHash can't be reversed into
// a usable cookie without the secret. Set it in production (see .env.example).
const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-session-secret";

function hashToken(token: string): string {
  return createHmac("sha256", SESSION_SECRET).update(token).digest("hex");
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt },
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  if (!session.user.isActive) return null;

  const u = session.user;
  return { id: u.id, email: u.email, name: u.name, role: asRole(u.role) };
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requirePageAccess(page: AppPage): Promise<CurrentUser> {
  const user = await requireUser();
  if (!canAccessPage(user.role, page)) {
    redirect(`/${landingPageForRole(user.role)}`);
  }
  return user;
}

export type AuthResult = { ok: boolean; error?: string };

export async function signIn(email: string, password: string): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user || !user.passwordHash) {
    return { ok: false, error: "Неверный email или пароль" };
  }
  if (!user.isActive) {
    return { ok: false, error: "Учётная запись отключена" };
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return { ok: false, error: "Неверный email или пароль" };
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await createSession(user.id);
  return { ok: true };
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    store.delete(SESSION_COOKIE);
  }
}
