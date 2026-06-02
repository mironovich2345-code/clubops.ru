import type { Invoice } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/auth";

// SQLite (local beta) has no enum support, so Prisma types `status` as a plain
// string. We keep the domain union here so call sites stay type-safe.
// When switching back to Postgres enums, this can be re-exported from
// "@prisma/client" instead.
export type InvoiceStatus = "unpaid" | "paid" | "rejected" | "overdue";

export type InvoiceWithClub = Omit<Invoice, "status"> & {
  status: InvoiceStatus;
  club: { id: string; name: string; city: string };
};

export async function getClubsForUser(user: CurrentUser) {
  if (user.role === "owner") {
    return prisma.club.findMany({ orderBy: { name: "asc" } });
  }
  return prisma.club.findMany({
    where: { userAccess: { some: { userId: user.id } } },
    orderBy: { name: "asc" },
  });
}

export async function getInvoicesForUser(user: CurrentUser): Promise<InvoiceWithClub[]> {
  const where =
    user.role === "owner"
      ? {}
      : { club: { userAccess: { some: { userId: user.id } } } };

  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { club: true },
  });
  // `status` is TEXT in SQLite; it only ever holds InvoiceStatus values.
  return invoices as InvoiceWithClub[];
}

export async function userHasClubAccess(user: CurrentUser, clubId: string): Promise<boolean> {
  if (user.role === "owner") return true;
  const access = await prisma.userClubAccess.findUnique({
    where: { userId_clubId: { userId: user.id, clubId } },
  });
  return access !== null;
}

export function isOverdue(invoice: { status: InvoiceStatus; dueDate: Date }): boolean {
  if (invoice.status === "paid" || invoice.status === "rejected") return false;
  return invoice.dueDate.getTime() < Date.now();
}

export type StatusSummary = {
  unpaid: { count: number; amountKopeks: number };
  overdue: { count: number; amountKopeks: number };
  paid: { count: number; amountKopeks: number };
  rejected: { count: number; amountKopeks: number };
};

export function summarize(
  invoices: Array<{ status: InvoiceStatus; dueDate: Date; amountKopeks: number }>,
): StatusSummary {
  const summary: StatusSummary = {
    unpaid: { count: 0, amountKopeks: 0 },
    overdue: { count: 0, amountKopeks: 0 },
    paid: { count: 0, amountKopeks: 0 },
    rejected: { count: 0, amountKopeks: 0 },
  };
  const now = Date.now();
  for (const inv of invoices) {
    if (inv.status === "paid") {
      summary.paid.count += 1;
      summary.paid.amountKopeks += inv.amountKopeks;
    } else if (inv.status === "rejected") {
      summary.rejected.count += 1;
      summary.rejected.amountKopeks += inv.amountKopeks;
    } else if (inv.status === "overdue" || inv.dueDate.getTime() < now) {
      summary.overdue.count += 1;
      summary.overdue.amountKopeks += inv.amountKopeks;
    } else {
      summary.unpaid.count += 1;
      summary.unpaid.amountKopeks += inv.amountKopeks;
    }
  }
  return summary;
}
