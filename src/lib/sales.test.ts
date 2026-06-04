// Smoke test for the sale verification decision table.
// Call runSalesSmokeTest() to assert who may confirm/reject/cancel (throws on failure).

import { applySaleAction, availableSaleActions } from "./sales";
import type { Role } from "@/lib/auth";

function assert(label: string, cond: boolean): void {
  if (!cond) throw new Error(`sales smoke test failed: ${label}`);
}

const MANAGER: Role[] = ["manager"];
const ACCOUNTANT: Role[] = ["accountant"];
const OWNER: Role[] = ["owner"];
const REGIONAL: Role[] = ["regional_director"];

export function runSalesSmokeTest(): void {
  const P = "pending_accountant";

  // Confirm: accountant/owner only, on a pending sale.
  assert("accountant confirms others' pending", applySaleAction("confirm", P, ACCOUNTANT, false).ok);
  assert("owner confirms pending", applySaleAction("confirm", P, OWNER, false).ok);
  assert("manager cannot confirm", !applySaleAction("confirm", P, MANAGER, false).ok);
  assert("regional cannot confirm", !applySaleAction("confirm", P, REGIONAL, false).ok);
  // Separation of duties: a non-owner cannot confirm their own submission.
  assert("accountant cannot confirm own", !applySaleAction("confirm", P, ACCOUNTANT, true).ok);
  assert("owner may confirm own", applySaleAction("confirm", P, OWNER, true).ok);
  // Confirm only from pending.
  assert("cannot confirm already confirmed", !applySaleAction("confirm", "confirmed", ACCOUNTANT, false).ok);

  // Reject: accountant/owner on pending.
  assert("accountant rejects pending", applySaleAction("reject", P, ACCOUNTANT, false).ok);
  assert("manager cannot reject", !applySaleAction("reject", P, MANAGER, false).ok);
  assert("cannot reject rejected", !applySaleAction("reject", "rejected", ACCOUNTANT, false).ok);

  // Cancel: creator or owner, on pending.
  assert("manager cancels own pending", applySaleAction("cancel", P, MANAGER, true).ok);
  assert("manager cannot cancel others'", !applySaleAction("cancel", P, MANAGER, false).ok);
  assert("owner cancels any pending", applySaleAction("cancel", P, OWNER, false).ok);
  assert("cannot cancel confirmed", !applySaleAction("cancel", "confirmed", OWNER, false).ok);

  // Terminal statuses expose no actions.
  assert("confirmed has no actions", availableSaleActions("confirmed", OWNER, false).length === 0);
  assert("canceled has no actions", availableSaleActions("canceled", OWNER, false).length === 0);

  // A pending sale: accountant sees confirm+reject; manager-creator sees cancel only.
  const accActions = availableSaleActions(P, ACCOUNTANT, false).sort();
  assert("accountant sees confirm+reject", accActions.join(",") === "confirm,reject");
  assert("manager-creator sees cancel only", availableSaleActions(P, MANAGER, true).join(",") === "cancel");
  assert("manager non-creator sees nothing", availableSaleActions(P, MANAGER, false).length === 0);
}
