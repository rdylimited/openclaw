import { describe, it, expect } from "vitest";
import { money, sumMoney, formatMoney, moneyEqual } from "../../src/core/money.js";

describe("money", () => {
  it("avoids floating point errors", () => {
    const result = money("0.1").plus(money("0.2"));
    expect(result.toString()).toBe("0.3");
  });

  it("sums array of values", () => {
    expect(sumMoney(["10.50", "20.30", "5.20"]).toFixed(2)).toBe("36.00");
  });

  it("formats with currency", () => {
    expect(formatMoney(money("1234.5"), "HKD")).toBe("HKD 1234.50");
  });

  it("compares equality", () => {
    expect(moneyEqual("100.00", "100")).toBe(true);
    expect(moneyEqual("100.01", "100.02")).toBe(false);
  });
});
