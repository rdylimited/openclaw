-- Migration: Multi-Channel Identity + Fair-Use Rate Limiting
-- Run against: rdycore DB
-- Date: 2026-03-01

-- Polymorphic identity table: maps channel+uid pairs to tenants
CREATE TABLE tenant_identities (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel     text NOT NULL,   -- 'whatsapp' | 'wecom' | 'wecom-kf'
  channel_uid text NOT NULL,   -- E.164 phone for whatsapp, UserId for wecom, external_userid for wecom-kf
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, channel_uid)
);
CREATE INDEX idx_tenant_identities_tenant ON tenant_identities(tenant_id);

-- Seed existing WhatsApp identities from tenants.phone
INSERT INTO tenant_identities (tenant_id, channel, channel_uid)
SELECT id, 'whatsapp', phone FROM tenants
ON CONFLICT DO NOTHING;

-- Monthly usage counters for fair-use rate limiting
CREATE TABLE tenant_usage (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period    text NOT NULL,     -- 'YYYY-MM' in Asia/Hong_Kong timezone
  msg_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period)
);
