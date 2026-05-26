import { redirect } from "next/navigation";

export type Role = "owner" | "regional_director" | "manager" | "accountant";

export type AppPage =
  | "dashboard"
  | "expenses"
  | "invoices"
  | "sales"
  | "documents"
  | "users";

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
};

const ROLE_PAGE_ACCESS: Record<Role, ReadonlyArray<AppPage>> = {
  owner: ["dashboard", "expenses", "invoices", "sales", "documents", "users"],
  regional_director: ["dashboard", "expenses", "invoices", "sales", "documents"],
  manager: ["dashboard", "expenses", "sales", "documents"],
  accountant: ["expenses", "invoices", "documents"],
};

export function canAccessPage(role: Role, page: AppPage): boolean {
  return ROLE_PAGE_ACCESS[role].includes(page);
}

export function pagesForRole(role: Role): ReadonlyArray<AppPage> {
  return ROLE_PAGE_ACCESS[role];
}

/**
 * Replace this with real session lookup (NextAuth, Clerk, custom JWT, etc.)
 * once auth is wired up. The rest of the app only depends on this function.
 */
export async function getCurrentUser(): Promise<CurrentUser> {
  return {
    id: "mock-owner",
    email: "owner@club.local",
    name: "Владелец",
    role: "owner",
  };
}

export function landingPageForRole(role: Role): AppPage {
  return ROLE_PAGE_ACCESS[role][0];
}

export async function requirePageAccess(page: AppPage): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!canAccessPage(user.role, page)) {
    redirect(`/${landingPageForRole(user.role)}`);
  }
  return user;
}
