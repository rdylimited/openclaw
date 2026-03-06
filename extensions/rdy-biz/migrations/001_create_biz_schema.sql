-- migrations/001_create_biz_schema.sql
-- OpenClaw Business Suite — Full Schema

CREATE SCHEMA IF NOT EXISTS biz;

-- Enable RLS on all tables (applied per-table below)
ALTER DEFAULT PRIVILEGES IN SCHEMA biz GRANT ALL ON TABLES TO authenticated;

------------------------------------------------------------
-- CORE TABLES
------------------------------------------------------------

CREATE TABLE biz.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  settings JSONB DEFAULT '{}',
  default_currency TEXT DEFAULT 'HKD',
  fiscal_year_start TEXT DEFAULT '04-01',
  timezone TEXT DEFAULT 'Asia/Hong_Kong',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_audit_tenant_entity ON biz.audit_log(tenant_id, entity_type, entity_id);

CREATE TABLE biz.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT,
  storage_path TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  source_type TEXT,
  source_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_documents_tenant ON biz.documents(tenant_id, type);

CREATE TABLE biz.document_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  body_html TEXT NOT NULL,
  variables_schema JSONB DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES biz.documents(id),
  version INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  changed_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

------------------------------------------------------------
-- APPROVAL / WORKFLOW TABLES
------------------------------------------------------------

CREATE TABLE biz.approval_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  document_type TEXT NOT NULL,
  threshold_amount NUMERIC(19,4),
  approver_chain JSONB DEFAULT '[]',
  auto_approve_below NUMERIC(19,4),
  mode TEXT DEFAULT 'sequential',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_by TEXT NOT NULL,
  approver_chain JSONB DEFAULT '[]',
  current_step INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_approvals_tenant_status ON biz.approvals(tenant_id, status);

CREATE TABLE biz.approval_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID NOT NULL REFERENCES biz.approvals(id),
  step INTEGER NOT NULL,
  approver_id TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'pending',
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.notification_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient_rule JSONB,
  template TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  rule_id UUID REFERENCES biz.notification_rules(id),
  recipient TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT DEFAULT 'sent',
  sent_at TIMESTAMPTZ DEFAULT now()
);

------------------------------------------------------------
-- CRM TABLES
------------------------------------------------------------

CREATE TABLE biz.companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  name TEXT NOT NULL,
  tax_id TEXT,
  address JSONB,
  type TEXT NOT NULL DEFAULT 'customer',
  phone TEXT,
  email TEXT,
  website TEXT,
  notes TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_companies_tenant ON biz.companies(tenant_id, type);

CREATE TABLE biz.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  type TEXT NOT NULL DEFAULT 'customer',
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company_id UUID REFERENCES biz.companies(id),
  position TEXT,
  address JSONB,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_contacts_tenant ON biz.contacts(tenant_id, type);
CREATE INDEX idx_contacts_name ON biz.contacts(tenant_id, name);

CREATE TABLE biz.contact_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES biz.contacts(id),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  note TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

------------------------------------------------------------
-- FINANCE TABLES
------------------------------------------------------------

CREATE TABLE biz.fiscal_years (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.currencies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT,
  decimal_places INTEGER DEFAULT 2
);
INSERT INTO biz.currencies VALUES
  ('HKD','Hong Kong Dollar','$',2),('USD','US Dollar','$',2),
  ('EUR','Euro','€',2),('GBP','British Pound','£',2),
  ('CNY','Chinese Yuan','¥',2),('JPY','Japanese Yen','¥',0);

CREATE TABLE biz.exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  from_currency TEXT NOT NULL REFERENCES biz.currencies(code),
  to_currency TEXT NOT NULL REFERENCES biz.currencies(code),
  rate NUMERIC(19,8) NOT NULL,
  effective_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.chart_of_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  parent_id UUID REFERENCES biz.chart_of_accounts(id),
  description TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, code)
);

CREATE TABLE biz.journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  date DATE NOT NULL,
  memo TEXT,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','posted','reversed')),
  source_type TEXT,
  source_id TEXT,
  currency TEXT DEFAULT 'HKD' REFERENCES biz.currencies(code),
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  posted_at TIMESTAMPTZ
);
CREATE INDEX idx_journal_tenant_date ON biz.journal_entries(tenant_id, date);

CREATE TABLE biz.journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES biz.journal_entries(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES biz.chart_of_accounts(id),
  debit NUMERIC(19,4) DEFAULT 0,
  credit NUMERIC(19,4) DEFAULT 0,
  description TEXT,
  CHECK (debit >= 0 AND credit >= 0),
  CHECK (NOT (debit > 0 AND credit > 0))
);

CREATE TABLE biz.expense_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  name TEXT NOT NULL,
  account_id UUID REFERENCES biz.chart_of_accounts(id),
  active BOOLEAN DEFAULT true
);

CREATE TABLE biz.invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  invoice_number TEXT,
  customer_id UUID REFERENCES biz.contacts(id),
  date DATE NOT NULL,
  due_date DATE NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','sent','partial','paid','overdue','void')),
  subtotal NUMERIC(19,4) DEFAULT 0,
  tax_total NUMERIC(19,4) DEFAULT 0,
  total NUMERIC(19,4) DEFAULT 0,
  currency TEXT DEFAULT 'HKD',
  notes TEXT,
  journal_entry_id UUID REFERENCES biz.journal_entries(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, invoice_number)
);

CREATE TABLE biz.invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES biz.invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(19,4) DEFAULT 1,
  unit_price NUMERIC(19,4) NOT NULL,
  tax_rate NUMERIC(5,4) DEFAULT 0,
  amount NUMERIC(19,4) NOT NULL
);

CREATE TABLE biz.bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  bill_number TEXT,
  supplier_id UUID REFERENCES biz.contacts(id),
  po_id UUID,
  date DATE NOT NULL,
  due_date DATE NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','received','partial','paid','overdue','void')),
  subtotal NUMERIC(19,4) DEFAULT 0,
  tax_total NUMERIC(19,4) DEFAULT 0,
  total NUMERIC(19,4) DEFAULT 0,
  currency TEXT DEFAULT 'HKD',
  notes TEXT,
  journal_entry_id UUID REFERENCES biz.journal_entries(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.bill_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id UUID NOT NULL REFERENCES biz.bills(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(19,4) DEFAULT 1,
  unit_price NUMERIC(19,4) NOT NULL,
  tax_rate NUMERIC(5,4) DEFAULT 0,
  amount NUMERIC(19,4) NOT NULL
);

CREATE TABLE biz.quotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  quote_number TEXT,
  customer_id UUID REFERENCES biz.contacts(id),
  date DATE NOT NULL,
  valid_until DATE NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','converted','expired')),
  subtotal NUMERIC(19,4) DEFAULT 0,
  tax_total NUMERIC(19,4) DEFAULT 0,
  total NUMERIC(19,4) DEFAULT 0,
  currency TEXT DEFAULT 'HKD',
  notes TEXT,
  converted_invoice_id UUID REFERENCES biz.invoices(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.quotation_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id UUID NOT NULL REFERENCES biz.quotations(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(19,4) DEFAULT 1,
  unit_price NUMERIC(19,4) NOT NULL,
  tax_rate NUMERIC(5,4) DEFAULT 0,
  amount NUMERIC(19,4) NOT NULL
);

CREATE TABLE biz.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  type TEXT NOT NULL CHECK (type IN ('received','made')),
  contact_id UUID REFERENCES biz.contacts(id),
  amount NUMERIC(19,4) NOT NULL,
  currency TEXT DEFAULT 'HKD',
  method TEXT,
  reference TEXT,
  date DATE NOT NULL,
  allocated_to JSONB DEFAULT '[]',
  journal_entry_id UUID REFERENCES biz.journal_entries(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  name TEXT NOT NULL,
  account_number TEXT,
  bank_name TEXT,
  currency TEXT DEFAULT 'HKD',
  balance NUMERIC(19,4) DEFAULT 0,
  chart_account_id UUID REFERENCES biz.chart_of_accounts(id),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.bank_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  bank_account_id UUID NOT NULL REFERENCES biz.bank_accounts(id),
  date DATE NOT NULL,
  description TEXT,
  amount NUMERIC(19,4) NOT NULL,
  reconciled BOOLEAN DEFAULT false,
  matched_journal_id UUID REFERENCES biz.journal_entries(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  type TEXT NOT NULL CHECK (type IN ('credit','debit')),
  invoice_id UUID REFERENCES biz.invoices(id),
  bill_id UUID REFERENCES biz.bills(id),
  amount NUMERIC(19,4) NOT NULL,
  reason TEXT,
  journal_entry_id UUID REFERENCES biz.journal_entries(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  name TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.budget_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id UUID NOT NULL REFERENCES biz.budgets(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES biz.chart_of_accounts(id),
  amount NUMERIC(19,4) NOT NULL
);

CREATE TABLE biz.recurring_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  template_data JSONB NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly','quarterly','yearly')),
  next_date DATE NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

------------------------------------------------------------
-- PROCUREMENT / INVENTORY TABLES
------------------------------------------------------------

CREATE TABLE biz.suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  company_id UUID REFERENCES biz.companies(id),
  payment_terms TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  lead_time_days INTEGER,
  notes TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  unit TEXT DEFAULT 'pcs',
  cost_price NUMERIC(19,4),
  sell_price NUMERIC(19,4),
  description TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, sku)
);

CREATE TABLE biz.purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  po_number TEXT,
  supplier_id UUID REFERENCES biz.suppliers(id),
  date DATE NOT NULL,
  expected_date DATE,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','sent','partial','received','closed','cancelled')),
  subtotal NUMERIC(19,4) DEFAULT 0,
  tax_total NUMERIC(19,4) DEFAULT 0,
  total NUMERIC(19,4) DEFAULT 0,
  currency TEXT DEFAULT 'HKD',
  notes TEXT,
  approval_id UUID REFERENCES biz.approvals(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, po_number)
);

CREATE TABLE biz.po_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES biz.purchase_orders(id) ON DELETE CASCADE,
  item_id UUID REFERENCES biz.inventory_items(id),
  description TEXT NOT NULL,
  quantity NUMERIC(19,4) NOT NULL,
  unit_price NUMERIC(19,4) NOT NULL,
  tax_rate NUMERIC(5,4) DEFAULT 0,
  amount NUMERIC(19,4) NOT NULL,
  received_qty NUMERIC(19,4) DEFAULT 0
);

CREATE TABLE biz.bom_headers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  name TEXT NOT NULL,
  item_id UUID REFERENCES biz.inventory_items(id),
  version INTEGER DEFAULT 1,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','active','obsolete')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.bom_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_header_id UUID NOT NULL REFERENCES biz.bom_headers(id) ON DELETE CASCADE,
  item_id UUID REFERENCES biz.inventory_items(id),
  description TEXT,
  quantity NUMERIC(19,4) NOT NULL,
  unit TEXT DEFAULT 'pcs',
  child_bom_id UUID REFERENCES biz.bom_headers(id),
  level INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE biz.supplier_quotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  supplier_id UUID REFERENCES biz.suppliers(id),
  items JSONB NOT NULL DEFAULT '[]',
  valid_until DATE,
  total NUMERIC(19,4),
  status TEXT DEFAULT 'received',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.goods_received_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  grn_number TEXT,
  po_id UUID REFERENCES biz.purchase_orders(id),
  date DATE NOT NULL,
  status TEXT DEFAULT 'draft',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.grn_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_id UUID NOT NULL REFERENCES biz.goods_received_notes(id) ON DELETE CASCADE,
  po_line_id UUID REFERENCES biz.po_lines(id),
  item_id UUID REFERENCES biz.inventory_items(id),
  received_qty NUMERIC(19,4) NOT NULL,
  accepted_qty NUMERIC(19,4) NOT NULL,
  rejected_qty NUMERIC(19,4) DEFAULT 0
);

CREATE TABLE biz.reorder_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  item_id UUID NOT NULL REFERENCES biz.inventory_items(id),
  warehouse_id UUID,
  min_level NUMERIC(19,4) NOT NULL,
  reorder_qty NUMERIC(19,4) NOT NULL,
  supplier_id UUID REFERENCES biz.suppliers(id),
  active BOOLEAN DEFAULT true
);

------------------------------------------------------------
-- OPERATIONS TABLES
------------------------------------------------------------

CREATE TABLE biz.warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  name TEXT NOT NULL,
  address JSONB,
  type TEXT DEFAULT 'warehouse' CHECK (type IN ('warehouse','store','transit')),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.stock_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  item_id UUID NOT NULL REFERENCES biz.inventory_items(id),
  warehouse_id UUID NOT NULL REFERENCES biz.warehouses(id),
  quantity NUMERIC(19,4) DEFAULT 0,
  reserved_qty NUMERIC(19,4) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, item_id, warehouse_id)
);

CREATE TABLE biz.stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  item_id UUID NOT NULL REFERENCES biz.inventory_items(id),
  from_warehouse_id UUID REFERENCES biz.warehouses(id),
  to_warehouse_id UUID REFERENCES biz.warehouses(id),
  quantity NUMERIC(19,4) NOT NULL,
  reason TEXT,
  reference_type TEXT,
  reference_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  type TEXT NOT NULL CHECK (type IN ('inbound','outbound')),
  carrier TEXT,
  tracking_number TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','picked_up','in_transit','delivered','returned','cancelled')),
  origin JSONB,
  destination JSONB,
  contact_id UUID REFERENCES biz.contacts(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.shipment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id UUID NOT NULL REFERENCES biz.shipments(id),
  status TEXT NOT NULL,
  location TEXT,
  notes TEXT,
  timestamp TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.shipment_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id UUID NOT NULL REFERENCES biz.shipments(id),
  item_id UUID REFERENCES biz.inventory_items(id),
  description TEXT,
  quantity NUMERIC(19,4) NOT NULL
);

CREATE TABLE biz.delivery_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  shipment_id UUID REFERENCES biz.shipments(id),
  items JSONB NOT NULL DEFAULT '[]',
  pdf_document_id UUID REFERENCES biz.documents(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  contact_id UUID REFERENCES biz.contacts(id),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','cancelled','completed','no_show')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.reservation_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  date DATE NOT NULL,
  capacity INTEGER NOT NULL,
  booked INTEGER DEFAULT 0
);

CREATE TABLE biz.assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  name TEXT NOT NULL,
  category TEXT,
  purchase_date DATE NOT NULL,
  cost NUMERIC(19,4) NOT NULL,
  salvage_value NUMERIC(19,4) DEFAULT 0,
  useful_life_months INTEGER NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','disposed','fully_depreciated')),
  location TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.asset_depreciation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES biz.assets(id),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  period DATE NOT NULL,
  method TEXT DEFAULT 'straight_line',
  amount NUMERIC(19,4) NOT NULL,
  accumulated NUMERIC(19,4) NOT NULL,
  book_value NUMERIC(19,4) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

------------------------------------------------------------
-- HR TABLES
------------------------------------------------------------

CREATE TABLE biz.departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  name TEXT NOT NULL,
  parent_id UUID REFERENCES biz.departments(id),
  manager_employee_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  contact_id UUID REFERENCES biz.contacts(id),
  employee_number TEXT,
  department_id UUID REFERENCES biz.departments(id),
  position TEXT,
  hire_date DATE NOT NULL,
  termination_date DATE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','on_leave','terminated','probation')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, employee_number)
);

ALTER TABLE biz.departments ADD CONSTRAINT fk_dept_manager
  FOREIGN KEY (manager_employee_id) REFERENCES biz.employees(id);

CREATE TABLE biz.contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  employee_id UUID NOT NULL REFERENCES biz.employees(id),
  type TEXT NOT NULL CHECK (type IN ('permanent','fixed_term','part_time','contractor')),
  start_date DATE NOT NULL,
  end_date DATE,
  salary NUMERIC(19,4) NOT NULL,
  salary_currency TEXT DEFAULT 'HKD',
  pay_frequency TEXT DEFAULT 'monthly' CHECK (pay_frequency IN ('weekly','biweekly','monthly')),
  terms JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active' CHECK (status IN ('active','expired','terminated')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.payroll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','calculated','approved','paid','cancelled')),
  total_gross NUMERIC(19,4) DEFAULT 0,
  total_deductions NUMERIC(19,4) DEFAULT 0,
  total_tax NUMERIC(19,4) DEFAULT 0,
  total_net NUMERIC(19,4) DEFAULT 0,
  approval_id UUID REFERENCES biz.approvals(id),
  journal_entry_id UUID REFERENCES biz.journal_entries(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.payroll_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id UUID NOT NULL REFERENCES biz.payroll_runs(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES biz.employees(id),
  gross NUMERIC(19,4) NOT NULL,
  deductions JSONB DEFAULT '{}',
  tax NUMERIC(19,4) DEFAULT 0,
  net NUMERIC(19,4) NOT NULL,
  bank_account TEXT,
  notes TEXT
);

CREATE TABLE biz.leave_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  employee_id UUID NOT NULL REFERENCES biz.employees(id),
  leave_type TEXT NOT NULL,
  year INTEGER NOT NULL,
  entitled NUMERIC(5,1) NOT NULL,
  used NUMERIC(5,1) DEFAULT 0,
  remaining NUMERIC(5,1) NOT NULL,
  UNIQUE(tenant_id, employee_id, leave_type, year)
);

CREATE TABLE biz.leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  employee_id UUID NOT NULL REFERENCES biz.employees(id),
  leave_type TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days NUMERIC(5,1) NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  approval_id UUID REFERENCES biz.approvals(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  employee_id UUID NOT NULL REFERENCES biz.employees(id),
  date DATE NOT NULL,
  clock_in TIMESTAMPTZ,
  clock_out TIMESTAMPTZ,
  hours_worked NUMERIC(5,2),
  overtime NUMERIC(5,2) DEFAULT 0,
  notes TEXT,
  UNIQUE(tenant_id, employee_id, date)
);

CREATE TABLE biz.expense_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  employee_id UUID NOT NULL REFERENCES biz.employees(id),
  date DATE NOT NULL,
  items JSONB NOT NULL DEFAULT '[]',
  total NUMERIC(19,4) NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','reimbursed')),
  approval_id UUID REFERENCES biz.approvals(id),
  journal_entry_id UUID REFERENCES biz.journal_entries(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.benefits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  employee_id UUID NOT NULL REFERENCES biz.employees(id),
  benefit_type TEXT NOT NULL,
  provider TEXT,
  start_date DATE NOT NULL,
  end_date DATE,
  employer_cost NUMERIC(19,4) DEFAULT 0,
  employee_cost NUMERIC(19,4) DEFAULT 0,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.performance_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  employee_id UUID NOT NULL REFERENCES biz.employees(id),
  reviewer_id UUID REFERENCES biz.employees(id),
  period TEXT NOT NULL,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  notes TEXT,
  goals JSONB DEFAULT '[]',
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','submitted','acknowledged')),
  created_at TIMESTAMPTZ DEFAULT now()
);

------------------------------------------------------------
-- TAX TABLES
------------------------------------------------------------

CREATE TABLE biz.tax_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('GST','VAT','WHT','income','profits','sales')),
  rate NUMERIC(8,5) NOT NULL,
  jurisdiction TEXT,
  effective_from DATE NOT NULL,
  effective_to DATE,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.tax_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  tax_rate_id UUID NOT NULL REFERENCES biz.tax_rates(id),
  applies_to TEXT NOT NULL CHECK (applies_to IN ('sales','purchases','payroll','all')),
  category_filter JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.tax_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  jurisdiction TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT DEFAULT 'open' CHECK (status IN ('open','calculated','filed','assessed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.tax_calculations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  tax_period_id UUID NOT NULL REFERENCES biz.tax_periods(id),
  type TEXT NOT NULL,
  taxable_amount NUMERIC(19,4) NOT NULL,
  tax_amount NUMERIC(19,4) NOT NULL,
  supporting_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.tax_filings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  tax_period_id UUID NOT NULL REFERENCES biz.tax_periods(id),
  filed_date DATE,
  reference_number TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','filed','accepted','rejected')),
  document_id UUID REFERENCES biz.documents(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.withholding_tax (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  payment_id UUID REFERENCES biz.payments(id),
  tax_rate_id UUID REFERENCES biz.tax_rates(id),
  gross_amount NUMERIC(19,4) NOT NULL,
  wht_amount NUMERIC(19,4) NOT NULL,
  certificate_number TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE biz.tax_deductions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES biz.tenants(id),
  tax_period_id UUID REFERENCES biz.tax_periods(id),
  description TEXT NOT NULL,
  amount NUMERIC(19,4) NOT NULL,
  category TEXT,
  supporting_doc_id UUID REFERENCES biz.documents(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

------------------------------------------------------------
-- ROW LEVEL SECURITY
------------------------------------------------------------

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'biz' AND tablename != 'currencies'
  LOOP
    EXECUTE format('ALTER TABLE biz.%I ENABLE ROW LEVEL SECURITY', tbl);
    -- Only apply tenant policy to tables that have tenant_id
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'biz' AND table_name = tbl AND column_name = 'tenant_id'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON biz.%I USING (tenant_id::text = current_setting(''app.tenant_id'', true))',
        tbl
      );
    END IF;
  END LOOP;
END $$;

------------------------------------------------------------
-- DOUBLE-ENTRY VALIDATION FUNCTION
-- Called when posting a journal entry (status → 'posted'),
-- NOT on individual line inserts (which would fail mid-batch).
------------------------------------------------------------

CREATE OR REPLACE FUNCTION biz.validate_journal_balance()
RETURNS TRIGGER AS $$
BEGIN
  -- Only validate when posting
  IF NEW.status = 'posted' AND (OLD.status IS NULL OR OLD.status != 'posted') THEN
    IF (
      SELECT ABS(COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0)) > 0.001
      FROM biz.journal_lines
      WHERE journal_entry_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Journal entry % is not balanced: debits must equal credits', NEW.id;
    END IF;
    -- Also ensure at least one line exists
    IF NOT EXISTS (SELECT 1 FROM biz.journal_lines WHERE journal_entry_id = NEW.id) THEN
      RAISE EXCEPTION 'Journal entry % has no lines', NEW.id;
    END IF;
    NEW.posted_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_journal_balance
  BEFORE UPDATE ON biz.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION biz.validate_journal_balance();
