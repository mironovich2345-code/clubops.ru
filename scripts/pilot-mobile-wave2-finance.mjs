// WAVE 2 — mobile finance contour (expenses / invoices / refunds). Static guards on the shared
// mobile component layer + the overspend role logic (§6/§23) with a behavioural truth-table that
// MIRRORS src/lib/auth.ts (house style, cf. pilot-category-isolation) plus source assertions so
// the mirror can't drift. Per-page card/filter/sticky guards are appended as those commits land.
//   npm run pilot:mobile-wave2-finance
import { readFileSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const has = (rel) => existsSync(new URL(rel, import.meta.url));

// ============================ SHARED COMPONENTS (§ shared layer) ============================
const M = (f) => src(`../src/components/mobile/${f}`);
check("S1 StatusBadge/StatusNote: semantic tone, text-first (не только цвет)", M("StatusBadge.tsx").includes("StatusTone") && M("StatusBadge.tsx").includes("StatusNote") && M("StatusBadge.tsx").includes('role="status"'));
check("S2 MobileListCard: link + amount + meta + status + actor + docs + problem + action", ["href", "amount", "meta", "status", "actor", "hasDocs", "problem", "action"].every((p) => M("MobileListCard.tsx").includes(p)) && M("MobileListCard.tsx").includes("break-anywhere"));
check("S3 Sheet: bottom+full variant, keyboard-safe max-h-[90dvh], safe-area, dirty close-warning", M("Sheet.tsx").includes('variant?: "bottom" | "full"') && M("Sheet.tsx").includes("max-h-[90dvh]") && M("Sheet.tsx").includes("pb-safe-actions") && M("Sheet.tsx").includes("dirty") && M("Sheet.tsx").includes("aria-modal"));
check("S4 StickyActions: mobile-only lg:hidden, safe-area, VisualViewport keyboard-aware", M("StickyActions.tsx").includes("lg:hidden") && M("StickyActions.tsx").includes("pb-safe-actions") && M("StickyActions.tsx").includes("visualViewport") && M("StickyActions.tsx").includes("translateY"));
check("S5 FilterSheet: mobile-only trigger + active chips + server form (formId)", M("FilterSheet.tsx").includes("lg:hidden") && M("FilterSheet.tsx").includes("chips") && M("FilterSheet.tsx").includes("form={formId}"));
check("S6 DocumentViewer: image fit/zoom, PDF embed, HEIC/webp download fallback, retry", M("DocumentViewer.tsx").includes("cursor-zoom") && M("DocumentViewer.tsx").includes("application/pdf") && M("DocumentViewer.tsx").includes("Скачать файл") && M("DocumentViewer.tsx").includes("Повторить") && M("DocumentViewer.tsx").includes("pt-safe"));
check("S7 MobileFileField: camera capture + per-file remove + count guard + anti double-tap", M("MobileFileField.tsx").includes('capture="environment"') && M("MobileFileField.tsx").includes("DataTransfer") && M("MobileFileField.tsx").includes("maxFiles") && M("MobileFileField.tsx").includes("useFormStatus"));
check("S8 touch targets ≥44px в интерактивных mobile-компонентах", M("FilterSheet.tsx").includes("min-h-[44px]") && M("MobileFileField.tsx").includes("min-h-[44px]") && M("DocumentViewer.tsx").includes("h-11"));

// ============================ OVERSPEND ROLE LOGIC (§6/§23) ============================
// Mirror of src/lib/auth.ts canApproveBudgetOverrunForCategory — kept in lockstep by O-SRC below.
const GD_ONLY = ["advertising"];
const GD_EXTRA = ["salary"];
function canApprove(roles, category) {
  if (GD_ONLY.includes(category)) return roles.includes("general_director");
  if (roles.includes("owner") || roles.includes("regional_director")) return true;
  if (roles.includes("general_director")) return GD_EXTRA.includes(category);
  return false;
}
const OWNER = ["owner"], RD = ["regional_director"], GD = ["general_director"], MGR = ["manager"], ACC = ["accountant"];

check("O1 owner НЕ согласует рекламный перерасход", canApprove(OWNER, "advertising") === false);
check("O2 регионал НЕ согласует рекламный перерасход", canApprove(RD, "advertising") === false);
check("O3 ГД согласует рекламный перерасход", canApprove(GD, "advertising") === true);
check("O4 owner согласует обычный перерасход (аренда)", canApprove(OWNER, "rent") === true);
check("O5 регионал согласует обычный перерасход (club-scope отдельно)", canApprove(RD, "rent") === true);
check("O6 ГД согласует зарплатный перерасход (whitelist)", canApprove(GD, "salary") === true);
check("O7 ГД НЕ согласует прочий не-рекламный/не-зарплатный перерасход", canApprove(GD, "rent") === false);
check("O8 manager/accountant не согласуют перерасход вообще", !canApprove(MGR, "rent") && !canApprove(MGR, "advertising") && !canApprove(ACC, "rent"));

// Source assertions — the real function must match the mirror + carry the GD-only advertising rule.
const auth = src("../src/lib/auth.ts");
check("O-SRC1 auth.ts: GD_ONLY_OVERRUN_CATEGORIES = advertising (owner/RD исключены)", auth.includes("GD_ONLY_OVERRUN_CATEGORIES") && /ADVERTISING_CATEGORY\s*=\s*"advertising"/.test(auth) && /GD_ONLY_OVERRUN_CATEGORIES\.includes\(category\)[\s\S]{0,80}return roles\.includes\("general_director"\)/.test(auth));
check("O-SRC2 auth.ts: не-реклама → owner/RD, GD только whitelist (salary)", /roles\.includes\("owner"\) \|\| roles\.includes\("regional_director"\)\) return true/.test(auth) && auth.includes('GD_OVERRUN_CATEGORIES: readonly string[] = ["salary"]'));
check("O-SRC3 auth.ts: error про рекламу → только ГД", auth.includes("Перерасход по рекламе согласовывает только генеральный директор"));

// Server guard: BOTH approve + reject go through loadDecidableRequest, which enforces the category
// gate BEFORE any mutation, plus club-scope + self-approval. No direct-call bypass (§23).
const budgetActions = src("../src/app/(app)/budgets/actions.ts");
const loadFn = (budgetActions.match(/async function loadDecidableRequest[\s\S]*?\n}/) || [""])[0];
check("O-SRV1 approve+reject проходят через loadDecidableRequest (единый guard)", /approveBudgetRequest[\s\S]{0,400}loadDecidableRequest/.test(budgetActions) && /rejectBudgetRequest[\s\S]{0,400}loadDecidableRequest/.test(budgetActions));
check("O-SRV2 guard вызывает canApproveBudgetOverrunForCategory и бросает до мутации", loadFn.includes("canApproveBudgetOverrunForCategory") && loadFn.includes("throw new Error"));
check("O-SRV3 guard хранит club-scope + self-approval блок", loadFn.includes("getManageableClubIds") && loadFn.includes("Нельзя согласовать собственный запрос"));
check("O-SRV4 UI-зеркало canDecide тоже использует ту же capability", src("../src/app/(app)/budgets/page.tsx").includes("canApproveBudgetOverrunForCategory"));

// ============================ EXPENSES (§3/§4) ============================
const expList = src("../src/app/(app)/expenses/page.tsx");
check("E1 expenses список: desktop таблица hidden lg:block + mobile карточки lg:hidden", expList.includes("hidden overflow-x-auto") && expList.includes("lg:block") && /space-y-3 lg:hidden/.test(expList) && expList.includes("<MobileListCard"));
check("E2 expenses карточка: статья+сумма+статус+клуб+дата (не все тех-поля)", /title=\{expenseCategoryLabel/.test(expList) && /amount=\{formatKopeks/.test(expList) && expList.includes("ExpenseStatusBadge status={expense.status}"));
check("E3 expenses list не клипает контент (overflow-hidden убран у таблицы)", !/xl:col-span-2 overflow-hidden/.test(expList));
check("E4 IpCash факт-блок не grid-cols-2 на 320px (стек → min-[400px])", expList.includes("grid-cols-1 gap-x-6 gap-y-1 text-sm min-[400px]:grid-cols-2"));

// ============================ EXPENSE create + documents (§5/§7/§16/§18) ============================
const simpleForm = src("../src/app/(app)/expenses/simple/SimpleExpenseForm.tsx");
check("E5 создание расхода: mobile StickyActions + desktop lg:block (без дубля), keyboard-clear pb", simpleForm.includes("<StickyActions>") && simpleForm.includes("hidden lg:block") && simpleForm.includes("pb-28 lg:pb-0"));
const expAtt = src("../src/app/(app)/expenses/[id]/_components/ExpenseAttachments.tsx");
check("E6 документы расхода: in-app DocumentLink viewer + tap-target ≥44px (нет сырого target=_blank для preview)", expAtt.includes("DocumentLink") && expAtt.includes("min-h-[44px]") && !/canPreview \? \(\s*<a href=\{a\.previewHref\} target="_blank"/.test(expAtt));

// ============================ INVOICES (§8) ============================
const invList = src("../src/app/(app)/invoices/page.tsx");
check("I-L1 все 3 таблицы счетов hidden lg:block + mobile карточки lg:hidden", (invList.match(/hidden overflow-x-auto lg:block/g) || []).length === 3 && (invList.match(/space-y-3 p-3 lg:hidden/g) || []).length === 3);
check("I-L2 карточка счёта: контрагент+сумма+статус+клуб+срок (StatusBadge)", invList.includes("<MobileListCard") && invList.includes("invoiceTone(") && /title=\{r\.counterpartyName/.test(invList));
check("I-L3 AI/просрочка отражены (problem-флаг)", invList.includes('problem={r.overdue ? "просрочен"') || invList.includes("problem={r.dueDate"));
check("I-L4 elevated summary не grid-cols-2 на 320px", invList.includes("grid-cols-1 gap-4 min-[400px]:grid-cols-2 lg:grid-cols-5"));

// ============================ REFUNDS list (§11) ============================
const refList = src("../src/app/(app)/refunds/page.tsx");
check("R-L1 RefundTable: desktop hidden lg:block + mobile карточки lg:hidden (покрывает список+очереди)", refList.includes("hidden overflow-x-auto lg:block") && refList.includes("space-y-3 p-3 lg:hidden") && refList.includes("<MobileListCard"));
check("R-L2 карточка возврата: клиент+сумма+статус+клуб (без телефона/реквизитов)", /title=\{r\.clientName \|\| r\.bankRecipientName/.test(refList) && refList.includes("refundTone(") && !/r\.(phone|bankAccount|bankBik|bik)\b/i.test(refList));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
