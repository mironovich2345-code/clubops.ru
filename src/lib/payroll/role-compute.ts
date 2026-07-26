// Role-categories engine v2 (STAGE 3–8). Bridges a validated role_* scheme + period
// inputs to the pure per-category functions in formulas.ts and returns the shared
// CalcResult (amount + breakdown + flags + warnings). NO rates/percents/salary parts are
// hardcoded here — everything comes from the snapshotted scheme params. This is the ONLY
// place formulas.ts is wired into the calc pipeline (called from compute.ts:computeScheme).
import type { CalcResult, BreakdownLine } from "@/lib/payroll/calc";
import type { SchemeParams } from "@/lib/payroll/scheme";
import type { PeriodInput } from "@/lib/payroll/compute";
import {
  managerSalary, administratorSalary, salesManagerSalary, nightManagerSalary,
  gymTrainerSalary, seniorGymTrainerSalary, groupTrainerSalary, seniorGroupTrainerSalary,
} from "@/lib/payroll/formulas";

const pctText = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;
const num = (v: number | undefined) => v ?? 0;

/** Dispatch a role_* scheme to its category formula. `scheme` is validated upstream. */
export function computeRoleCategoryScheme(scheme: SchemeParams, input: PeriodInput): CalcResult {
  switch (scheme.type) {
    case "role_club_manager": {
      const r = managerSalary({
        ab: { baseKopeks: scheme.params.abBaseKopeks, planKopeks: num(input.subscriptions?.planKopeks), factKopeks: num(input.subscriptions?.factKopeks) },
        pt: { baseKopeks: scheme.params.ptBaseKopeks, planKopeks: num(input.personalTraining?.planKopeks), factKopeks: num(input.personalTraining?.factKopeks) },
        limitBp: scheme.params.limitBp,
      });
      const warnings: string[] = [];
      if (!(input.subscriptions?.planKopeks)) warnings.push("АБ: план не задан.");
      if (!(input.personalTraining?.planKopeks)) warnings.push("ПТ: план не задан.");
      const breakdown: BreakdownLine[] = [
        { label: "АБ: окладная часть", valueKopeks: scheme.params.abBaseKopeks },
        { label: "АБ: план", valueKopeks: num(input.subscriptions?.planKopeks) },
        { label: "АБ: факт", valueKopeks: num(input.subscriptions?.factKopeks) },
        { label: "АБ: выполнение", text: pctText(r.ab.completionBp) },
        { label: "АБ: прибавка/вычет", text: `${r.ab.adjustmentBp >= 0 ? "+" : ""}${pctText(r.ab.adjustmentBp)}` },
        { label: "АБ: скорректированная часть", valueKopeks: r.ab.adjustedKopeks },
        { label: "ПТ: окладная часть", valueKopeks: scheme.params.ptBaseKopeks },
        { label: "ПТ: план", valueKopeks: num(input.personalTraining?.planKopeks) },
        { label: "ПТ: факт", valueKopeks: num(input.personalTraining?.factKopeks) },
        { label: "ПТ: выполнение", text: pctText(r.pt.completionBp) },
        { label: "ПТ: прибавка/вычет", text: `${r.pt.adjustmentBp >= 0 ? "+" : ""}${pctText(r.pt.adjustmentBp)}` },
        { label: "ПТ: скорректированная часть", valueKopeks: r.pt.adjustedKopeks },
        { label: "Итого начислено (управляющий)", valueKopeks: r.totalKopeks },
      ];
      return { amountKopeks: r.totalKopeks, breakdown, flags: {}, warnings };
    }
    case "role_administrator": {
      const r = administratorSalary({ shiftRateKopeks: scheme.params.shiftRateKopeks, shifts: num(input.actualShifts), normShifts: input.normShifts });
      const breakdown: BreakdownLine[] = [
        { label: "Ставка за смену", valueKopeks: scheme.params.shiftRateKopeks },
        { label: "Смен фактически", text: String(num(input.actualShifts)) },
        ...(input.normShifts != null ? [{ label: "Норма (контроль)", text: String(input.normShifts) }, { label: "Отклонение от нормы", text: `${r.normDeviationShifts >= 0 ? "+" : ""}${r.normDeviationShifts} смен` } as BreakdownLine] : []),
        { label: "Итого начислено (администратор)", valueKopeks: r.totalKopeks },
      ];
      return { amountKopeks: r.totalKopeks, breakdown, flags: {}, warnings: [] };
    }
    case "role_sales_manager": {
      const r = salesManagerSalary({ salaryFor15Kopeks: scheme.params.salaryFor15Kopeks, shiftNorm: scheme.params.shiftNorm, shifts: num(input.actualShifts), clubPlanCompletionBp: num(input.clubPlanCompletionBp), percentTiers: scheme.params.tiers, personalSalesKopeks: num(input.personalSalesKopeks), returnsKopeks: num(input.returnsKopeks) });
      const breakdown: BreakdownLine[] = [
        { label: "Стоимость смены (оклад/норма)", valueKopeks: r.shiftValueKopeks },
        { label: "Смен фактически", text: String(num(input.actualShifts)) },
        { label: "Окладная часть", valueKopeks: r.salaryPartKopeks },
        { label: "Выполнение общего плана клуба", text: pctText(num(input.clubPlanCompletionBp)) },
        { label: "Личная выручка", valueKopeks: num(input.personalSalesKopeks) },
        { label: "Возвраты", valueKopeks: num(input.returnsKopeks) },
        { label: "Чистая личная выручка", valueKopeks: r.netPersonalSalesKopeks },
        { label: "Применённый процент", text: pctText(r.appliedPercentBp) },
        { label: "Процентная часть", valueKopeks: r.percentPartKopeks },
        { label: "Итого начислено (менеджер продаж)", valueKopeks: r.totalKopeks },
      ];
      return { amountKopeks: r.totalKopeks, breakdown, flags: {}, warnings: [] };
    }
    case "role_night_manager": {
      const r = nightManagerSalary({ shiftRateKopeks: scheme.params.shiftRateKopeks, shifts: num(input.actualShifts), clubPlanCompletionBp: num(input.clubPlanCompletionBp), percentTiers: scheme.params.tiers, personalSalesKopeks: num(input.personalSalesKopeks), returnsKopeks: num(input.returnsKopeks) });
      const breakdown: BreakdownLine[] = [
        { label: "Ставка за ночную смену", valueKopeks: scheme.params.shiftRateKopeks },
        { label: "Ночных смен", text: String(num(input.actualShifts)) },
        { label: "Окладная часть", valueKopeks: r.salaryPartKopeks },
        { label: "Чистая личная выручка", valueKopeks: r.netPersonalSalesKopeks },
        { label: "Применённый процент", text: pctText(r.appliedPercentBp) },
        { label: "Процентная часть", valueKopeks: r.percentPartKopeks },
        { label: "Итого начислено (ночной менеджер)", valueKopeks: r.totalKopeks },
      ];
      return { amountKopeks: r.totalKopeks, breakdown, flags: {}, warnings: [] };
    }
    case "role_gym_trainer": {
      const r = gymTrainerSalary({ newSalesKopeks: num(input.newSalesKopeks), newRateBp: scheme.params.newRateBp, renewalSalesKopeks: num(input.renewalSalesKopeks), renewalRateBp: scheme.params.renewalRateBp, trainerCreditKopeks: num(input.trainerCreditKopeks) });
      const breakdown: BreakdownLine[] = [
        { label: "Продажи новым клиентам", valueKopeks: num(input.newSalesKopeks) },
        { label: "Процент по новым", text: pctText(scheme.params.newRateBp) },
        { label: "Начисление по новым", valueKopeks: r.newPartKopeks },
        { label: "Продажи по продлениям", valueKopeks: num(input.renewalSalesKopeks) },
        { label: "Процент по продлениям", text: pctText(scheme.params.renewalRateBp) },
        { label: "Начисление по продлениям", valueKopeks: r.renewalPartKopeks },
        { label: "Кредит тренера (информационно)", valueKopeks: r.trainerCreditKopeks },
        { label: "Итого начислено (тренер ТЗ)", valueKopeks: r.totalKopeks },
      ];
      return { amountKopeks: r.totalKopeks, breakdown, flags: {}, warnings: [] };
    }
    case "role_gym_head_trainer": {
      const r = seniorGymTrainerSalary({ newSalesKopeks: num(input.newSalesKopeks), renewalSalesKopeks: num(input.renewalSalesKopeks), clubPtCompletionBp: num(input.clubPtCompletionBp), newTiers: scheme.params.newTiers, renewalTiers: scheme.params.renewalTiers, trainerCreditKopeks: num(input.trainerCreditKopeks) });
      const breakdown: BreakdownLine[] = [
        { label: "Продажи новым клиентам", valueKopeks: num(input.newSalesKopeks) },
        { label: "Продажи по продлениям", valueKopeks: num(input.renewalSalesKopeks) },
        { label: "Выполнение общего плана ПТ клуба", text: pctText(num(input.clubPtCompletionBp)) },
        { label: "Применённый % (новые)", text: pctText(r.appliedNewBp) },
        { label: "Применённый % (продления)", text: pctText(r.appliedRenewalBp) },
        { label: "Кредит тренера (информационно)", valueKopeks: r.trainerCreditKopeks },
        { label: "Итого начислено (старший тренер ТЗ)", valueKopeks: r.totalKopeks },
      ];
      return { amountKopeks: r.totalKopeks, breakdown, flags: {}, warnings: [] };
    }
    case "role_group_trainer": {
      const r = groupTrainerSalary({ hours: num(input.hours), hourRateKopeks: scheme.params.hourRateKopeks, personalSalesKopeks: num(input.personalSalesKopeks), personalRateBp: scheme.params.personalRateBp });
      const breakdown: BreakdownLine[] = [
        { label: "Часы", text: String(num(input.hours)) },
        { label: "Ставка за час", valueKopeks: scheme.params.hourRateKopeks },
        { label: "Оплата часов", valueKopeks: r.hoursPartKopeks },
        { label: "Личные продажи", valueKopeks: num(input.personalSalesKopeks) },
        { label: "Личный процент", text: pctText(scheme.params.personalRateBp) },
        { label: "Начисление с личных продаж", valueKopeks: r.personalPartKopeks },
        { label: "Итого начислено (тренер ГП)", valueKopeks: r.totalKopeks },
      ];
      return { amountKopeks: r.totalKopeks, breakdown, flags: {}, warnings: [] };
    }
    case "role_group_head_trainer": {
      const r = seniorGroupTrainerSalary({ hours: num(input.hours), hourRateKopeks: scheme.params.hourRateKopeks, personalSalesKopeks: num(input.personalSalesKopeks), personalRateBp: scheme.params.personalRateBp, fixedBonusKopeks: scheme.params.fixedBonusKopeks, clubGroupSalesKopeks: num(input.clubGroupSalesKopeks), clubShareBp: scheme.params.clubShareBp });
      const breakdown: BreakdownLine[] = [
        { label: "Оплата часов", valueKopeks: r.hoursPartKopeks },
        { label: "Личные продажи", valueKopeks: num(input.personalSalesKopeks) },
        { label: "Начисление с личных продаж", valueKopeks: r.personalPartKopeks },
        { label: "Фиксированная доплата старшего", valueKopeks: r.fixedBonusKopeks },
        { label: `Доля от выручки ГП клуба (${pctText(scheme.params.clubShareBp)})`, valueKopeks: r.clubSharePartKopeks },
        { label: "Итого начислено (старший тренер ГП)", valueKopeks: r.totalKopeks },
      ];
      return { amountKopeks: r.totalKopeks, breakdown, flags: {}, warnings: [] };
    }
    default:
      // Non-role scheme reached this function — defensive; the caller only routes role_*.
      return { amountKopeks: 0, breakdown: [], flags: { needsManualReview: true }, warnings: ["Схема не относится к движку ролевых категорий."] };
  }
}
