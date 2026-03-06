-- migrations/004_seed_cn_defaults.sql
-- Seed CN chart of accounts (ASBE), CN tax rates, CN social insurance defaults
-- Run with: psql ... -v tenant_id="'<uuid>'" -f migrations/004_seed_cn_defaults.sql

------------------------------------------------------------
-- CN ASBE Chart of Accounts (standard codes)
------------------------------------------------------------
INSERT INTO biz.chart_of_accounts (tenant_id, code, name, type) VALUES
  -- Assets (1xxx)
  (:tenant_id, '1001', '库存现金 (Cash on Hand)', 'asset'),
  (:tenant_id, '1002', '银行存款 (Bank Deposits)', 'asset'),
  (:tenant_id, '1012', '其他货币资金 (Other Monetary Assets)', 'asset'),
  (:tenant_id, '1101', '交易性金融资产 (Trading Financial Assets)', 'asset'),
  (:tenant_id, '1121', '应收票据 (Notes Receivable)', 'asset'),
  (:tenant_id, '1122', '应收账款 (Accounts Receivable)', 'asset'),
  (:tenant_id, '1123', '预付账款 (Advances to Suppliers)', 'asset'),
  (:tenant_id, '1131', '应收股利 (Dividends Receivable)', 'asset'),
  (:tenant_id, '1132', '应收利息 (Interest Receivable)', 'asset'),
  (:tenant_id, '1221', '其他应收款 (Other Receivables)', 'asset'),
  (:tenant_id, '1401', '材料采购 (Materials Procurement)', 'asset'),
  (:tenant_id, '1403', '原材料 (Raw Materials)', 'asset'),
  (:tenant_id, '1405', '库存商品 (Finished Goods)', 'asset'),
  (:tenant_id, '1601', '固定资产 (Fixed Assets)', 'asset'),
  (:tenant_id, '1602', '累计折旧 (Accumulated Depreciation)', 'asset'),
  (:tenant_id, '1701', '无形资产 (Intangible Assets)', 'asset'),
  -- Liabilities (2xxx)
  (:tenant_id, '2001', '短期借款 (Short-term Loans)', 'liability'),
  (:tenant_id, '2201', '应付票据 (Notes Payable)', 'liability'),
  (:tenant_id, '2202', '应付账款 (Accounts Payable)', 'liability'),
  (:tenant_id, '2203', '预收账款 (Advances from Customers)', 'liability'),
  (:tenant_id, '2211', '应付职工薪酬 (Employee Compensation Payable)', 'liability'),
  (:tenant_id, '2221', '应交税费 (Taxes Payable)', 'liability'),
  (:tenant_id, '2241', '其他应付款 (Other Payables)', 'liability'),
  (:tenant_id, '2501', '长期借款 (Long-term Loans)', 'liability'),
  -- Equity (3xxx)
  (:tenant_id, '3001', '实收资本 (Paid-in Capital)', 'equity'),
  (:tenant_id, '3002', '资本公积 (Capital Reserve)', 'equity'),
  (:tenant_id, '3101', '盈余公积 (Surplus Reserve)', 'equity'),
  (:tenant_id, '3104', '本年利润 (Current Year Profit)', 'equity'),
  (:tenant_id, '3131', '利润分配 (Profit Distribution)', 'equity'),
  -- Revenue (6xxx)
  (:tenant_id, '6001', '主营业务收入 (Main Business Revenue)', 'revenue'),
  (:tenant_id, '6051', '其他业务收入 (Other Business Revenue)', 'revenue'),
  (:tenant_id, '6111', '投资收益 (Investment Income)', 'revenue'),
  (:tenant_id, '6301', '营业外收入 (Non-operating Income)', 'revenue'),
  -- Expenses (6xxx range continued)
  (:tenant_id, '6401', '主营业务成本 (Main Business Costs)', 'expense'),
  (:tenant_id, '6402', '其他业务成本 (Other Business Costs)', 'expense'),
  (:tenant_id, '6403', '营业税金及附加 (Business Taxes & Surcharges)', 'expense'),
  (:tenant_id, '6601', '销售费用 (Selling Expenses)', 'expense'),
  (:tenant_id, '6602', '管理费用 (Administrative Expenses)', 'expense'),
  (:tenant_id, '6603', '财务费用 (Finance Expenses)', 'expense'),
  (:tenant_id, '6711', '营业外支出 (Non-operating Expenses)', 'expense'),
  (:tenant_id, '6801', '所得税费用 (Income Tax Expense)', 'expense')
ON CONFLICT (tenant_id, code) DO NOTHING;

------------------------------------------------------------
-- CN Tax Rates
------------------------------------------------------------
INSERT INTO biz.tax_rates (tenant_id, name, type, rate, jurisdiction, effective_from) VALUES
  (:tenant_id, 'CN CIT Standard (25%)', 'profits', 0.25000, 'CN', '2024-01-01'),
  (:tenant_id, 'CN CIT Small/Micro (5% effective)', 'profits', 0.05000, 'CN', '2024-01-01'),
  (:tenant_id, 'CN CIT High-Tech (15%)', 'profits', 0.15000, 'CN', '2024-01-01'),
  (:tenant_id, 'CN VAT General (13%)', 'VAT', 0.13000, 'CN', '2024-01-01'),
  (:tenant_id, 'CN VAT General (9%)', 'VAT', 0.09000, 'CN', '2024-01-01'),
  (:tenant_id, 'CN VAT General (6%)', 'VAT', 0.06000, 'CN', '2024-01-01'),
  (:tenant_id, 'CN VAT Small-Scale (3%)', 'VAT', 0.03000, 'CN', '2024-01-01'),
  (:tenant_id, 'CN IIT (Individual Income Tax)', 'income', 0.00000, 'CN', '2024-01-01');

------------------------------------------------------------
-- CN Social Insurance Default Rates (by city)
------------------------------------------------------------
-- Default (national baseline)
INSERT INTO biz.cn_social_insurance_rates (tenant_id, city,
  pension_employee, pension_employer, medical_employee, medical_employer,
  unemployment_employee, unemployment_employer, work_injury_employer, maternity_employer,
  housing_fund_employee, housing_fund_employer,
  pension_base_min, pension_base_max, housing_base_min, housing_base_max,
  effective_from)
VALUES
  (:tenant_id, 'default',
   0.0800, 0.1600, 0.0200, 0.0800,
   0.0050, 0.0050, 0.0040, 0.0080,
   0.0700, 0.0700,
   0, 0, 0, 0,
   '2024-01-01'),
  (:tenant_id, 'shanghai',
   0.0800, 0.1600, 0.0200, 0.0950,
   0.0050, 0.0050, 0.0026, 0.0100,
   0.0700, 0.0700,
   7310, 36549, 2690, 36549,
   '2024-01-01'),
  (:tenant_id, 'beijing',
   0.0800, 0.1600, 0.0200, 0.0900,
   0.0050, 0.0050, 0.0040, 0.0080,
   0.0700, 0.1200,
   6326, 33891, 2420, 33891,
   '2024-01-01'),
  (:tenant_id, 'shenzhen',
   0.0800, 0.1500, 0.0200, 0.0520,
   0.0050, 0.0070, 0.0020, 0.0045,
   0.0500, 0.0500,
   2360, 27501, 2360, 41544,
   '2024-01-01')
ON CONFLICT (tenant_id, city, effective_from) DO NOTHING;
