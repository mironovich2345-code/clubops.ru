// Shared narrow DB-client type so domain helpers can run either standalone (the global prisma
// client, the default) OR inside a prisma.$transaction callback (Prisma.TransactionClient). A
// helper typed to DbClient CANNOT call $transaction on it — that is intentional: it prevents a
// nested transaction and forces the caller to own the transaction boundary (REM-01).
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type DbClient = typeof prisma | Prisma.TransactionClient;
