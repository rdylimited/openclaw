import Decimal from "decimal.js";

// CN CIT rates
const CN_CIT_STANDARD_RATE = new Decimal("0.25");
const CN_CIT_SMALL_MICRO_EFFECTIVE_RATE = new Decimal("0.05");
const CN_CIT_HIGH_TECH_RATE = new Decimal("0.15");
const CN_CIT_SMALL_MICRO_THRESHOLD = new Decimal("3000000"); // CNY 3M

type CnEnterpriseType = "standard" | "small_micro" | "high_tech";

/**
 * Compute China Corporate Income Tax.
 * - Standard: 25%
 * - Small/micro enterprises (≤ CNY 3M taxable): 5% effective
 * - High-tech enterprises: 15%
 */
export function computeCnCit(
  assessableProfit: Decimal,
  enterpriseType: CnEnterpriseType = "standard",
): { tax: Decimal; rate: Decimal; method: string } {
  if (assessableProfit.lte(0)) {
    return { tax: new Decimal(0), rate: new Decimal(0), method: "no taxable profit" };
  }

  switch (enterpriseType) {
    case "small_micro": {
      if (assessableProfit.lte(CN_CIT_SMALL_MICRO_THRESHOLD)) {
        return {
          tax: assessableProfit.times(CN_CIT_SMALL_MICRO_EFFECTIVE_RATE),
          rate: CN_CIT_SMALL_MICRO_EFFECTIVE_RATE,
          method: "CN CIT small/micro enterprise (5% effective on ≤3M)",
        };
      }
      // Above threshold, standard rate applies
      return {
        tax: assessableProfit.times(CN_CIT_STANDARD_RATE),
        rate: CN_CIT_STANDARD_RATE,
        method: "CN CIT standard (small/micro exceeded 3M threshold)",
      };
    }
    case "high_tech":
      return {
        tax: assessableProfit.times(CN_CIT_HIGH_TECH_RATE),
        rate: CN_CIT_HIGH_TECH_RATE,
        method: "CN CIT high-tech enterprise (15%)",
      };
    default:
      return {
        tax: assessableProfit.times(CN_CIT_STANDARD_RATE),
        rate: CN_CIT_STANDARD_RATE,
        method: "CN CIT standard (25%)",
      };
  }
}

/**
 * Compute China VAT for small-scale taxpayers.
 * Flat rate on sales (no input credit).
 * Standard rate: 3%, reduced rate: 1% (COVID-era relief, sometimes extended).
 */
export function computeCnVatSmallScale(
  taxableSales: Decimal,
  rate: number = 0.03,
): { tax: Decimal; rate: number; method: string } {
  if (taxableSales.lte(0)) {
    return { tax: new Decimal(0), rate, method: "no taxable sales" };
  }

  const tax = taxableSales.times(rate);
  return {
    tax,
    rate,
    method: `CN VAT small-scale taxpayer (${(rate * 100).toFixed(0)}% flat, no input credit)`,
  };
}
