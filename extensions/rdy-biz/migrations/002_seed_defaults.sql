-- migrations/002_seed_defaults.sql
-- Default chart of accounts (HK SME) and tax rates
-- Run with: psql ... -v tenant_id="'a65d382f-0343-4267-bcd9-c4c97590fabf'" -f migrations/002_seed_defaults.sql

-- Assets (1xxx)
INSERT INTO biz.chart_of_accounts (tenant_id, code, name, type) VALUES
  (:tenant_id, '1000', 'Cash and Bank', 'asset'),
  (:tenant_id, '1010', 'Petty Cash', 'asset'),
  (:tenant_id, '1100', 'Accounts Receivable', 'asset'),
  (:tenant_id, '1200', 'Inventory', 'asset'),
  (:tenant_id, '1300', 'Prepaid Expenses', 'asset'),
  (:tenant_id, '1500', 'Fixed Assets', 'asset'),
  (:tenant_id, '1510', 'Accumulated Depreciation', 'asset'),
-- Liabilities (2xxx)
  (:tenant_id, '2000', 'Accounts Payable', 'liability'),
  (:tenant_id, '2100', 'Accrued Liabilities', 'liability'),
  (:tenant_id, '2200', 'Tax Payable', 'liability'),
  (:tenant_id, '2300', 'MPF Payable', 'liability'),
  (:tenant_id, '2500', 'Loans Payable', 'liability'),
-- Equity (3xxx)
  (:tenant_id, '3000', 'Share Capital', 'equity'),
  (:tenant_id, '3100', 'Retained Earnings', 'equity'),
-- Revenue (4xxx)
  (:tenant_id, '4000', 'Sales Revenue', 'revenue'),
  (:tenant_id, '4100', 'Service Revenue', 'revenue'),
  (:tenant_id, '4200', 'Other Income', 'revenue'),
-- Expenses (5xxx)
  (:tenant_id, '5000', 'Cost of Goods Sold', 'expense'),
  (:tenant_id, '5100', 'Salaries & Wages', 'expense'),
  (:tenant_id, '5110', 'MPF Contributions', 'expense'),
  (:tenant_id, '5200', 'Rent', 'expense'),
  (:tenant_id, '5300', 'Utilities', 'expense'),
  (:tenant_id, '5400', 'Office Supplies', 'expense'),
  (:tenant_id, '5500', 'Marketing & Advertising', 'expense'),
  (:tenant_id, '5600', 'Professional Fees', 'expense'),
  (:tenant_id, '5700', 'Depreciation', 'expense'),
  (:tenant_id, '5800', 'Travel & Entertainment', 'expense'),
  (:tenant_id, '5900', 'Miscellaneous Expenses', 'expense');

-- Default HK tax rates
INSERT INTO biz.tax_rates (tenant_id, name, type, rate, jurisdiction, effective_from) VALUES
  (:tenant_id, 'HK Profits Tax (Standard)', 'profits', 0.16500, 'HK', '2024-04-01'),
  (:tenant_id, 'HK Profits Tax (Reduced)', 'profits', 0.08250, 'HK', '2024-04-01'),
  (:tenant_id, 'MPF Employee', 'income', 0.05000, 'HK', '2024-01-01'),
  (:tenant_id, 'MPF Employer', 'income', 0.05000, 'HK', '2024-01-01');

-- Default leave balances setup (annual leave for HK)
-- These would be created per-employee; this is a template reference
-- HK statutory: 7 days after 12 months, increasing to 14 days after 9 years
