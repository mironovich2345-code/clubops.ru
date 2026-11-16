import { PrismaClient } from "@prisma/client";
import { demoRequested, demoConfig } from "@/lib/demo/config";

if (demoRequested()) demoConfig();

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" && !demoRequested() ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
