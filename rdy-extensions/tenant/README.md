# rdy-tenant — Multi-Channel Tenant Resolver

OpenClaw extension that resolves incoming messages to tenant accounts across multiple channels (WhatsApp, WeCom, WeCom KF) and enforces monthly fair-use message limits.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌────────────┐
│  WhatsApp    │────▶│                  │────▶│  tenants   │
│  WeCom Agent │────▶│  rdy-tenant      │     │  table     │
│  WeCom KF    │────▶│  plugin          │     └────────────┘
└─────────────┘     │                  │          ▲
                    │  extractIdentity │     ┌────┴───────────────┐
                    │  resolveByIdent  │────▶│ tenant_identities  │
                    │  checkUsage      │     │ (channel,uid → tid)│
                    │  injectContext   │     └────────────────────┘
                    └──────────────────┘          │
                                            ┌────▼───────────────┐
                                            │  tenant_usage      │
                                            │  (tid,period → cnt)│
                                            └────────────────────┘
```

## Tables

### `tenant_identities`

Maps channel-specific user IDs to tenant UUIDs. Composite PK `(channel, channel_uid)`.

| Column      | Type   | Description                                    |
|-------------|--------|------------------------------------------------|
| tenant_id   | uuid   | FK → tenants(id)                               |
| channel     | text   | `whatsapp`, `wecom`, or `wecom-kf`             |
| channel_uid | text   | E.164 phone (whatsapp), UserId (wecom), external_userid (wecom-kf) |
| created_at  | timestamptz | Auto-set on insert                         |

### `tenant_usage`

Monthly message counters per tenant. Composite PK `(tenant_id, period)`.

| Column    | Type    | Description                          |
|-----------|---------|--------------------------------------|
| tenant_id | uuid   | FK → tenants(id)                     |
| period    | text    | `YYYY-MM` in Asia/Hong_Kong timezone |
| msg_count | integer | Messages sent this period            |

## Hooks

| Hook                | Purpose                                                    |
|---------------------|------------------------------------------------------------|
| `message_received`  | Extract identity, resolve tenant, increment usage, check limit |
| `before_prompt_build` | Inject workspace context or rate-limit prompt            |
| `before_tool_call`  | Auto-inject `workspace_id` into business tools             |

## Tools

| Tool               | Description                                                   |
|--------------------|---------------------------------------------------------------|
| `link_identity`    | Link a WeCom user to their tenant via registered phone number |
| `switch_workspace` | Switch active business context (golf/racing)                  |
| `list_workspaces`  | List businesses owned by the current user                     |

## Commands

| Command   | Description       |
|-----------|-------------------|
| `/golf`   | Switch to golf    |
| `/racing` | Switch to racing  |

## Rate Limits

Monthly message caps by plan (enforced on cloud channels only):

| Plan       | Monthly Limit |
|------------|---------------|
| starter    | 200           |
| pro        | 1,000         |
| enterprise | 5,000         |

When exceeded, the agent receives a system prompt instructing it to politely inform the user.

## Identity Resolution Flow

1. `message_received` extracts `ChannelIdentity` from `event.from`:
   - `wecom-kf:wmXXX` → `{channel: "wecom-kf", channelUid: "wmXXX"}`
   - `wecom:SamAu` → `{channel: "wecom", channelUid: "SamAu"}`
   - `+852...` → `{channel: "whatsapp", channelUid: "+852..."}`
2. Looks up `tenant_identities` table
3. Falls back to `tenants.phone` for WhatsApp (auto-backfills identity row)
4. If no tenant found, the agent can ask the user for their phone and call `link_identity`

## WeCom Onboarding Flow

```
User (WeCom) → sends message → no tenant found
Agent → "What's your registered WhatsApp number?"
User → "+85293830979"
Agent → calls link_identity({phone: "+85293830979"})
Plugin → creates tenant_identities row → warms cache
Agent → "Linked! You now have access to: golf, racing."
```

## Deployment

Plugin lives at `~/.openclaw/extensions/rdy-tenant/` on lionclaw (100.113.161.109).

```bash
# Deploy updated code
scp index.ts 100.113.161.109:~/.openclaw/extensions/rdy-tenant/index.ts

# Restart
ssh 100.113.161.109 'systemctl --user restart openclaw-lion'

# Verify
ssh 100.113.161.109 'journalctl --user -u openclaw-lion --since "1 min ago" | grep rdy-tenant'
```

## Verification Queries

```sql
-- Check identity mappings
SELECT * FROM tenant_identities;

-- Check usage counters
SELECT * FROM tenant_usage;

-- Check a specific user's usage
SELECT t.name, tu.period, tu.msg_count, t.plan
FROM tenant_usage tu JOIN tenants t ON t.id = tu.tenant_id;
```
