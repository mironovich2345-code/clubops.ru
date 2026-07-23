// Payroll Stage 2 tests — employee setup: club assignments, effective-dated pay
// schemes, and the "changing a scheme never recomputes a closed month" guarantee.
// Behavioural mirrors of the pure helpers in src/lib/payroll/{schemes,assignments}.ts
// plus static guards over the server actions + access wiring.
// npm run pilot:payroll-setup
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const D = (s) => new Date(s);

// ---- mirror: resolveEffectiveScheme (schemes.ts) ----
function resolveEffectiveScheme(schemes, at) {
  const t = at.getTime();
  let best = null;
  for (const s of schemes) {
    const from = new Date(s.effectiveFrom).getTime();
    const to = s.effectiveTo == null ? Infinity : new Date(s.effectiveTo).getTime();
    if (from <= t && t < to) {
      if (best == null || from > new Date(best.effectiveFrom).getTime()) best = s;
    }
  }
  return best;
}

// ---- mirror: schemesToSupersede (schemes.ts) ----
function schemesToSupersede(existing, from) {
  const t = from.getTime();
  const out = [];
  for (const s of existing) {
    if (s.effectiveTo == null && new Date(s.effectiveFrom).getTime() <= t) out.push({ id: s.id, effectiveTo: from });
  }
  return out;
}

// ---- mirror: validateAssignmentDraft bounds (assignments.ts) ----
const POSITIONS = ["manager","administrator","night_manager","head_gym_trainer","gym_trainer","senior_group_trainer","group_trainer","regional_director"];
function validateAssignmentDraft(raw) {
  const clubId = (raw.clubId ?? "").trim();
  const position = (raw.position ?? "").trim();
  if (!clubId) return { ok: false };
  if (!POSITIONS.includes(position)) return { ok: false };
  if (raw.share != null) {
    const s = raw.share;
    if (!Number.isInteger(s) || s < 0 || s > 10000) return { ok: false };
  }
  return { ok: true };
}

function main() {
  // --- effective scheme resolution ---
  const hist = [
    { id: "a", effectiveFrom: "2026-01-01", effectiveTo: "2026-04-01" }, // Jan–Mar
    { id: "b", effectiveFrom: "2026-04-01", effectiveTo: null },          // Apr onward (open)
  ];
  check("SET1 resolves old scheme mid-window", resolveEffectiveScheme(hist, D("2026-02-15"))?.id === "a");
  check("SET2 resolves new scheme after boundary", resolveEffectiveScheme(hist, D("2026-06-01"))?.id === "b");
  check("SET3 boundary is half-open [from,to)", resolveEffectiveScheme(hist, D("2026-04-01"))?.id === "b");
  check("SET4 nothing in effect before first scheme", resolveEffectiveScheme(hist, D("2025-12-31")) === null);
  check("SET5 latest effectiveFrom wins on overlap",
    resolveEffectiveScheme([
      { id: "x", effectiveFrom: "2026-01-01", effectiveTo: null },
      { id: "y", effectiveFrom: "2026-03-01", effectiveTo: null },
    ], D("2026-05-01"))?.id === "y");

  // --- supersession: appending forward closes the open scheme, never edits history ---
  const existing = [{ id: "b", effectiveFrom: "2026-04-01", effectiveTo: null }];
  const sup = schemesToSupersede(existing, D("2026-07-01"));
  check("SET6 appending closes the currently-open scheme", sup.length === 1 && sup[0].id === "b" && sup[0].effectiveTo.getTime() === D("2026-07-01").getTime());
  check("SET7 a future-dated open scheme is NOT superseded",
    schemesToSupersede([{ id: "f", effectiveFrom: "2026-09-01", effectiveTo: null }], D("2026-07-01")).length === 0);
  check("SET8 closed (dated) schemes are never touched",
    schemesToSupersede([{ id: "a", effectiveFrom: "2026-01-01", effectiveTo: "2026-04-01" }], D("2026-07-01")).length === 0);

  // Simulated "no recompute of closed month": a scheme change effective 2026-07 leaves
  // the scheme governing a closed month (say May, covered by 'b') unchanged for May.
  const afterChange = [
    { id: "b", effectiveFrom: "2026-04-01", effectiveTo: "2026-07-01" }, // closed at boundary
    { id: "c", effectiveFrom: "2026-07-01", effectiveTo: null },
  ];
  check("SET9 closed month (May) still resolves to the old scheme after a forward change",
    resolveEffectiveScheme(afterChange, D("2026-05-20"))?.id === "b");

  // --- assignment validation ---
  check("SET10 valid assignment", validateAssignmentDraft({ clubId: "c1", position: "manager", share: 10000 }).ok === true);
  check("SET11 unknown position rejected", validateAssignmentDraft({ clubId: "c1", position: "ceo", share: null }).ok === false);
  check("SET12 share must be 0..100% (bp 0..10000)", validateAssignmentDraft({ clubId: "c1", position: "manager", share: 10001 }).ok === false);
  check("SET13 null share allowed", validateAssignmentDraft({ clubId: "c1", position: "manager", share: null }).ok === true);
  check("SET14 missing club rejected", validateAssignmentDraft({ clubId: "", position: "manager", share: null }).ok === false);

  // ---- static guards over the actions + wiring ----
  const actions = src("../src/app/(app)/payroll/actions.ts");
  const schemes = src("../src/lib/payroll/schemes.ts");
  const access = src("../src/lib/payroll/access.ts");
  const auth = src("../src/lib/auth.ts");
  const nav = src("../src/lib/navigation.ts");

  check("S8 scheme save guards against a closed month (monthClosedError before mutate)",
    actions.includes("monthClosedError(scope.companyId, clubId, effectiveFrom)"));
  check("S9 scheme save is append-forward only (closed months not rewritten)",
    actions.includes("должна вступать в силу позже") && actions.includes("effectiveFrom.getTime() <= latest"));
  check("S10 scheme params validated (no eval, structured)",
    actions.includes("validateSchemeParams(schemeType, collectSchemeRawParams") && !/\beval\(|new Function\(/.test(actions));
  check("S11 scheme setup gated by canManagePaySchemes",
    actions.includes("canManagePaySchemes(scope.ctx.effectiveRoles)") && access.includes("export function canManagePaySchemes"));
  check("S12 every mutation resolves access + club scope",
    actions.includes("getCurrentAccessContext()") && actions.includes("canAccessClub(ctx.user.id, targetClub)"));
  check("S13 assignment removal is soft (isActive:false, no delete)",
    actions.includes("data: { isActive: false }") && !actions.includes(".delete("));
  check("S14 mutations are audited server-side",
    actions.includes('action: "payroll.scheme_saved"') && actions.includes('action: "payroll.assignment_saved"'));
  check("S15 payroll page registered + navigable",
    auth.includes('"payroll"') && nav.includes('page: "payroll"'));
  check("S16 supersession + resolution are pure exports",
    schemes.includes("export function resolveEffectiveScheme") && schemes.includes("export function schemesToSupersede"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
