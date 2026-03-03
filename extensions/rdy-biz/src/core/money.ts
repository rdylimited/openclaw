import Decimal from "decimal.js";

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export function money(value: string | number): Decimal {
  return new Decimal(value);
}

export function sumMoney(values: Array<string | number>): Decimal {
  return values.reduce((acc: Decimal, v) => acc.plus(new Decimal(v)), new Decimal(0));
}

export function formatMoney(value: Decimal | string, currency = "HKD", decimals = 2): string {
  const d = value instanceof Decimal ? value : new Decimal(value);
  return `${currency} ${d.toFixed(decimals)}`;
}

export function moneyEqual(a: string | Decimal, b: string | Decimal): boolean {
  const da = a instanceof Decimal ? a : new Decimal(a);
  const db = b instanceof Decimal ? b : new Decimal(b);
  return da.equals(db);
}
