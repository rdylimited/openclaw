-- migrations/003_cn_dualbook.sql
-- China support + Dual-book accounting + Bug fixes
-- Run after 001_create_biz_schema.sql and 002_seed_defaults.sql

------------------------------------------------------------
-- BUG FIX 4: tax_filings missing columns
------------------------------------------------------------
ALTER TABLE biz.tax_filings ADD COLUMN IF NOT EXISTS jurisdiction TEXT;
ALTER TABLE biz.tax_filings ADD COLUMN IF NOT EXISTS filed_by TEXT;

------------------------------------------------------------
-- BUG FIX 5: payroll_items missing columns
------------------------------------------------------------
ALTER TABLE biz.payroll_items ADD COLUMN IF NOT EXISTS contract_id UUID REFERENCES biz.contracts(id);
ALTER TABLE biz.payroll_items ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'HKD';
ALTER TABLE biz.payroll_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE biz.payroll_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE biz.payroll_items ADD COLUMN IF NOT EXISTS mpf_employer NUMERIC(19,4) DEFAULT 0;
ALTER TABLE biz.payroll_items ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES biz.tenants(id);

-- Backfill tenant_id from payroll_runs for existing rows
UPDATE biz.payroll_items pi
SET tenant_id = pr.tenant_id
FROM biz.payroll_runs pr
WHERE pi.payroll_run_id = pr.id AND pi.tenant_id IS NULL;

------------------------------------------------------------
-- DUAL-BOOK SUPPORT: books table
------------------------------------------------------------
CREATE TABLE biz.books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_default BOOLEAN DEFAULT false,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, code)
);

ALTER TABLE biz.books ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz.books
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- Add book_id to journal_entries (nullable for backward compat)
ALTER TABLE biz.journal_entries ADD COLUMN IF NOT EXISTS book_id UUID REFERENCES biz.books(id);
CREATE INDEX IF NOT EXISTS idx_je_book ON biz.journal_entries(tenant_id, book_id, date);

-- Also add total_debit/total_credit if missing (used by journal-entry.ts)
ALTER TABLE biz.journal_entries ADD COLUMN IF NOT EXISTS total_debit NUMERIC(19,4) DEFAULT 0;
ALTER TABLE biz.journal_entries ADD COLUMN IF NOT EXISTS total_credit NUMERIC(19,4) DEFAULT 0;
ALTER TABLE biz.journal_entries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE biz.journal_entries ADD COLUMN IF NOT EXISTS reversal_of UUID REFERENCES biz.journal_entries(id);

-- Seed default books for each existing tenant
INSERT INTO biz.books (tenant_id, code, name, is_default)
SELECT id, 'statutory', 'Statutory Book', true FROM biz.tenants
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO biz.books (tenant_id, code, name, is_default)
SELECT id, 'internal', 'Internal Book', false FROM biz.tenants
ON CONFLICT (tenant_id, code) DO NOTHING;

------------------------------------------------------------
-- JURISDICTION SUPPORT: contracts.jurisdiction
------------------------------------------------------------
ALTER TABLE biz.contracts ADD COLUMN IF NOT EXISTS jurisdiction TEXT DEFAULT 'HK';

------------------------------------------------------------
-- CN SOCIAL INSURANCE RATES (per-city)
------------------------------------------------------------
CREATE TABLE biz.cn_social_insurance_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  city TEXT NOT NULL DEFAULT 'default',
  pension_employee NUMERIC(5,4) DEFAULT 0.0800,
  pension_employer NUMERIC(5,4) DEFAULT 0.1600,
  medical_employee NUMERIC(5,4) DEFAULT 0.0200,
  medical_employer NUMERIC(5,4) DEFAULT 0.0800,
  unemployment_employee NUMERIC(5,4) DEFAULT 0.0050,
  unemployment_employer NUMERIC(5,4) DEFAULT 0.0050,
  work_injury_employer NUMERIC(5,4) DEFAULT 0.0040,
  maternity_employer NUMERIC(5,4) DEFAULT 0.0080,
  housing_fund_employee NUMERIC(5,4) DEFAULT 0.0700,
  housing_fund_employer NUMERIC(5,4) DEFAULT 0.0700,
  pension_base_min NUMERIC(19,4) DEFAULT 0,
  pension_base_max NUMERIC(19,4) DEFAULT 0,
  housing_base_min NUMERIC(19,4) DEFAULT 0,
  housing_base_max NUMERIC(19,4) DEFAULT 0,
  effective_from DATE NOT NULL DEFAULT '2024-01-01',
  active BOOLEAN DEFAULT true,
  UNIQUE(tenant_id, city, effective_from)
);

ALTER TABLE biz.cn_social_insurance_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz.cn_social_insurance_rates
  USING (tenant_id::text = current_setting('app.tenant_id', true));

------------------------------------------------------------
-- ADDITIONAL COLUMNS for budget_lines (used by code)
------------------------------------------------------------
ALTER TABLE biz.budget_lines ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES biz.tenants(id);
ALTER TABLE biz.budget_lines ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE biz.budget_lines ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE biz.budget_lines ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Backfill tenant_id from budgets for existing rows
UPDATE biz.budget_lines bl
SET tenant_id = b.tenant_id
FROM biz.budgets b
WHERE bl.budget_id = b.id AND bl.tenant_id IS NULL;

------------------------------------------------------------
-- ADDITIONAL COLUMNS for budgets (used by code)
------------------------------------------------------------
ALTER TABLE biz.budgets ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'HKD';
ALTER TABLE biz.budgets ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE biz.budgets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

------------------------------------------------------------
-- ADDITIONAL COLUMNS for journal_lines (tenant_id used by code)
------------------------------------------------------------
ALTER TABLE biz.journal_lines ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES biz.tenants(id);
ALTER TABLE biz.journal_lines ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- Backfill tenant_id from journal_entries for existing rows
UPDATE biz.journal_lines jl
SET tenant_id = je.tenant_id
FROM biz.journal_entries je
WHERE jl.journal_entry_id = je.id AND jl.tenant_id IS NULL;

------------------------------------------------------------
-- ADDITIONAL COLUMNS for payroll_runs (used by code)
------------------------------------------------------------
ALTER TABLE biz.payroll_runs ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE biz.payroll_runs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
