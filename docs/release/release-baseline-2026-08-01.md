# Release baseline — 2026-08-01

Frozen stable point of `main` and the live-gate plan for the final finance/owner scenarios ahead
of the 18 Aug release. **No new features, no auto-deploy.** This document records what is proved,
and what still needs a human on production.

## 1. Baseline facts
| Item | Value |
|---|---|
| Baseline commit (`main` HEAD = `origin/main`) | **`b755603`** — "docs(cash): movements + control-snapshot guides…" (2026-07-30) |
| Production deploy commit | **read live** from `GET /api/health` → `deploymentVersion` (commit/deployId). This sandbox has no production DB/network, so capture it from prod at gate time. Release candidate = `b755603`. |
| Dev migrations (`prisma/migrations`) | **70**, latest `20260730120000_cash_regional_transfer_and_snapshot_versioning` |
| Prod migrations (`prisma/production/migrations`) | **66**, latest `20260730120000_cash_regional_transfer_and_snapshot_versioning` (additive: `ADD COLUMN` + `CREATE TABLE`) |
| Pilot suites (`pilot:full`) | **76** |
| `pilot:*` npm scripts | 74 |

## 2. Gauntlet results (this baseline)
| Check | Result |
|---|---|
| `tsc --noEmit` | ✅ exit 0 (clean) |
| `prisma validate` (dev, sqlite) | ✅ valid |
| `prisma validate` (prod, postgres) | ✅ valid |
| `pilot:full` | ✅ **3468 passed, 0 failed across 76 suites** |
| `build:prod` (prod prisma generate + next build) | ✅ compiled, exit 0 |

## 3. Evidence tiers
### Proved by code + tests (pilots)
- Regional transfer: model, RBAC statics, and the money semantics via a runtime formula mirror
  (confirmed reduces; pending/cancelled don't; not an expense) — `pilot:cash-transfer-backdated-snapshot` (30).
- Backdated/versioned snapshots: resolver (latest active ≤ now), same-date guard, append-only
  correction, deterministic same-day ordering, kopeks-exact — same pilot.
- Expense/document/total consistency, owner-cabinet structural fixes, prior finance/OFD/payroll
  pilots — `pilot:full` 3468/0.

### Proved by build
- Type safety (`tsc`), dev + prod schema validity, production Next build.

### Requires production live-check (money movement on real data)
- **G1** Transfer end-to-end (balance −10 ₽ only after manager confirm; RBAC; idempotent; cancel).
- **G2** Backdated control point (01.07 after 02.07 keeps today's balance; interval correct).
- **G3** Correction chain (append-only; new active version; balance unchanged).

### Requires a real iPhone
- **G4** Owner document viewer (multipage PDF one-finger scroll; Safari + PWA; portrait/landscape;
  restore position; download; Cyrillic filename).
- **G5** Owner invitation flow per role (manager active-club required; company-scope roles; dark theme).

### Requires production data reconciliation
- **R1** Expense summary vs list on the real ПИТЕР СПОРТ / Союз / month scope — run
  `npm run audit:expense-summary-consistency -- --company "ПИТЕР СПОРТ" --club "Союз" --month 2026-07`
  (read-only; the sandbox has only synthetic dev data).
- **R2** Snapshot preflight on prod — `npm run preflight:balance-snapshots` (read-only): same-date
  dupes, future dates, orphan legal entity, archived-club snapshots.

## 4. Read-only diagnostics prepared (mutate nothing)
| Command | Purpose |
|---|---|
| `npm run diag:regional-transfer -- <transferId>` | amountKopeks, status, includedInBalance, balanceBefore/After (ИП fact, formula-mirrored), deltaMatches, createdExpenseId=null, affectedRevenue/Profit=false |
| `npm run diag:snapshot-chain -- --club "Союз" --entity ip` | full version chain, active versions + effective intervals, current applicable snapshot, calculated current opening, backdated-invariant proof |
| `npm run audit:expense-summary-consistency -- --company … --club … --month …` | ID-level reconciliation of card vs list with exact kopeks decomposition |
| `npm run preflight:balance-snapshots` | snapshot rollout preflight |

---

## LIVE GATE G1 — Передача региональному директору
Pick a test club + active ИП. Expected results are exact; the diagnostic proves them read-only.
1. Record the ИП fact balance (ИП card / `diag:snapshot-chain` for the opening + the ИП card).
2. Create a transfer of **10,00 ₽** to a regional director → status «Ожидает подтверждения управляющего».
3. **Pending does not move the balance** — `diag:regional-transfer <id>` → `includedInBalance:false`,
   `balanceBefore == balanceAfter`.
4. The **regional director cannot** confirm it themselves.
5. A **manager of another club cannot** confirm.
6. The **manager of this club** confirms.
7. Verify: balance **−10,00 ₽ exactly**; `createdExpenseId:null`; `affectedRevenue:false`;
   `affectedProfit:false`; the op is in history with author / recipient / confirmer correct.
   → `diag:regional-transfer <id>` → `includedInBalance:true`, `deltaKopeks:-1000`, `deltaMatches:true`.
8. **Confirm again** (double-click) → balance unchanged (idempotent).
9. On a separate pending transfer, **cancel** → balance unchanged.

## LIVE GATE G2/G3 — Backdated control snapshot + correction
Start: **02.07.2026 = 15 509,92 ₽** (active). Add **01.07.2026 = 0,98 ₽**.
- Both points saved; 02.07 unchanged (amount + date); today's balance unchanged.
- 01.07 acts only until 02.07; timeline shows «с 01.07 до 02.07» / «с 02.07 по настоящее время».
- `diag:snapshot-chain --club <c> --entity ip` → current applicable = 02.07; earliest active (01.07)
  «НЕ является текущей применимой» (backdated proof).
Then **correct** the 01.07 point (new amount + **required reason**):
- Old version stays (`superseded`); new version references it (`supersedesSnapshotId`); only the new
  version is active on 01.07; **today's balance unchanged**. Verify via `diag:snapshot-chain`
  (chain shows both versions; one active per date).

## LIVE GATE G4 — Owner document viewer (real iPhone)
Open a **multipage PDF** and a **long image**: one-finger vertical scroll to the last page (no zoom);
Safari **and** installed PWA (standalone); **portrait and landscape**; close → page scroll position
restored; **download** works; **Cyrillic filename** intact.

## LIVE GATE G5 — Owner invitation flow (real device, per role)
- Owner invites **manager** → active-club select is enabled + **required**; archived clubs absent;
  submitting without a club is **server-rejected**.
- **regional / accountant / chief** → «Доступ ко всей компании» (no broken club select); invite sends.
- Dark theme: the club control is **not white**.
- A user of **another company** cannot gain access.

## Known limitations
- Production reconciliation (R1) and the live gates (G1–G5) require production access — cannot be run
  from this sandbox (no network, dev DB is synthetic, app behind email-OTP).
- The regional-transfer feature intentionally does **not** revive the legacy `CashWallet`/`CashMovement`
  ledger; old ledger rows are not read by the formula (documented in the cash audit).
- The ИП card «Расходы ИП на проверке» is intentionally a narrower set than the expenses list (not a bug).
- Some prior stages carry their own manual acceptance (owner cabinet viewer + invitation) — folded into
  G4/G5 here.
