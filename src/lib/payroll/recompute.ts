// STAGE 13: recompute a calc's automatic amount from its EFFECTIVE scheme + stored inputs,
// optionally patching the personal-sales input from an OFD-attributed / manual figure. The
// scheme snapshot and past periods are never touched. No money movement.
import { prisma } from "@/lib/prisma";
import { effectiveSchemeParams } from "@/lib/payroll/change-request";
import { computeScheme, type PeriodInput } from "@/lib/payroll/compute";
import { recomputeCalculationTotals } from "@/lib/payroll/aggregate";
import { recomputeGymTrainerCalculation } from "@/app/(app)/payroll/periods/trainer-actions";

// Which PeriodInput field carries "personal sales" for a scheme type (spec §31).
const SALES_INPUT_FIELD: Record<string, keyof PeriodInput> = {
  sales_percentage: "salesKopeks",
  salary_plus_percentage: "netPersonalSalesKopeks",
  role_sales_manager: "personalSalesKopeks",
  role_night_manager: "personalSalesKopeks",
  role_group_trainer: "personalSalesKopeks",
  role_group_head_trainer: "personalSalesKopeks",
};

/** Does this scheme type consume a personal-sales figure? */
export function schemeUsesPersonalSales(schemeType: string): boolean {
  return schemeType in SALES_INPUT_FIELD;
}

function readStoredInput(detailsJson: string | null): PeriodInput {
  if (!detailsJson) return {};
  try {
    const d = JSON.parse(detailsJson) as { inputJson?: string };
    return d.inputJson ? (JSON.parse(d.inputJson) as PeriodInput) : {};
  } catch {
    return {};
  }
}

/**
 * Recompute the calc's automatic amount from the effective scheme + stored inputs. When
 * `personalSalesKopeks` is provided, it patches the scheme's personal-sales input field first
 * (so an OFD/manual sales figure drives the formula). Gym-trainer calcs recompute from their
 * packages (sales patch does not apply). Idempotent.
 */
export async function recomputeCalcAutomatic(calculationId: string, personalSalesKopeks?: number): Promise<void> {
  const calc = await prisma.payrollCalculation.findUnique({ where: { id: calculationId } });
  if (!calc) return;
  const scheme = effectiveSchemeParams(calc.schemeSnapshotJson, calc.approvedOverridesJson);
  if (!scheme) return;
  if (scheme.type === "gym_trainer") {
    await recomputeGymTrainerCalculation(calc.id);
    return;
  }
  const input = readStoredInput(calc.detailsJson);
  if (personalSalesKopeks != null) {
    const field = SALES_INPUT_FIELD[scheme.type];
    if (field) (input as Record<string, unknown>)[field] = personalSalesKopeks;
  }
  const result = computeScheme(scheme, input);
  const prevDetails = (() => {
    try {
      return calc.detailsJson ? (JSON.parse(calc.detailsJson) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })();
  await prisma.payrollCalculation.update({
    where: { id: calc.id },
    data: {
      automaticAmountKopeks: result.amountKopeks,
      detailsJson: JSON.stringify({ ...prevDetails, breakdown: result.breakdown, flags: result.flags, warnings: result.warnings, inputJson: JSON.stringify(input) }),
    },
  });
  await recomputeCalculationTotals(calc.id);
}
