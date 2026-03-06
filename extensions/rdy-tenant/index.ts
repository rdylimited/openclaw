import pg from "pg";

// Always use direct PostgreSQL (port 5433), not Supavisor pooler (5432)
// which rejects connections with "Tenant or user not found"
const PG_URL =
  "postgresql://postgres:8b309fab0813a258592d0f849c5e8a3f0498ccc4427d88f5@100.120.14.56:5433/rdycore";

const pool = new pg.Pool({ connectionString: PG_URL, max: 3 });

// --- Constants ---

const PLAN_LIMITS: Record<string, number> = {
  starter: 200,
  pro: 1000,
  enterprise: 5000,
};
const CLOUD_CHANNELS = new Set(["whatsapp", "wecom", "wecom-kf"]);

// --- Types ---

interface Tenant {
  id: string;
  phone: string;
  name: string;
  plan: string;
}

interface Workspace {
  id: string;
  slug: string;
  name: string;
  vertical: string;
  db_name: string;
  config: Record<string, unknown>;
}

interface TenantContext {
  tenant: Tenant;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

interface ChannelIdentity {
  channel: string;
  channelUid: string;
}

interface OverLimitInfo {
  count: number;
  limit: number;
  plan: string;
}

// --- Caches (keyed by tenant UUID) ---

const tenantCache = new Map<string, TenantContext>();
const sessionTenantMap = new Map<string, string>();
const sessionIdentityMap = new Map<string, ChannelIdentity>();
const sessionOverLimitMap = new Map<string, OverLimitInfo>();

// --- DB queries ---

async function resolveTenantByPhone(phone: string): Promise<Tenant | null> {
  const { rows } = await queryDb("SELECT id, phone, name, plan FROM tenants WHERE phone = $1", [
    phone,
  ]);
  return rows[0] ?? null;
}

async function queryDb(sql: string, params: any[]): Promise<any> {
  return pool.query(sql, params);
}

async function resolveTenantByIdentity(
  channel: string,
  channelUid: string,
): Promise<Tenant | null> {
  const { rows } = await queryDb(
    `SELECT t.id, t.phone, t.name, t.plan
     FROM tenant_identities ti
     JOIN tenants t ON t.id = ti.tenant_id
     WHERE ti.channel = $1 AND ti.channel_uid = $2`,
    [channel, channelUid],
  );
  return rows[0] ?? null;
}

async function insertIdentity(
  tenantId: string,
  channel: string,
  channelUid: string,
): Promise<void> {
  await queryDb(
    `INSERT INTO tenant_identities (tenant_id, channel, channel_uid)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [tenantId, channel, channelUid],
  );
}

function currentPeriod(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" }).slice(0, 7); // 'YYYY-MM'
}

async function incrementUsage(tenantId: string): Promise<number> {
  const period = currentPeriod();
  const { rows } = await queryDb(
    `INSERT INTO tenant_usage (tenant_id, period, msg_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, period)
     DO UPDATE SET msg_count = tenant_usage.msg_count + 1
     RETURNING msg_count`,
    [tenantId, period],
  );
  return rows[0].msg_count;
}

async function getUsage(tenantId: string): Promise<number> {
  const period = currentPeriod();
  const { rows } = await queryDb(
    `SELECT msg_count FROM tenant_usage WHERE tenant_id = $1 AND period = $2`,
    [tenantId, period],
  );
  return rows[0]?.msg_count ?? 0;
}

async function getWorkspacesForTenant(tenantId: string): Promise<Workspace[]> {
  const { rows } = await queryDb(
    `SELECT DISTINCT w.id, w.slug, w.name, w.vertical, w.db_name, w.config
     FROM workspaces w
     LEFT JOIN tenant_workspaces tw ON tw.workspace_id = w.id AND tw.tenant_id = $1
     WHERE w.active = true AND (tw.tenant_id IS NOT NULL OR w.tenant_id = $1)`,
    [tenantId],
  );
  return rows;
}

async function getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
  const { rows } = await queryDb(
    "SELECT id, slug, name, vertical, db_name, config FROM workspaces WHERE slug = $1",
    [slug],
  );
  return rows[0] ?? null;
}

// --- Identity extraction ---

function extractPhoneFromSessionKey(sessionKey: string | undefined): string | null {
  if (!sessionKey) return null;
  const parts = sessionKey.split(":");
  for (const part of parts) {
    if (part.startsWith("+") && /^\+\d{8,15}$/.test(part)) {
      return part;
    }
  }
  return null;
}

function extractChannelIdentity(
  event: any,
  sessionKey: string | undefined,
): ChannelIdentity | null {
  const from: string | undefined = event.from;

  if (from) {
    // WeCom KF: "wecom-kf:wmXXX"
    if (from.startsWith("wecom-kf:")) {
      return { channel: "wecom-kf", channelUid: from.slice("wecom-kf:".length) };
    }
    // WeCom internal: "wecom:SamAu"
    if (from.startsWith("wecom:")) {
      return { channel: "wecom", channelUid: from.slice("wecom:".length) };
    }
    // WhatsApp: "+852..."
    if (from.startsWith("+") && /^\+\d{8,15}$/.test(from)) {
      return { channel: "whatsapp", channelUid: from };
    }
  }

  // Fallback: extract phone from session key
  const phone = extractPhoneFromSessionKey(sessionKey);
  if (phone) {
    return { channel: "whatsapp", channelUid: phone };
  }

  return null;
}

// --- Resolve and cache tenant by identity ---

async function resolveAndCacheByIdentity(identity: ChannelIdentity): Promise<TenantContext | null> {
  // Check if any session already resolved this identity → get tenantId
  // (optimization: avoid DB hit if we already know)
  for (const [, tenantId] of sessionTenantMap) {
    const cached = tenantCache.get(tenantId);
    if (cached) {
      // Check if this tenant matches the identity
      // (won't help for new identities, but speeds up repeat calls)
    }
  }

  // 1. Try tenant_identities table
  let tenant = await resolveTenantByIdentity(identity.channel, identity.channelUid);

  // 2. Fallback for WhatsApp: try tenants.phone directly (backward compat)
  if (!tenant && identity.channel === "whatsapp") {
    tenant = await resolveTenantByPhone(identity.channelUid);
    if (tenant) {
      // Backfill identity row silently
      await insertIdentity(tenant.id, "whatsapp", identity.channelUid);
    }
  }

  if (!tenant) return null;

  // Return from cache if already loaded by tenant UUID
  const cached = tenantCache.get(tenant.id);
  if (cached) return cached;

  const workspaces = await getWorkspacesForTenant(tenant.id);
  if (workspaces.length === 0) return null;

  const ctx: TenantContext = {
    tenant,
    workspaces,
    activeWorkspaceId: workspaces.length === 1 ? workspaces[0].id : null,
  };
  tenantCache.set(tenant.id, ctx);
  return ctx;
}

// Thin wrapper for /golf /racing commands that still pass phone
async function resolveAndCache(phone: string): Promise<TenantContext | null> {
  return resolveAndCacheByIdentity({ channel: "whatsapp", channelUid: phone });
}

// --- Prompt builders ---

function verticalLabel(vertical: string): string {
  if (vertical === "sim_golf") return "golf";
  if (vertical === "sim_racing") return "racing";
  return vertical;
}

function buildWorkspacePrompt(tenant: Tenant, workspace: Workspace): string {
  const cfg = workspace.config as Record<string, any>;
  const biz = verticalLabel(workspace.vertical);
  return [
    `[SYSTEM — hidden from user]`,
    `You are the RdyCore business assistant for ${tenant.name}.`,
    `Active business: ${biz}`,
    `Currency: ${cfg?.currency ?? "HKD"} | Timezone: ${cfg?.timezone ?? "Asia/Hong_Kong"}`,
    ``,
    `All tool calls are auto-routed. NEVER mention workspace IDs, slugs, database names, or UUIDs to the user.`,
    ``,
    `The user can say "golf" or "racing" to switch. Keep replies conversational and natural.`,
    `For racing bookings, the user says things like "book rig 1" or "book both rigs". Rigs are rig-1 and rig-2.`,
  ].join("\n");
}

function buildMultiWorkspacePrompt(tenant: Tenant, workspaces: Workspace[]): string {
  const bizNames = workspaces.map((w) => verticalLabel(w.vertical));
  return [
    `[SYSTEM — hidden from user]`,
    `You are the RdyCore business assistant for ${tenant.name}.`,
    `Businesses: ${bizNames.join(", ")}`,
    ``,
    `All tool calls are auto-routed. NEVER mention workspace IDs, slugs, database names, or UUIDs to the user.`,
    ``,
    `RULES:`,
    `- Infer which business the user means from context (e.g. "rig" or "booking for racing" → racing, "lesson" or "bay" → golf).`,
    `- If ambiguous, ask naturally: "Is this for golf or racing?"`,
    `- The user says "golf" or "racing" to switch context.`,
    `- For racing bookings: "book rig 1", "book both rigs", etc. Rigs are rig-1 and rig-2.`,
    `- Keep replies short, conversational, and friendly. No technical jargon.`,
  ].join("\n");
}

function buildRateLimitPrompt(info: OverLimitInfo): string {
  return [
    `[SYSTEM — hidden from user]`,
    `This user has reached their monthly message limit.`,
    `Plan: ${info.plan} | Used: ${info.count}/${info.limit} messages this month.`,
    ``,
    `Politely inform the user they've reached their monthly limit.`,
    `Suggest upgrading their plan or waiting until next month.`,
    `Do NOT process business requests. Keep the reply short and friendly.`,
  ].join("\n");
}

// --- Helpers ---

function text(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// Business tool names that need workspace_id auto-injection
const BUSINESS_TOOLS = new Set([
  "query_bookings",
  "create_booking",
  "check_availability",
  "get_daily_summary",
  "list_resources",
  "cancel_booking",
  "set_rig_status",
  "manage_pricing",
  // Profitability tools
  "manage_costs",
  "manage_goals",
  "take_snapshot",
  "profitability_report",
  "profitability_trend",
  "track_action",
  "generate_report",
  // Phase 2: Operations
  "capacity_forecast",
  "asset_performance",
  "staff_performance",
  // Phase 3: Customer Growth
  "churn_alerts",
  "membership_funnel",
  "segment_analysis",
  "cross_sell_detect",
  "benchmark_compare",
  "break_even_analysis",
  "cash_flow_forecast",
  // Phase 4: External Integrations
  "xero_sync",
  "bank_balance",
  "competitor_import",
]);

// Tools that only make sense for a specific vertical
const RACING_ONLY_TOOLS = new Set(["set_rig_status"]);

function inferVerticalFromParams(toolName: string, params: Record<string, any>): string | null {
  if (RACING_ONLY_TOOLS.has(toolName)) return "sim_racing";
  if (params?.rig_slug || params?.activity_type) return "sim_racing";
  if (params?.service_type) return "sim_golf";
  return null;
}

// --- Tool injection logic ---

function handleToolInjection(event: any, tenantCtx: TenantContext, log: any) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const suppliedId = event.params?.workspace_id;

  if (suppliedId && UUID_RE.test(suppliedId)) return;

  if (suppliedId && !UUID_RE.test(suppliedId)) {
    const input = suppliedId.toLowerCase().trim();
    const match = tenantCtx.workspaces.find(
      (w) =>
        w.slug === input || w.name.toLowerCase() === input || verticalLabel(w.vertical) === input,
    );
    if (match) {
      log.info(
        `[rdy-tenant] resolved "${suppliedId}" → workspace_id=${match.id} for ${event.toolName}`,
      );
      return { params: { ...event.params, workspace_id: match.id } };
    }
  }

  let workspaceId = tenantCtx.activeWorkspaceId;

  if (!workspaceId) {
    const { workspaces } = tenantCtx;

    if (workspaces.length === 1) {
      workspaceId = workspaces[0].id;
    } else {
      const vertical = inferVerticalFromParams(event.toolName, event.params);
      if (vertical) {
        const match = workspaces.find((w) => w.vertical === vertical);
        if (match) workspaceId = match.id;
      }
    }

    if (workspaceId) {
      tenantCtx.activeWorkspaceId = workspaceId;
    }
  }

  if (!workspaceId) return;

  log.info(`[rdy-tenant] auto-injecting workspace_id=${workspaceId} into ${event.toolName}`);

  return {
    params: {
      ...event.params,
      workspace_id: workspaceId,
    },
  };
}

// --- Extension entry point ---

export default function (api: any) {
  const log = api.logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
  };

  // ============================================================
  //  HOOK: message_received — resolve identity → tenant, track usage
  // ============================================================

  api.on("message_received", async (event: any, ctx: any) => {
    log.info(`[rdy-tenant] message_received: from=${event.from}, sessionKey=${ctx.sessionKey}`);
    const identity = extractChannelIdentity(event, ctx.sessionKey);
    if (!identity) {
      log.info(`[rdy-tenant] message_received: no identity extracted, skipping`);
      return;
    }
    log.info(`[rdy-tenant] message_received: identity=${identity.channel}:${identity.channelUid}`);

    // Store raw identity for link_identity tool
    if (ctx.sessionKey) {
      sessionIdentityMap.set(ctx.sessionKey, identity);
    }

    let tenantCtx: TenantContext | null = null;
    try {
      tenantCtx = await resolveAndCacheByIdentity(identity);
    } catch (err: any) {
      log.error(`[rdy-tenant] message_received resolve error: ${err.message}`);
      log.error(`[rdy-tenant] message_received resolve stack: ${err.stack}`);
      return;
    }

    if (tenantCtx) {
      // Map session → tenant UUID
      if (ctx.sessionKey) {
        sessionTenantMap.set(ctx.sessionKey, tenantCtx.tenant.id);
      }

      log.info(
        `[rdy-tenant] resolved tenant "${tenantCtx.tenant.name}" for ${identity.channel}:${identity.channelUid} (session=${ctx.sessionKey})`,
      );

      // Rate limiting for cloud channels
      if (CLOUD_CHANNELS.has(identity.channel)) {
        try {
          const count = await incrementUsage(tenantCtx.tenant.id);
          const limit = PLAN_LIMITS[tenantCtx.tenant.plan] ?? PLAN_LIMITS.starter;

          if (count > limit) {
            log.warn(
              `[rdy-tenant] tenant "${tenantCtx.tenant.name}" over limit: ${count}/${limit} (${tenantCtx.tenant.plan})`,
            );
            if (ctx.sessionKey) {
              sessionOverLimitMap.set(ctx.sessionKey, {
                count,
                limit,
                plan: tenantCtx.tenant.plan,
              });
            }
          } else {
            if (ctx.sessionKey) {
              sessionOverLimitMap.delete(ctx.sessionKey);
            }
          }
        } catch (err: any) {
          log.error(`[rdy-tenant] message_received usage error: ${err.message}`);
        }
      }
    } else {
      log.info(`[rdy-tenant] no tenant found for ${identity.channel}:${identity.channelUid}`);
    }
  });

  // ============================================================
  //  HOOK: before_prompt_build — inject workspace context or rate limit
  // ============================================================

  api.on(
    "before_prompt_build",
    async (event: any, ctx: any) => {
      // Check rate limit first
      const overLimit = sessionOverLimitMap.get(ctx.sessionKey);
      if (overLimit) {
        log.info(`[rdy-tenant] injecting rate-limit prompt for session ${ctx.sessionKey}`);
        return { prependContext: buildRateLimitPrompt(overLimit) };
      }

      // Resolve tenant from session map
      let tenantId = sessionTenantMap.get(ctx.sessionKey);

      // Fallback: try extracting identity from session key
      if (!tenantId) {
        const identity = sessionIdentityMap.get(ctx.sessionKey);
        const fallbackIdentity =
          identity ??
          (() => {
            const phone = extractPhoneFromSessionKey(ctx.sessionKey);
            return phone ? { channel: "whatsapp" as const, channelUid: phone } : null;
          })();

        if (fallbackIdentity) {
          try {
            const tenantCtx = await resolveAndCacheByIdentity(fallbackIdentity);
            if (tenantCtx) {
              tenantId = tenantCtx.tenant.id;
              sessionTenantMap.set(ctx.sessionKey, tenantId);
              sessionIdentityMap.set(ctx.sessionKey, fallbackIdentity);
            }
          } catch {
            // ignore
          }
        }
      }

      if (!tenantId) return;

      try {
        const tenantCtx = tenantCache.get(tenantId);
        if (!tenantCtx) return;

        const { tenant, workspaces, activeWorkspaceId } = tenantCtx;

        let prompt: string;
        if (activeWorkspaceId) {
          const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);
          if (activeWs) {
            prompt = buildWorkspacePrompt(tenant, activeWs);
          } else {
            prompt = buildMultiWorkspacePrompt(tenant, workspaces);
          }
        } else {
          prompt = buildMultiWorkspacePrompt(tenant, workspaces);
        }

        log.info(
          `[rdy-tenant] injecting workspace context for ${tenant.name} into session ${ctx.sessionKey}`,
        );

        return { prependContext: prompt };
      } catch (err: any) {
        log.error(`[rdy-tenant] before_prompt_build error: ${err.message}`);
      }
    },
    { priority: 10 },
  );

  // ============================================================
  //  HOOK: before_tool_call — auto-inject workspace_id
  // ============================================================

  api.on("before_tool_call", async (event: any, ctx: any) => {
    log.info(
      `[rdy-tenant] before_tool_call: tool=${event.toolName}, sessionKey=${ctx.sessionKey}, params=${JSON.stringify(event.params)}`,
    );

    if (!BUSINESS_TOOLS.has(event.toolName)) return;

    // Look up tenant via sessionTenantMap
    let tenantId = sessionTenantMap.get(ctx.sessionKey);

    if (!tenantId) {
      // Fallback: try session key phone extraction
      const phone = extractPhoneFromSessionKey(ctx.sessionKey);
      if (phone) {
        const tenantCtx = await resolveAndCache(phone);
        if (tenantCtx) {
          tenantId = tenantCtx.tenant.id;
          sessionTenantMap.set(ctx.sessionKey, tenantId);
        }
      }
    }

    if (!tenantId) {
      // Last resort: use single cached tenant
      if (tenantCache.size === 1) {
        const firstCtx = tenantCache.values().next().value;
        if (firstCtx) {
          log.info(
            `[rdy-tenant] before_tool_call: fallback to single cached tenant ${firstCtx.tenant.name}`,
          );
          return handleToolInjection(event, firstCtx, log);
        }
      }
      return;
    }

    const tenantCtx = tenantCache.get(tenantId);
    if (!tenantCtx) return;

    return handleToolInjection(event, tenantCtx, log);
  });

  // ============================================================
  //  TOOL: link_identity — conversational onboarding for WeCom users
  // ============================================================

  api.registerTool({
    name: "link_identity",
    description:
      "Link the current chat user to their tenant account using their registered WhatsApp phone number. " +
      "Use when a WeCom or other non-WhatsApp user needs to access business tools (golf/racing). " +
      "Ask the user for their registered phone number, then call this tool.",
    parameters: {
      type: "object",
      properties: {
        phone: {
          type: "string",
          description:
            "The user's registered WhatsApp phone number in E.164 format (e.g. +85293830979)",
        },
      },
      required: ["phone"],
    },
    async execute(_id: string, params: { phone: string }, context: any) {
      try {
        const sessionKey = context?.sessionKey;
        const identity = sessionIdentityMap.get(sessionKey);

        if (!identity) {
          return text({
            error: "Cannot detect your current channel. Please send a message first.",
          });
        }

        if (identity.channel === "whatsapp") {
          return text({
            error: "You're already on WhatsApp — your account should be linked automatically.",
          });
        }

        // Find tenant by phone
        const tenant = await resolveTenantByPhone(params.phone);
        if (!tenant) {
          return text({
            error: `No account found for phone ${params.phone}. Please check the number.`,
          });
        }

        // Create identity link
        await insertIdentity(tenant.id, identity.channel, identity.channelUid);

        // Warm session cache
        const workspaces = await getWorkspacesForTenant(tenant.id);
        const ctx: TenantContext = {
          tenant,
          workspaces,
          activeWorkspaceId: workspaces.length === 1 ? workspaces[0].id : null,
        };
        tenantCache.set(tenant.id, ctx);
        sessionTenantMap.set(sessionKey, tenant.id);

        log.info(
          `[rdy-tenant] linked ${identity.channel}:${identity.channelUid} → tenant "${tenant.name}"`,
        );

        const bizNames = workspaces.map((w) => verticalLabel(w.vertical));
        return text({
          message: `Linked! Welcome, ${tenant.name}. You now have access to: ${bizNames.join(", ")}.`,
          tenant: tenant.name,
          businesses: bizNames,
        });
      } catch (err: any) {
        log.error(`[rdy-tenant] link_identity error: ${err.message}`);
        return text({ error: err.message });
      }
    },
  });

  // ============================================================
  //  TOOL: switch_workspace
  // ============================================================

  api.registerTool({
    name: "switch_workspace",
    description:
      "Switch active business context. Use when the user says golf, racing, or asks to switch.",
    parameters: {
      type: "object",
      properties: {
        business: {
          type: "string",
          description: "Business name: golf or racing",
        },
      },
      required: ["business"],
    },
    async execute(_id: string, params: { business: string }, context: any) {
      try {
        const input = params.business.toLowerCase().trim();
        let workspace: Workspace | null = null;

        workspace = await getWorkspaceBySlug(input);

        if (!workspace) {
          const verticalMap: Record<string, string> = {
            golf: "sim_golf",
            rdygolf: "sim_golf",
            racing: "sim_racing",
            rdyracing: "sim_racing",
          };
          const vertical = verticalMap[input];
          if (vertical) {
            for (const [, tenantCtx] of tenantCache) {
              const match = tenantCtx.workspaces.find((w) => w.vertical === vertical);
              if (match) {
                workspace = match;
                break;
              }
            }
          }
        }

        if (!workspace)
          return text({
            error: `No business found matching "${params.business}"`,
          });

        for (const [, tenantCtx] of tenantCache) {
          if (tenantCtx.workspaces.some((w) => w.id === workspace!.id)) {
            tenantCtx.activeWorkspaceId = workspace.id;
          }
        }

        const label = verticalLabel(workspace.vertical);
        return text({
          message: `Switched to ${label}. All operations now target ${label}.`,
        });
      } catch (err: any) {
        return text({ error: err.message });
      }
    },
  });

  // ============================================================
  //  TOOL: list_workspaces
  // ============================================================

  api.registerTool({
    name: "list_workspaces",
    description: "List businesses owned by the current user.",
    parameters: {
      type: "object",
      properties: {
        phone: {
          type: "string",
          description: "Tenant phone number in E.164 format (optional, auto-detected from session)",
        },
      },
    },
    async execute(_id: string, params: { phone?: string }, context: any) {
      try {
        // Try session-based lookup first
        const sessionKey = context?.sessionKey;
        const tenantId = sessionTenantMap.get(sessionKey);

        if (tenantId) {
          const tenantCtx = tenantCache.get(tenantId);
          if (tenantCtx) {
            return text({
              owner: tenantCtx.tenant.name,
              businesses: tenantCtx.workspaces.map((w) => ({
                business: verticalLabel(w.vertical),
                active: w.id === tenantCtx.activeWorkspaceId,
              })),
            });
          }
        }

        // Fallback to phone param or session key extraction
        let phone = params.phone;
        if (!phone) {
          phone = extractPhoneFromSessionKey(sessionKey) ?? undefined;
        }
        if (!phone) {
          // Last resort: single cached tenant
          if (tenantCache.size === 1) {
            const firstCtx = tenantCache.values().next().value;
            if (firstCtx) {
              return text({
                owner: firstCtx.tenant.name,
                businesses: firstCtx.workspaces.map((w) => ({
                  business: verticalLabel(w.vertical),
                  active: w.id === firstCtx.activeWorkspaceId,
                })),
              });
            }
          }
          return text({ error: "No phone number available." });
        }

        const tenantCtx = await resolveAndCache(phone);
        if (!tenantCtx) return text({ error: `No tenant found for phone ${phone}` });

        return text({
          owner: tenantCtx.tenant.name,
          businesses: tenantCtx.workspaces.map((w) => ({
            business: verticalLabel(w.vertical),
            active: w.id === tenantCtx.activeWorkspaceId,
          })),
        });
      } catch (err: any) {
        return text({ error: err.message });
      }
    },
  });

  // ============================================================
  //  COMMANDS: /golf and /racing shortcuts
  // ============================================================

  api.registerCommand({
    name: "golf",
    description: "Switch to golf",
    async handler(ctx: any) {
      try {
        const phone = ctx.from;
        log.info(
          `[rdy-tenant] /golf command: from=${phone}, sessionKey=${ctx.sessionKey}, keys=${Object.keys(ctx).join(",")}`,
        );
        if (phone) {
          const tenantCtx = await resolveAndCache(phone);
          if (tenantCtx) {
            const golfWs = tenantCtx.workspaces.find((w) => w.vertical === "sim_golf");
            if (golfWs) {
              tenantCtx.activeWorkspaceId = golfWs.id;
              return { text: `Switched to golf.` };
            }
          }
        }
        // Fallback: try session-based lookup
        const tenantId = sessionTenantMap.get(ctx.sessionKey);
        if (tenantId) {
          const tenantCtx = tenantCache.get(tenantId);
          if (tenantCtx) {
            const golfWs = tenantCtx.workspaces.find((w) => w.vertical === "sim_golf");
            if (golfWs) {
              tenantCtx.activeWorkspaceId = golfWs.id;
              return { text: `Switched to golf.` };
            }
          }
        }
        return { text: "No golf business found." };
      } catch (err: any) {
        log.error(`[rdy-tenant] /golf handler error: ${err.message}`);
        log.error(`[rdy-tenant] /golf handler stack: ${err.stack}`);
        return { text: `Error switching to golf: ${err.message}` };
      }
    },
  });

  api.registerCommand({
    name: "racing",
    description: "Switch to racing",
    async handler(ctx: any) {
      try {
        const phone = ctx.from;
        log.info(`[rdy-tenant] /racing command: from=${phone}, sessionKey=${ctx.sessionKey}`);
        if (phone) {
          const tenantCtx = await resolveAndCache(phone);
          if (tenantCtx) {
            const racingWs = tenantCtx.workspaces.find((w) => w.vertical === "sim_racing");
            if (racingWs) {
              tenantCtx.activeWorkspaceId = racingWs.id;
              return { text: `Switched to racing.` };
            }
          }
        }
        // Fallback: try session-based lookup
        const tenantId = sessionTenantMap.get(ctx.sessionKey);
        if (tenantId) {
          const tenantCtx = tenantCache.get(tenantId);
          if (tenantCtx) {
            const racingWs = tenantCtx.workspaces.find((w) => w.vertical === "sim_racing");
            if (racingWs) {
              tenantCtx.activeWorkspaceId = racingWs.id;
              return { text: `Switched to racing.` };
            }
          }
        }
        return { text: "No racing business found." };
      } catch (err: any) {
        log.error(`[rdy-tenant] /racing handler error: ${err.message}`);
        return { text: `Error switching to racing: ${err.message}` };
      }
    },
  });

  log.info(
    "[rdy-tenant] registered hooks, tools (link_identity, switch_workspace, list_workspaces), commands (/golf, /racing)",
  );
}
