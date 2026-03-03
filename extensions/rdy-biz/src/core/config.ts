import { z } from "zod";

export const BizConfigValues = z.object({
  supabaseUrl: z.string().url(),
  supabaseServiceKey: z.string().min(1),
  tenantId: z.string().uuid(),
  defaultCurrency: z.string().length(3).default("HKD"),
  fiscalYearStart: z
    .string()
    .regex(/^\d{2}-\d{2}$/)
    .default("04-01"),
  timezone: z.string().default("Asia/Hong_Kong"),
  vllmBaseUrl: z.string().url().default("http://100.115.36.67:8000"),
  vllmModel: z.string().default("rdycore-pro"),
  chartOfAccountsPreset: z.enum(["hk-sme", "us-gaap", "custom"]).default("hk-sme"),
  multiCurrency: z.boolean().default(true),
  taxJurisdiction: z.string().default("HK"),
  profitsTaxRate: z.number().min(0).max(1).default(0.165),
});

export type BizConfig = z.infer<typeof BizConfigValues>;

export const BizConfigSchema = {
  parse(value: unknown): BizConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return BizConfigValues.parse(raw);
  },
  safeParse(value: unknown) {
    try {
      return { success: true as const, data: this.parse(value) };
    } catch (error) {
      return {
        success: false as const,
        error: { issues: [{ path: [], message: String(error) }] },
      };
    }
  },
  jsonSchema: {
    type: "object",
    properties: {
      supabaseUrl: { type: "string" },
      supabaseServiceKey: { type: "string" },
      tenantId: { type: "string" },
      defaultCurrency: { type: "string", default: "HKD" },
      fiscalYearStart: { type: "string", default: "04-01" },
      timezone: { type: "string", default: "Asia/Hong_Kong" },
    },
    required: ["supabaseUrl", "supabaseServiceKey", "tenantId"],
  },
  uiHints: {
    supabaseServiceKey: { label: "Supabase Service Key", sensitive: true },
    tenantId: { label: "Tenant ID" },
    defaultCurrency: { label: "Default Currency", placeholder: "HKD" },
  },
};
