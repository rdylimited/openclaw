import pg from "pg";

// --- Database connection pools ---
// rdycore: tenants, workspaces, members, wallets, costs, goals, snapshots
// golf: golf-specific bookings
// racing: racing-specific bookings

const DB_PASSWORD =
  process.env.RDY_DB_PASSWORD ?? "8b309fab0813a258592d0f849c5e8a3f0498ccc4427d88f5";
const DB_HOST = process.env.RDY_DB_HOST ?? "100.120.14.56";
const DB_PORT = process.env.RDY_DB_PORT ?? "5433";

function makePool(dbName: string) {
  return new pg.Pool({
    connectionString: `postgresql://postgres:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${dbName}`,
    max: 3,
  });
}

const pools: Record<string, pg.Pool> = {
  rdycore: makePool("rdycore"),
  golf: makePool("golf"),
  racing: makePool("racing"),
};

function getPool(dbName: string): pg.Pool {
  if (!pools[dbName]) {
    pools[dbName] = makePool(dbName);
  }
  return pools[dbName];
}

// --- Resolve workspace db_name from rdycore ---

const workspaceDbCache = new Map<string, string>();

async function resolveDbName(workspaceId: string): Promise<string | null> {
  const cached = workspaceDbCache.get(workspaceId);
  if (cached) return cached;

  const { rows } = await pools.rdycore.query("SELECT db_name FROM workspaces WHERE id = $1", [
    workspaceId,
  ]);
  const dbName = rows[0]?.db_name;
  if (dbName) workspaceDbCache.set(workspaceId, dbName);
  return dbName ?? null;
}

// --- Date/time helpers ---

function todayHK(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Hong_Kong" });
}

function currentPeriodMonth(): string {
  return todayHK().slice(0, 7); // YYYY-MM
}

function currentPeriodWeek(): string {
  const d = new Date(todayHK());
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d.getTime() - jan1.getTime()) / 86400000);
  const weekNum = Math.ceil((days + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function currentPeriodYear(): string {
  return todayHK().slice(0, 4); // YYYY
}

function yesterdayHK(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Hong_Kong" });
}

// --- Response helpers ---

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// --- Workspace hours (for utilization calculation) ---
// Default operating hours if not in workspace config
const DEFAULT_OPEN_HOUR = 10; // 10am
const DEFAULT_CLOSE_HOUR = 23; // 11pm

function getOperatingMinutes(workspaceConfig: Record<string, any>): number {
  const open = workspaceConfig?.hours?.open ?? DEFAULT_OPEN_HOUR;
  const close = workspaceConfig?.hours?.close ?? DEFAULT_CLOSE_HOUR;
  return (close - open) * 60;
}

// --- Extension entry point ---

export default function (api: any) {
  const log = api.logger ?? { info: console.log, warn: console.warn, error: console.error };

  // ============================================================
  //  TOOL: manage_costs — CRUD for business costs
  // ============================================================

  api.registerTool({
    name: "manage_costs",
    description:
      "Manage business costs (rent, staff, utilities, equipment, marketing). " +
      "Use action=list to see all costs, action=create to add, action=update to modify, action=delete to remove.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected, do not ask user" },
        action: { type: "string", description: "list, create, update, or delete" },
        cost_id: { type: "string", description: "Cost UUID (for update/delete)" },
        category: {
          type: "string",
          description: "rent, staff, utilities, equipment, marketing, other",
        },
        name: {
          type: "string",
          description: "Cost description e.g. 'Monthly rent', 'Part-time staff'",
        },
        amount: { type: "number", description: "Amount in HKD (e.g. 25000 for $25,000)" },
        frequency: { type: "string", description: "monthly, weekly, one_time, annual" },
        effective_from: { type: "string", description: "YYYY-MM-DD start date (default: today)" },
        effective_to: {
          type: "string",
          description: "YYYY-MM-DD end date (optional, NULL = ongoing)",
        },
        notes: { type: "string" },
      },
      required: ["action"],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;

      if (p.action === "list") {
        const { rows } = await pools.rdycore.query(
          `SELECT id, category, name, amount_cents, currency, frequency,
                  effective_from, effective_to, notes, created_by
           FROM business_costs
           WHERE workspace_id = $1 AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
           ORDER BY category, name`,
          [wsId],
        );
        const monthly = rows.reduce((sum: number, r: any) => {
          if (r.frequency === "monthly") return sum + r.amount_cents;
          if (r.frequency === "weekly") return sum + r.amount_cents * 4.33;
          if (r.frequency === "annual") return sum + Math.round(r.amount_cents / 12);
          return sum;
        }, 0);
        return text({
          costs: rows.map((r: any) => ({
            ...r,
            amount_hkd: r.amount_cents / 100,
          })),
          total_count: rows.length,
          estimated_monthly_hkd: Math.round(monthly) / 100,
        });
      }

      if (p.action === "create") {
        if (!p.category || !p.name || !p.amount || !p.frequency) {
          return text({ error: "category, name, amount, and frequency are required" });
        }
        const amountCents = Math.round(p.amount * 100);
        const { rows } = await pools.rdycore.query(
          `INSERT INTO business_costs (workspace_id, category, name, amount_cents, frequency, effective_from, effective_to, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ai_assistant')
           RETURNING id, category, name, amount_cents, frequency`,
          [
            wsId,
            p.category,
            p.name,
            amountCents,
            p.frequency,
            p.effective_from ?? todayHK(),
            p.effective_to ?? null,
            p.notes ?? null,
          ],
        );
        return text({
          message: "Cost added",
          cost: { ...rows[0], amount_hkd: rows[0].amount_cents / 100 },
        });
      }

      if (p.action === "update") {
        if (!p.cost_id) return text({ error: "cost_id required for update" });
        const sets: string[] = [];
        const vals: any[] = [p.cost_id];
        let idx = 2;
        if (p.name) {
          sets.push(`name = $${idx++}`);
          vals.push(p.name);
        }
        if (p.amount) {
          sets.push(`amount_cents = $${idx++}`);
          vals.push(Math.round(p.amount * 100));
        }
        if (p.category) {
          sets.push(`category = $${idx++}`);
          vals.push(p.category);
        }
        if (p.frequency) {
          sets.push(`frequency = $${idx++}`);
          vals.push(p.frequency);
        }
        if (p.effective_to !== undefined) {
          sets.push(`effective_to = $${idx++}`);
          vals.push(p.effective_to);
        }
        if (p.notes !== undefined) {
          sets.push(`notes = $${idx++}`);
          vals.push(p.notes);
        }
        if (sets.length === 0) return text({ error: "No fields to update" });
        const { rows } = await pools.rdycore.query(
          `UPDATE business_costs SET ${sets.join(", ")} WHERE id = $1 RETURNING id, name, amount_cents, frequency`,
          vals,
        );
        if (rows.length === 0) return text({ error: "Cost not found" });
        return text({
          message: "Cost updated",
          cost: { ...rows[0], amount_hkd: rows[0].amount_cents / 100 },
        });
      }

      if (p.action === "delete") {
        if (!p.cost_id) return text({ error: "cost_id required for delete" });
        const { rowCount } = await pools.rdycore.query("DELETE FROM business_costs WHERE id = $1", [
          p.cost_id,
        ]);
        return text({ message: rowCount ? "Cost deleted" : "Cost not found" });
      }

      return text({ error: `Unknown action: ${p.action}` });
    },
  });

  // ============================================================
  //  TOOL: manage_goals — set/update profitability targets
  // ============================================================

  api.registerTool({
    name: "manage_goals",
    description:
      "Set or update profitability targets. " +
      "Metrics: utilization_pct, margin_pct, revenue_monthly, bookings_daily, avg_ticket, retention_pct, break_even_days. " +
      "Use action=list to see current goals, action=set to create/update, action=delete to remove.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        action: { type: "string", description: "list, set, or delete" },
        goal_id: { type: "string", description: "Goal UUID (for delete)" },
        metric: { type: "string", description: "The KPI to target" },
        target_value: {
          type: "number",
          description: "Target number (e.g. 70 for 70% utilization)",
        },
        period_type: { type: "string", description: "daily, weekly, monthly, or annual" },
      },
      required: ["action"],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;

      if (p.action === "list") {
        const { rows } = await pools.rdycore.query(
          `SELECT id, metric, target_value, period_type, is_active, created_at
           FROM profitability_goals WHERE workspace_id = $1 AND is_active = true
           ORDER BY metric`,
          [wsId],
        );
        return text({ goals: rows, total: rows.length });
      }

      if (p.action === "set") {
        if (!p.metric || p.target_value === undefined || !p.period_type) {
          return text({ error: "metric, target_value, and period_type are required" });
        }
        // Upsert via partial unique index (workspace_id, metric, period_type WHERE is_active)
        const { rows: existing } = await pools.rdycore.query(
          `SELECT id FROM profitability_goals
           WHERE workspace_id = $1 AND metric = $2 AND period_type = $3 AND is_active = true`,
          [wsId, p.metric, p.period_type],
        );
        if (existing.length > 0) {
          await pools.rdycore.query(
            `UPDATE profitability_goals SET target_value = $1, updated_at = now()
             WHERE id = $2`,
            [p.target_value, existing[0].id],
          );
          return text({
            message: "Goal updated",
            metric: p.metric,
            target: p.target_value,
            period: p.period_type,
          });
        }
        const { rows } = await pools.rdycore.query(
          `INSERT INTO profitability_goals (workspace_id, metric, target_value, period_type)
           VALUES ($1, $2, $3, $4)
           RETURNING id, metric, target_value, period_type`,
          [wsId, p.metric, p.target_value, p.period_type],
        );
        return text({ message: "Goal set", goal: rows[0] });
      }

      if (p.action === "delete") {
        if (!p.goal_id) return text({ error: "goal_id required" });
        await pools.rdycore.query(
          "UPDATE profitability_goals SET is_active = false WHERE id = $1",
          [p.goal_id],
        );
        return text({ message: "Goal deactivated" });
      }

      return text({ error: `Unknown action: ${p.action}` });
    },
  });

  // ============================================================
  //  SNAPSHOT ENGINE: Collect and store KPI snapshots
  // ============================================================

  async function collectDailySnapshot(
    workspaceId: string,
    date: string,
  ): Promise<Record<string, any>> {
    const dbName = await resolveDbName(workspaceId);
    if (!dbName) throw new Error("Workspace not found");

    const pool = getPool(dbName);

    // Get workspace config for operating hours
    const { rows: wsRows } = await pools.rdycore.query(
      "SELECT config FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    const wsConfig = wsRows[0]?.config ?? {};
    const opMinutes = getOperatingMinutes(wsConfig);

    // Revenue and booking counts
    const revenueCol = dbName === "racing" ? "final_price_cents" : "(final_price * 100)::int";
    const { rows: bookingStats } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status NOT IN ('cancelled'))::int AS booking_count,
         COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_count,
         COALESCE(SUM(${revenueCol}) FILTER (WHERE status NOT IN ('cancelled')), 0)::int AS revenue_cents,
         COUNT(DISTINCT customer_email) FILTER (WHERE status NOT IN ('cancelled'))::int AS unique_customers,
         COALESCE(SUM(duration_minutes) FILTER (WHERE status NOT IN ('cancelled')), 0)::int AS booked_minutes
       FROM bookings
       WHERE workspace_id = $1 AND booking_date = $2`,
      [workspaceId, date],
    );
    const stats = bookingStats[0];

    // Count resources for utilization
    let resourceCount = 1; // golf has 1 bay
    if (dbName === "racing") {
      const { rows: rigs } = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM rigs WHERE workspace_id = $1 AND active = true",
        [workspaceId],
      );
      resourceCount = rigs[0]?.cnt ?? 1;
    }

    const totalAvailableMinutes = opMinutes * resourceCount;
    const utilizationPct =
      totalAvailableMinutes > 0
        ? Math.round((stats.booked_minutes / totalAvailableMinutes) * 10000) / 100
        : 0;

    const avgTicketCents =
      stats.booking_count > 0 ? Math.round(stats.revenue_cents / stats.booking_count) : 0;

    // Costs for the day (monthly costs / 30, weekly / 7, annual / 365)
    const { rows: costs } = await pools.rdycore.query(
      `SELECT COALESCE(SUM(
         CASE frequency
           WHEN 'monthly' THEN amount_cents / 30.0
           WHEN 'weekly' THEN amount_cents / 7.0
           WHEN 'annual' THEN amount_cents / 365.0
           WHEN 'one_time' THEN 0
         END
       ), 0)::int AS daily_cost_cents
       FROM business_costs
       WHERE workspace_id = $1
         AND effective_from <= $2::date
         AND (effective_to IS NULL OR effective_to >= $2::date)`,
      [workspaceId, date],
    );
    const costCents = costs[0]?.daily_cost_cents ?? 0;

    // Margin
    const marginPct =
      stats.revenue_cents > 0
        ? Math.round(((stats.revenue_cents - costCents) / stats.revenue_cents) * 10000) / 100
        : 0;

    // Wallet activity
    const { rows: walletStats } = await pools.rdycore.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type = 'topup'), 0)::numeric AS credit_topups,
         COALESCE(SUM(amount) FILTER (WHERE type = 'refund'), 0)::numeric AS refunds
       FROM wallet_transactions
       WHERE workspace_id = $1 AND created_at::date = $2`,
      [workspaceId, date],
    );

    const topupsCents = Math.round((Number(walletStats[0]?.credit_topups) || 0) * 100);
    const refundsCents = Math.round((Number(walletStats[0]?.refunds) || 0) * 100);

    const metrics = {
      revenue_cents: stats.revenue_cents,
      cost_cents: costCents,
      margin_pct: marginPct,
      booking_count: stats.booking_count,
      cancelled_count: stats.cancelled_count,
      utilization_pct: utilizationPct,
      avg_ticket_cents: avgTicketCents,
      unique_customers: stats.unique_customers,
      new_customers: 0,
      repeat_customers: 0,
      credit_topups_cents: topupsCents,
      refunds_cents: refundsCents,
      cash_in_cents: stats.revenue_cents + topupsCents,
      cash_out_cents: costCents + refundsCents,
      coach_revenue_cents: 0,
      peak_hour_utilization_pct: 0,
      off_peak_utilization_pct: 0,
    };

    // Upsert snapshot
    await pools.rdycore.query(
      `INSERT INTO profitability_snapshots (workspace_id, period_type, period_key, metrics)
       VALUES ($1, 'daily', $2, $3)
       ON CONFLICT (workspace_id, period_type, period_key)
       DO UPDATE SET metrics = $3`,
      [workspaceId, date, JSON.stringify(metrics)],
    );

    return metrics;
  }

  api.registerTool({
    name: "take_snapshot",
    description:
      "Manually trigger a KPI snapshot for a workspace. Usually runs automatically via scheduler. " +
      "Collects revenue, costs, utilization, bookings, and stores as a daily snapshot.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        date: { type: "string", description: "YYYY-MM-DD (defaults to yesterday)" },
      },
      required: [],
    },
    async execute(_id: string, p: any) {
      try {
        const date = p.date ?? yesterdayHK();
        const metrics = await collectDailySnapshot(p.workspace_id, date);

        // Generate dynamic pricing suggestions after snapshot
        try {
          await generatePricingSuggestions(p.workspace_id);
        } catch (pricingErr: any) {
          log.warn(`[rdy-profitability] pricing suggestions failed: ${pricingErr.message}`);
        }

        return text({
          message: `Snapshot taken for ${date}`,
          date,
          metrics: {
            ...metrics,
            revenue_hkd: metrics.revenue_cents / 100,
            cost_hkd: metrics.cost_cents / 100,
            avg_ticket_hkd: metrics.avg_ticket_cents / 100,
          },
        });
      } catch (err: any) {
        return text({ error: err.message });
      }
    },
  });

  // ============================================================
  //  TOOL: profitability_report — on-demand P&L analysis
  // ============================================================

  api.registerTool({
    name: "profitability_report",
    description:
      "Generate a profitability report for any period. Shows revenue, costs, margin, utilization, " +
      "bookings, and scores against your goals. Period types: daily, weekly, monthly, annual.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        period_type: {
          type: "string",
          description: "daily, weekly, monthly, or annual (default: monthly)",
        },
        period_key: {
          type: "string",
          description: "Period key e.g. 2026-03-01, 2026-W09, 2026-03, 2026 (default: current)",
        },
      },
      required: [],
    },
    async execute(_id: string, p: any) {
      const periodType = p.period_type ?? "monthly";
      let periodKey = p.period_key;

      if (!periodKey) {
        if (periodType === "daily") periodKey = yesterdayHK();
        else if (periodType === "weekly") periodKey = currentPeriodWeek();
        else if (periodType === "monthly") periodKey = currentPeriodMonth();
        else periodKey = currentPeriodYear();
      }

      // Get daily snapshots for aggregation
      let snapshots: any[];

      if (periodType === "daily") {
        const { rows } = await pools.rdycore.query(
          `SELECT metrics FROM profitability_snapshots
           WHERE workspace_id = $1 AND period_type = 'daily' AND period_key = $2`,
          [p.workspace_id, periodKey],
        );
        if (rows.length === 0) {
          try {
            const metrics = await collectDailySnapshot(p.workspace_id, periodKey);
            snapshots = [{ metrics }];
          } catch {
            return text({ error: `No data available for ${periodKey}` });
          }
        } else {
          snapshots = rows;
        }
      } else {
        // Monthly/annual: match by prefix; weekly: last 7 daily snapshots
        let likePattern: string;
        if (periodType === "weekly") {
          // Get last 7 days of snapshots
          const { rows } = await pools.rdycore.query(
            `SELECT metrics FROM profitability_snapshots
             WHERE workspace_id = $1 AND period_type = 'daily'
             ORDER BY period_key DESC LIMIT 7`,
            [p.workspace_id],
          );
          snapshots = rows;
        } else {
          likePattern = periodKey;
          const { rows } = await pools.rdycore.query(
            `SELECT metrics FROM profitability_snapshots
             WHERE workspace_id = $1 AND period_type = 'daily'
               AND period_key LIKE $2 || '%'`,
            [p.workspace_id, likePattern],
          );
          snapshots = rows;
        }
      }

      if (!snapshots || snapshots.length === 0) {
        return text({
          error: `No snapshot data for ${periodType} ${periodKey}. Run take_snapshot first.`,
        });
      }

      // Aggregate
      const totals = {
        revenue_cents: 0,
        cost_cents: 0,
        booking_count: 0,
        cancelled_count: 0,
        unique_customers: 0,
        booked_days: snapshots.length,
        total_utilization: 0,
      };

      for (const snap of snapshots) {
        const m = typeof snap.metrics === "string" ? JSON.parse(snap.metrics) : snap.metrics;
        totals.revenue_cents += m.revenue_cents ?? 0;
        totals.cost_cents += m.cost_cents ?? 0;
        totals.booking_count += m.booking_count ?? 0;
        totals.cancelled_count += m.cancelled_count ?? 0;
        totals.unique_customers += m.unique_customers ?? 0;
        totals.total_utilization += m.utilization_pct ?? 0;
      }

      const avgUtilization =
        totals.booked_days > 0
          ? Math.round((totals.total_utilization / totals.booked_days) * 100) / 100
          : 0;
      const avgTicket =
        totals.booking_count > 0 ? Math.round(totals.revenue_cents / totals.booking_count) : 0;
      const marginPct =
        totals.revenue_cents > 0
          ? Math.round(
              ((totals.revenue_cents - totals.cost_cents) / totals.revenue_cents) * 10000,
            ) / 100
          : 0;

      // Score against goals
      const { rows: goals } = await pools.rdycore.query(
        `SELECT metric, target_value FROM profitability_goals
         WHERE workspace_id = $1 AND is_active = true AND period_type = $2`,
        [p.workspace_id, periodType],
      );

      const goalScores = goals.map((g: any) => {
        let actual: number;
        switch (g.metric) {
          case "utilization_pct":
            actual = avgUtilization;
            break;
          case "margin_pct":
            actual = marginPct;
            break;
          case "revenue_monthly":
            actual = totals.revenue_cents / 100;
            break;
          case "bookings_daily":
            actual = totals.booked_days > 0 ? totals.booking_count / totals.booked_days : 0;
            break;
          case "avg_ticket":
            actual = avgTicket / 100;
            break;
          default:
            actual = 0;
        }
        const pct = g.target_value > 0 ? Math.round((actual / g.target_value) * 100) : 0;
        const status = pct >= 100 ? "on_target" : pct >= 80 ? "close" : "behind";
        return {
          metric: g.metric,
          target: g.target_value,
          actual: Math.round(actual * 100) / 100,
          pct,
          status,
        };
      });

      return text({
        period: { type: periodType, key: periodKey, days: totals.booked_days },
        pnl: {
          revenue_hkd: totals.revenue_cents / 100,
          costs_hkd: totals.cost_cents / 100,
          profit_hkd: (totals.revenue_cents - totals.cost_cents) / 100,
          margin_pct: marginPct,
        },
        operations: {
          bookings: totals.booking_count,
          cancellations: totals.cancelled_count,
          avg_utilization_pct: avgUtilization,
          avg_ticket_hkd: avgTicket / 100,
          unique_customers: totals.unique_customers,
        },
        goal_scorecard: goalScores,
      });
    },
  });

  // ============================================================
  //  TOOL: profitability_trend — metric trends over time
  // ============================================================

  api.registerTool({
    name: "profitability_trend",
    description:
      "Show how a metric has changed over time. Returns last N periods with direction indicators. " +
      "Metrics: revenue_cents, cost_cents, margin_pct, booking_count, utilization_pct, avg_ticket_cents, unique_customers.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        metric: { type: "string", description: "The metric to trend" },
        period_type: { type: "string", description: "daily, weekly, monthly (default: daily)" },
        periods: { type: "number", description: "Number of periods to show (default: 7)" },
      },
      required: ["metric"],
    },
    async execute(_id: string, p: any) {
      const periodType = p.period_type ?? "daily";
      const periods = p.periods ?? 7;
      const metric = p.metric;

      const { rows } = await pools.rdycore.query(
        `SELECT period_key, metrics->>$3 AS value
         FROM profitability_snapshots
         WHERE workspace_id = $1 AND period_type = $2
         ORDER BY period_key DESC
         LIMIT $4`,
        [p.workspace_id, periodType, metric, periods],
      );

      if (rows.length === 0) {
        return text({ error: `No trend data for ${metric}. Run take_snapshot first.` });
      }

      // Reverse to chronological order
      const dataPoints = rows.reverse().map((r: any) => ({
        period: r.period_key,
        value: Number(r.value ?? 0),
      }));

      const values = dataPoints.map((d: any) => d.value);
      const first = values[0];
      const last = values[values.length - 1];
      const changePct = first > 0 ? Math.round(((last - first) / first) * 10000) / 100 : 0;
      const direction = changePct > 2 ? "up" : changePct < -2 ? "down" : "flat";

      const isCents = metric.endsWith("_cents");

      return text({
        metric,
        period_type: periodType,
        direction,
        change_pct: changePct,
        data: dataPoints.map((d: any) => ({
          period: d.period,
          value: d.value,
          ...(isCents ? { value_hkd: d.value / 100 } : {}),
        })),
      });
    },
  });

  // ============================================================
  //  TOOL: track_action — optimization action lifecycle
  // ============================================================

  api.registerTool({
    name: "track_action",
    description:
      "Track optimization recommendations. Use action=list to see suggestions, " +
      "action=create to add a new recommendation, " +
      "action=accept/implement/reject/measure to update status. " +
      "When measuring, provide the actual impact percentage.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        action: { type: "string", description: "list, create, accept, implement, reject, measure" },
        action_id: { type: "string", description: "Action UUID (for status updates)" },
        recommendation: { type: "string", description: "Recommendation text (for create)" },
        category: {
          type: "string",
          description:
            "pricing, utilization, membership, cost_reduction, marketing, staffing, cross_sell",
        },
        expected_impact_pct: {
          type: "number",
          description: "Expected improvement percentage (for create)",
        },
        priority: { type: "string", description: "high, medium, low (default: medium)" },
        measured_impact_pct: {
          type: "number",
          description: "Actual measured impact (for measure)",
        },
        notes: { type: "string" },
      },
      required: ["action"],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;

      if (p.action === "list") {
        const { rows } = await pools.rdycore.query(
          `SELECT id, recommendation, category, expected_impact_pct, status, priority,
                  measured_impact_pct, notes, created_at, implemented_at, measured_at
           FROM optimization_actions
           WHERE workspace_id = $1
           ORDER BY
             CASE status WHEN 'suggested' THEN 0 WHEN 'accepted' THEN 1
               WHEN 'implemented' THEN 2 WHEN 'measured' THEN 3 ELSE 4 END,
             CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
             created_at DESC`,
          [wsId],
        );
        return text({
          actions: rows,
          summary: {
            suggested: rows.filter((r: any) => r.status === "suggested").length,
            accepted: rows.filter((r: any) => r.status === "accepted").length,
            implemented: rows.filter((r: any) => r.status === "implemented").length,
            measured: rows.filter((r: any) => r.status === "measured").length,
            rejected: rows.filter((r: any) => r.status === "rejected").length,
          },
        });
      }

      if (p.action === "create") {
        if (!p.recommendation || !p.category) {
          return text({ error: "recommendation and category are required" });
        }
        const { rows } = await pools.rdycore.query(
          `INSERT INTO optimization_actions (workspace_id, recommendation, category, expected_impact_pct, priority, notes)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, recommendation, category, status, priority`,
          [
            wsId,
            p.recommendation,
            p.category,
            p.expected_impact_pct ?? null,
            p.priority ?? "medium",
            p.notes ?? null,
          ],
        );
        return text({ message: "Recommendation created", action: rows[0] });
      }

      // Status updates
      if (!p.action_id) return text({ error: "action_id required for status updates" });

      const statusMap: Record<string, { status: string; dateCol?: string }> = {
        accept: { status: "accepted", dateCol: "accepted_at" },
        implement: { status: "implemented", dateCol: "implemented_at" },
        reject: { status: "rejected" },
        measure: { status: "measured", dateCol: "measured_at" },
      };

      const update = statusMap[p.action];
      if (!update) return text({ error: `Unknown action: ${p.action}` });

      const sets = [`status = '${update.status}'`];
      const vals: any[] = [p.action_id];
      let idx = 2;

      if (update.dateCol) {
        sets.push(`${update.dateCol} = now()`);
      }
      if (p.action === "measure" && p.measured_impact_pct !== undefined) {
        sets.push(`measured_impact_pct = $${idx++}`);
        vals.push(p.measured_impact_pct);
      }
      if (p.notes) {
        sets.push(`notes = $${idx++}`);
        vals.push(p.notes);
      }

      const { rows } = await pools.rdycore.query(
        `UPDATE optimization_actions SET ${sets.join(", ")} WHERE id = $1
         RETURNING id, recommendation, status, measured_impact_pct`,
        vals,
      );
      if (rows.length === 0) return text({ error: "Action not found" });
      return text({ message: `Action ${update.status}`, action: rows[0] });
    },
  });

  // ============================================================
  //  TOOL: generate_report — scheduled report generation
  // ============================================================

  api.registerTool({
    name: "generate_report",
    description:
      "Generate a formatted profitability report for delivery. Called by scheduler or on-demand. " +
      "Returns structured data the AI formats for WhatsApp/WeCom delivery. " +
      "Types: daily_brief, weekly_digest, monthly_review, annual_review.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        report_type: {
          type: "string",
          description: "daily_brief, weekly_digest, monthly_review, annual_review",
        },
        date: { type: "string", description: "Reference date YYYY-MM-DD (default: yesterday)" },
      },
      required: ["report_type"],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;
      const dbName = await resolveDbName(wsId);
      if (!dbName) return text({ error: "Workspace not found" });

      const refDate = p.date ?? yesterdayHK();

      if (p.report_type === "daily_brief") {
        // Ensure snapshot exists
        let metrics: Record<string, any>;
        const { rows: existing } = await pools.rdycore.query(
          `SELECT metrics FROM profitability_snapshots
           WHERE workspace_id = $1 AND period_type = 'daily' AND period_key = $2`,
          [wsId, refDate],
        );
        if (existing.length > 0) {
          metrics =
            typeof existing[0].metrics === "string"
              ? JSON.parse(existing[0].metrics)
              : existing[0].metrics;
        } else {
          metrics = await collectDailySnapshot(wsId, refDate);
        }

        // Goals for scoring
        const { rows: goals } = await pools.rdycore.query(
          `SELECT metric, target_value FROM profitability_goals
           WHERE workspace_id = $1 AND is_active = true AND period_type = 'daily'`,
          [wsId],
        );

        // Churn alerts count
        const { rows: churnCount } = await pools.rdycore.query(
          `SELECT COUNT(*)::int AS cnt FROM customer_signals
           WHERE workspace_id = $1 AND churn_risk IN ('high', 'medium')`,
          [wsId],
        );

        return text({
          report_type: "daily_brief",
          date: refDate,
          business: dbName,
          revenue_hkd: metrics.revenue_cents / 100,
          costs_hkd: metrics.cost_cents / 100,
          profit_hkd: (metrics.revenue_cents - metrics.cost_cents) / 100,
          margin_pct: metrics.margin_pct,
          bookings: metrics.booking_count,
          cancellations: metrics.cancelled_count,
          utilization_pct: metrics.utilization_pct,
          avg_ticket_hkd: metrics.avg_ticket_cents / 100,
          churn_alerts: churnCount[0]?.cnt ?? 0,
          goals: goals.map((g: any) => {
            let actual: number;
            switch (g.metric) {
              case "utilization_pct":
                actual = metrics.utilization_pct;
                break;
              case "bookings_daily":
                actual = metrics.booking_count;
                break;
              case "avg_ticket":
                actual = metrics.avg_ticket_cents / 100;
                break;
              default:
                actual = 0;
            }
            const status =
              actual >= g.target_value
                ? "hit"
                : actual >= g.target_value * 0.8
                  ? "close"
                  : "missed";
            return {
              metric: g.metric,
              target: g.target_value,
              actual: Math.round(actual * 100) / 100,
              status,
            };
          }),
          delivery_instruction:
            "Format this as a concise daily brief (~200 words). " +
            "Use traffic light indicators for goal status. Keep it conversational and actionable. " +
            "Send to the business owner via their chat channel.",
        });
      }

      if (p.report_type === "weekly_digest") {
        // Last 7 daily snapshots
        const { rows: weekSnaps } = await pools.rdycore.query(
          `SELECT period_key, metrics FROM profitability_snapshots
           WHERE workspace_id = $1 AND period_type = 'daily'
           ORDER BY period_key DESC LIMIT 7`,
          [wsId],
        );

        if (weekSnaps.length === 0) {
          return text({ error: "No daily snapshots found for this week" });
        }

        // Previous 7 days for WoW comparison
        const { rows: prevWeekSnaps } = await pools.rdycore.query(
          `SELECT period_key, metrics FROM profitability_snapshots
           WHERE workspace_id = $1 AND period_type = 'daily'
           ORDER BY period_key DESC LIMIT 7 OFFSET 7`,
          [wsId],
        );

        const sumMetrics = (snaps: any[]) => {
          const totals = {
            revenue: 0,
            cost: 0,
            bookings: 0,
            utilization: 0,
            customers: 0,
            days: snaps.length,
          };
          for (const s of snaps) {
            const m = typeof s.metrics === "string" ? JSON.parse(s.metrics) : s.metrics;
            totals.revenue += m.revenue_cents ?? 0;
            totals.cost += m.cost_cents ?? 0;
            totals.bookings += m.booking_count ?? 0;
            totals.utilization += m.utilization_pct ?? 0;
            totals.customers += m.unique_customers ?? 0;
          }
          return totals;
        };

        const thisWeek = sumMetrics(weekSnaps);
        const lastWeek = sumMetrics(prevWeekSnaps);

        const wow = (curr: number, prev: number) =>
          prev > 0 ? Math.round(((curr - prev) / prev) * 10000) / 100 : 0;

        // Top suggestions
        const { rows: suggestions } = await pools.rdycore.query(
          `SELECT recommendation, category, priority FROM optimization_actions
           WHERE workspace_id = $1 AND status = 'suggested'
           ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
           LIMIT 3`,
          [wsId],
        );

        return text({
          report_type: "weekly_digest",
          week_ending: refDate,
          business: dbName,
          this_week: {
            revenue_hkd: thisWeek.revenue / 100,
            costs_hkd: thisWeek.cost / 100,
            profit_hkd: (thisWeek.revenue - thisWeek.cost) / 100,
            bookings: thisWeek.bookings,
            avg_utilization_pct:
              thisWeek.days > 0
                ? Math.round((thisWeek.utilization / thisWeek.days) * 100) / 100
                : 0,
            unique_customers: thisWeek.customers,
          },
          wow_change: {
            revenue_pct: wow(thisWeek.revenue, lastWeek.revenue),
            bookings_pct: wow(thisWeek.bookings, lastWeek.bookings),
            utilization_pct: wow(thisWeek.utilization, lastWeek.utilization),
          },
          top_recommendations: suggestions,
          delivery_instruction:
            "Format this as a structured weekly digest (~400 words). " +
            "Include WoW trends with arrows. Highlight top 3 recommendations. " +
            "Send to the business owner via their chat channel.",
        });
      }

      if (p.report_type === "monthly_review") {
        const month = refDate.slice(0, 7); // YYYY-MM
        const prevMonth = (() => {
          const d = new Date(refDate);
          d.setMonth(d.getMonth() - 1);
          return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Hong_Kong" }).slice(0, 7);
        })();

        // This month's daily snapshots
        const { rows: thisMonthSnaps } = await pools.rdycore.query(
          `SELECT metrics FROM profitability_snapshots
           WHERE workspace_id = $1 AND period_type = 'daily' AND period_key LIKE $2 || '%'`,
          [wsId, month],
        );

        // Previous month for MoM
        const { rows: prevMonthSnaps } = await pools.rdycore.query(
          `SELECT metrics FROM profitability_snapshots
           WHERE workspace_id = $1 AND period_type = 'daily' AND period_key LIKE $2 || '%'`,
          [wsId, prevMonth],
        );

        const aggregateSnaps = (snaps: any[]) => {
          const t = {
            revenue: 0,
            cost: 0,
            bookings: 0,
            cancelled: 0,
            utilization: 0,
            customers: 0,
            days: snaps.length,
          };
          for (const s of snaps) {
            const m = typeof s.metrics === "string" ? JSON.parse(s.metrics) : s.metrics;
            t.revenue += m.revenue_cents ?? 0;
            t.cost += m.cost_cents ?? 0;
            t.bookings += m.booking_count ?? 0;
            t.cancelled += m.cancelled_count ?? 0;
            t.utilization += m.utilization_pct ?? 0;
            t.customers += m.unique_customers ?? 0;
          }
          return t;
        };

        const thisMonth = aggregateSnaps(thisMonthSnaps);
        const prevMonthAgg = aggregateSnaps(prevMonthSnaps);
        const mom = (curr: number, prev: number) =>
          prev > 0 ? Math.round(((curr - prev) / prev) * 10000) / 100 : 0;

        // Goals scorecard
        const { rows: goals } = await pools.rdycore.query(
          `SELECT metric, target_value FROM profitability_goals
           WHERE workspace_id = $1 AND is_active = true AND period_type = 'monthly'`,
          [wsId],
        );

        const avgUtil = thisMonth.days > 0 ? thisMonth.utilization / thisMonth.days : 0;
        const marginPctMonth =
          thisMonth.revenue > 0
            ? Math.round(((thisMonth.revenue - thisMonth.cost) / thisMonth.revenue) * 10000) / 100
            : 0;
        const avgTicketMonth =
          thisMonth.bookings > 0 ? Math.round(thisMonth.revenue / thisMonth.bookings) : 0;

        const goalScores = goals.map((g: any) => {
          let actual: number;
          switch (g.metric) {
            case "utilization_pct":
              actual = avgUtil;
              break;
            case "margin_pct":
              actual = marginPctMonth;
              break;
            case "revenue_monthly":
              actual = thisMonth.revenue / 100;
              break;
            case "bookings_daily":
              actual = thisMonth.days > 0 ? thisMonth.bookings / thisMonth.days : 0;
              break;
            case "avg_ticket":
              actual = avgTicketMonth / 100;
              break;
            default:
              actual = 0;
          }
          const pct = g.target_value > 0 ? Math.round((actual / g.target_value) * 100) : 0;
          const status = pct >= 100 ? "on_target" : pct >= 80 ? "close" : "behind";
          return {
            metric: g.metric,
            target: g.target_value,
            actual: Math.round(actual * 100) / 100,
            pct,
            status,
          };
        });

        // Action tracker scorecard
        const { rows: actionStats } = await pools.rdycore.query(
          `SELECT status, COUNT(*)::int AS cnt,
                  AVG(measured_impact_pct) FILTER (WHERE status = 'measured') AS avg_impact
           FROM optimization_actions
           WHERE workspace_id = $1
           GROUP BY status`,
          [wsId],
        );

        // Break-even estimate
        const dailyRevAvg = thisMonth.days > 0 ? thisMonth.revenue / thisMonth.days : 0;
        const dailyCostAvg = thisMonth.days > 0 ? thisMonth.cost / thisMonth.days : 0;
        const breakEvenStatus =
          dailyRevAvg > dailyCostAvg
            ? "profitable"
            : dailyRevAvg > 0
              ? `${Math.ceil(thisMonth.cost / dailyRevAvg)} days to break even at current pace`
              : "no revenue data";

        // Demand forecast: next month predicted from this month's patterns
        const { rows: weekdayAvg } = await pools.rdycore.query(
          `SELECT AVG((metrics->>'booking_count')::int)::numeric AS avg_daily_bookings
           FROM profitability_snapshots
           WHERE workspace_id = $1 AND period_type = 'daily' AND period_key LIKE $2 || '%'`,
          [wsId, month],
        );

        return text({
          report_type: "monthly_review",
          month,
          business: dbName,
          pnl: {
            revenue_hkd: thisMonth.revenue / 100,
            costs_hkd: thisMonth.cost / 100,
            profit_hkd: (thisMonth.revenue - thisMonth.cost) / 100,
            margin_pct: marginPctMonth,
          },
          mom_trends: {
            revenue_pct: mom(thisMonth.revenue, prevMonthAgg.revenue),
            bookings_pct: mom(thisMonth.bookings, prevMonthAgg.bookings),
            utilization_pct: mom(thisMonth.utilization, prevMonthAgg.utilization),
            customers_pct: mom(thisMonth.customers, prevMonthAgg.customers),
          },
          operations: {
            total_bookings: thisMonth.bookings,
            cancellations: thisMonth.cancelled,
            avg_utilization_pct: Math.round(avgUtil * 100) / 100,
            avg_ticket_hkd: avgTicketMonth / 100,
            unique_customers: thisMonth.customers,
            days_with_data: thisMonth.days,
          },
          goal_scorecard: goalScores,
          action_tracker: actionStats,
          break_even: breakEvenStatus,
          demand_forecast: {
            avg_daily_bookings:
              Math.round(Number(weekdayAvg[0]?.avg_daily_bookings ?? 0) * 100) / 100,
            projected_next_month_bookings: Math.round(
              Number(weekdayAvg[0]?.avg_daily_bookings ?? 0) * 30,
            ),
          },
          delivery_instruction:
            "Format this as a comprehensive monthly deep review (~800 words). " +
            "Include full P&L statement, MoM trend analysis with arrows, goal scorecard with traffic lights, " +
            "action tracker showing which recommendations worked, break-even status, and demand forecast. " +
            "Use data tables where appropriate. Send to the business owner via their chat channel.",
        });
      }

      if (p.report_type === "annual_review") {
        const year = refDate.slice(0, 4);
        const prevYear = String(Number(year) - 1);

        // This year's snapshots
        const { rows: yearSnaps } = await pools.rdycore.query(
          `SELECT period_key, metrics FROM profitability_snapshots
           WHERE workspace_id = $1 AND period_type = 'daily' AND period_key LIKE $2 || '%'
           ORDER BY period_key`,
          [wsId, year],
        );

        // Previous year for YoY
        const { rows: prevYearSnaps } = await pools.rdycore.query(
          `SELECT metrics FROM profitability_snapshots
           WHERE workspace_id = $1 AND period_type = 'daily' AND period_key LIKE $2 || '%'`,
          [wsId, prevYear],
        );

        const aggregateSnaps = (snaps: any[]) => {
          const t = {
            revenue: 0,
            cost: 0,
            bookings: 0,
            cancelled: 0,
            utilization: 0,
            customers: 0,
            days: snaps.length,
          };
          for (const s of snaps) {
            const m = typeof s.metrics === "string" ? JSON.parse(s.metrics) : s.metrics;
            t.revenue += m.revenue_cents ?? 0;
            t.cost += m.cost_cents ?? 0;
            t.bookings += m.booking_count ?? 0;
            t.cancelled += m.cancelled_count ?? 0;
            t.utilization += m.utilization_pct ?? 0;
            t.customers += m.unique_customers ?? 0;
          }
          return t;
        };

        const thisYear = aggregateSnaps(yearSnaps);
        const lastYear = aggregateSnaps(prevYearSnaps);
        const yoy = (curr: number, prev: number) =>
          prev > 0 ? Math.round(((curr - prev) / prev) * 10000) / 100 : 0;

        // Quarterly breakdown
        const quarters: Record<string, ReturnType<typeof aggregateSnaps>> = {};
        for (const snap of yearSnaps) {
          const month = Number(snap.period_key.slice(5, 7));
          const q = month <= 3 ? "Q1" : month <= 6 ? "Q2" : month <= 9 ? "Q3" : "Q4";
          if (!quarters[q])
            quarters[q] = {
              revenue: 0,
              cost: 0,
              bookings: 0,
              cancelled: 0,
              utilization: 0,
              customers: 0,
              days: 0,
            };
          const m = typeof snap.metrics === "string" ? JSON.parse(snap.metrics) : snap.metrics;
          quarters[q].revenue += m.revenue_cents ?? 0;
          quarters[q].cost += m.cost_cents ?? 0;
          quarters[q].bookings += m.booking_count ?? 0;
          quarters[q].utilization += m.utilization_pct ?? 0;
          quarters[q].days += 1;
        }

        const quarterSummary = Object.entries(quarters).map(([q, t]) => ({
          quarter: q,
          revenue_hkd: t.revenue / 100,
          costs_hkd: t.cost / 100,
          profit_hkd: (t.revenue - t.cost) / 100,
          bookings: t.bookings,
          avg_utilization_pct: t.days > 0 ? Math.round((t.utilization / t.days) * 100) / 100 : 0,
        }));

        // Action tracker ROI
        const { rows: actionROI } = await pools.rdycore.query(
          `SELECT category, COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status = 'measured')::int AS measured,
                  AVG(measured_impact_pct) FILTER (WHERE status = 'measured') AS avg_impact
           FROM optimization_actions WHERE workspace_id = $1
           GROUP BY category`,
          [wsId],
        );

        // Cost summary for tax
        const { rows: costSummary } = await pools.rdycore.query(
          `SELECT category,
             SUM(CASE frequency
               WHEN 'monthly' THEN amount_cents * 12
               WHEN 'weekly' THEN amount_cents * 52
               WHEN 'annual' THEN amount_cents
               WHEN 'one_time' THEN amount_cents
               ELSE 0 END)::int AS annual_cents
           FROM business_costs
           WHERE workspace_id = $1 AND effective_from <= ($2 || '-12-31')::date
             AND (effective_to IS NULL OR effective_to >= ($2 || '-01-01')::date)
           GROUP BY category ORDER BY annual_cents DESC`,
          [wsId, year],
        );

        const avgUtil = thisYear.days > 0 ? thisYear.utilization / thisYear.days : 0;

        return text({
          report_type: "annual_review",
          year,
          business: dbName,
          annual_pnl: {
            revenue_hkd: thisYear.revenue / 100,
            costs_hkd: thisYear.cost / 100,
            profit_hkd: (thisYear.revenue - thisYear.cost) / 100,
            margin_pct:
              thisYear.revenue > 0
                ? Math.round(((thisYear.revenue - thisYear.cost) / thisYear.revenue) * 10000) / 100
                : 0,
          },
          yoy_change: {
            revenue_pct: yoy(thisYear.revenue, lastYear.revenue),
            bookings_pct: yoy(thisYear.bookings, lastYear.bookings),
            customers_pct: yoy(thisYear.customers, lastYear.customers),
          },
          operations: {
            total_bookings: thisYear.bookings,
            cancellations: thisYear.cancelled,
            avg_utilization_pct: Math.round(avgUtil * 100) / 100,
            unique_customers: thisYear.customers,
            days_with_data: thisYear.days,
          },
          quarterly_breakdown: quarterSummary,
          optimization_roi: actionROI,
          tax_cost_summary: costSummary.map((c: any) => ({
            category: c.category,
            annual_hkd: c.annual_cents / 100,
          })),
          delivery_instruction:
            "Format this as an executive annual review with appendix. " +
            "Include full year P&L, quarterly breakdown table, YoY comparison, " +
            "tax-relevant cost summaries by category, optimization ROI scorecard, " +
            "and suggested targets for next year. ~1000+ words with data tables.",
        });
      }

      return text({ error: `Unknown report type: ${p.report_type}` });
    },
  });

  // ============================================================
  //  TOOL: capacity_forecast — demand prediction and gap analysis
  // ============================================================

  api.registerTool({
    name: "capacity_forecast",
    description:
      "Predict demand and identify booking gaps. Analyzes last 4 weeks of patterns by day-of-week " +
      "and time slot. Identifies consistently empty slots (promo candidates), high-demand periods " +
      "(surge pricing candidates), and predicts tomorrow's utilization.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        days_ahead: { type: "number", description: "Days to forecast (default: 1 = tomorrow)" },
      },
      required: [],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;
      const dbName = await resolveDbName(wsId);
      if (!dbName) return text({ error: "Workspace not found" });

      const pool = getPool(dbName);
      const timeCol = dbName === "racing" ? "start_time" : "booking_time";

      // Get 4-week booking patterns grouped by day-of-week and hour
      const { rows: patterns } = await pool.query(
        `SELECT
           EXTRACT(DOW FROM booking_date)::int AS dow,
           EXTRACT(HOUR FROM ${timeCol})::int AS hour,
           COUNT(*)::int AS avg_bookings,
           COUNT(DISTINCT booking_date)::int AS sample_days
         FROM bookings
         WHERE workspace_id = $1
           AND booking_date >= CURRENT_DATE - INTERVAL '28 days'
           AND booking_date < CURRENT_DATE
           AND status NOT IN ('cancelled')
         GROUP BY 1, 2
         ORDER BY 1, 2`,
        [wsId],
      );

      // Resource count for utilization
      let resourceCount = 1;
      if (dbName === "racing") {
        const { rows: rigs } = await pool.query(
          "SELECT COUNT(*)::int AS cnt FROM rigs WHERE workspace_id = $1 AND active = true",
          [wsId],
        );
        resourceCount = rigs[0]?.cnt ?? 1;
      }

      // Build heatmap: avg bookings per (dow, hour) over 4 weeks
      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const heatmap: Record<
        string,
        { hour: number; avg_bookings: number; capacity: number; fill_pct: number }[]
      > = {};

      for (const row of patterns) {
        const dayKey = dayNames[row.dow];
        if (!heatmap[dayKey]) heatmap[dayKey] = [];
        const avgPerDay =
          row.sample_days > 0 ? Math.round((row.avg_bookings / row.sample_days) * 100) / 100 : 0;
        const fillPct =
          resourceCount > 0 ? Math.round((avgPerDay / resourceCount) * 10000) / 100 : 0;
        heatmap[dayKey].push({
          hour: row.hour,
          avg_bookings: avgPerDay,
          capacity: resourceCount,
          fill_pct: fillPct,
        });
      }

      // Identify gaps (fill < 30%) and peaks (fill > 80%)
      const gaps: { day: string; hour: number; fill_pct: number }[] = [];
      const peaks: { day: string; hour: number; fill_pct: number }[] = [];

      for (const [day, slots] of Object.entries(heatmap)) {
        for (const slot of slots) {
          if (slot.fill_pct < 30) gaps.push({ day, hour: slot.hour, fill_pct: slot.fill_pct });
          if (slot.fill_pct > 80) peaks.push({ day, hour: slot.hour, fill_pct: slot.fill_pct });
        }
      }

      // Tomorrow's forecast
      const daysAhead = p.days_ahead ?? 1;
      const forecastDate = new Date();
      forecastDate.setDate(forecastDate.getDate() + daysAhead);
      const forecastDateStr = forecastDate.toLocaleDateString("sv-SE", {
        timeZone: "Asia/Hong_Kong",
      });
      const forecastDow = forecastDate.getDay();
      const forecastDayName = dayNames[forecastDow];

      // Current bookings for forecast date
      const { rows: currentBookings } = await pool.query(
        `SELECT EXTRACT(HOUR FROM ${timeCol})::int AS hour, COUNT(*)::int AS cnt
         FROM bookings
         WHERE workspace_id = $1 AND booking_date = $2 AND status NOT IN ('cancelled')
         GROUP BY 1 ORDER BY 1`,
        [wsId, forecastDateStr],
      );

      const historicalForDay = heatmap[forecastDayName] ?? [];
      const predictedUtilization =
        historicalForDay.length > 0
          ? Math.round(
              (historicalForDay.reduce((s, h) => s + h.fill_pct, 0) / historicalForDay.length) *
                100,
            ) / 100
          : 0;

      return text({
        forecast_date: forecastDateStr,
        forecast_day: forecastDayName,
        predicted_utilization_pct: predictedUtilization,
        current_bookings: currentBookings,
        resource_count: resourceCount,
        empty_slots: gaps.sort((a, b) => a.fill_pct - b.fill_pct).slice(0, 10),
        peak_slots: peaks.sort((a, b) => b.fill_pct - a.fill_pct).slice(0, 10),
        heatmap,
        suggestions: {
          promo_candidates:
            gaps.length > 0
              ? `${gaps.length} consistently empty slots found — consider happy hour or flash deals`
              : "No major gaps detected",
          surge_candidates:
            peaks.length > 0
              ? `${peaks.length} high-demand slots — consider surge pricing or premium add-ons`
              : "No consistently full slots detected",
        },
      });
    },
  });

  // ============================================================
  //  TOOL: asset_performance — per-rig/bay ROI analysis
  // ============================================================

  api.registerTool({
    name: "asset_performance",
    description:
      "Per-rig (racing) or per-bay (golf) performance analysis. Shows revenue, utilization, " +
      "booking count, and ROI for each physical asset over a period.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        period_type: { type: "string", description: "daily, weekly, monthly (default: monthly)" },
        period_key: { type: "string", description: "Period key (default: current)" },
      },
      required: [],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;
      const dbName = await resolveDbName(wsId);
      if (!dbName) return text({ error: "Workspace not found" });

      const pool = getPool(dbName);
      const periodType = p.period_type ?? "monthly";
      let periodKey = p.period_key;
      if (!periodKey) {
        if (periodType === "daily") periodKey = yesterdayHK();
        else if (periodType === "weekly") periodKey = currentPeriodWeek();
        else periodKey = currentPeriodMonth();
      }

      // Check stored asset_metrics first
      const { rows: stored } = await pools.rdycore.query(
        `SELECT asset_id, asset_type, revenue_cents, maintenance_cost_cents,
                downtime_minutes, booking_count, utilization_pct
         FROM asset_metrics
         WHERE workspace_id = $1 AND period_type = $2 AND period_key = $3
         ORDER BY revenue_cents DESC`,
        [wsId, periodType, periodKey],
      );

      if (stored.length > 0) {
        return text({
          period: { type: periodType, key: periodKey },
          assets: stored.map((r: any) => ({
            ...r,
            revenue_hkd: r.revenue_cents / 100,
            maintenance_hkd: r.maintenance_cost_cents / 100,
            net_revenue_hkd: (r.revenue_cents - r.maintenance_cost_cents) / 100,
          })),
        });
      }

      // Compute from bookings
      if (dbName === "racing") {
        // Per-rig analysis
        const { rows: rigs } = await pool.query(
          "SELECT id, slug, name FROM rigs WHERE workspace_id = $1 AND active = true",
          [wsId],
        );

        const dateFilter =
          periodType === "daily"
            ? "booking_date = $2"
            : periodType === "weekly"
              ? "booking_date >= CURRENT_DATE - INTERVAL '7 days'"
              : `booking_date >= (date_trunc('month', $2::date))::date AND booking_date < (date_trunc('month', $2::date) + INTERVAL '1 month')::date`;

        const assets = [];
        for (const rig of rigs) {
          const dateParam = periodType === "weekly" ? wsId : periodKey;
          const { rows: rigStats } = await pool.query(
            `SELECT
               COUNT(*)::int AS booking_count,
               COALESCE(SUM(final_price_cents), 0)::int AS revenue_cents,
               COALESCE(SUM(duration_minutes), 0)::int AS booked_minutes
             FROM bookings
             WHERE workspace_id = $1 AND rig_id = $3 AND status NOT IN ('cancelled')
               AND ${dateFilter}`,
            periodType === "weekly" ? [wsId, null, rig.id] : [wsId, periodKey, rig.id],
          );

          const s = rigStats[0];
          const wsRows = await pools.rdycore.query("SELECT config FROM workspaces WHERE id = $1", [
            wsId,
          ]);
          const opMinutes = getOperatingMinutes(wsRows.rows[0]?.config ?? {});
          const daysInPeriod = periodType === "daily" ? 1 : periodType === "weekly" ? 7 : 30;
          const totalMinutes = opMinutes * daysInPeriod;
          const utilPct =
            totalMinutes > 0 ? Math.round((s.booked_minutes / totalMinutes) * 10000) / 100 : 0;

          // Maintenance from business_costs tagged to equipment
          const { rows: maint } = await pools.rdycore.query(
            `SELECT COALESCE(SUM(CASE frequency
               WHEN 'monthly' THEN amount_cents
               WHEN 'weekly' THEN amount_cents * 4.33
               WHEN 'annual' THEN amount_cents / 12
               ELSE 0 END), 0)::int AS monthly_cost
             FROM business_costs
             WHERE workspace_id = $1 AND category = 'equipment'
               AND LOWER(name) LIKE $2`,
            [wsId, `%${rig.slug.toLowerCase()}%`],
          );
          const maintCents = Math.round((maint[0]?.monthly_cost ?? 0) * (daysInPeriod / 30));

          assets.push({
            asset_id: rig.slug,
            asset_type: "rig",
            name: rig.name,
            revenue_cents: s.revenue_cents,
            revenue_hkd: s.revenue_cents / 100,
            maintenance_cost_cents: maintCents,
            maintenance_hkd: maintCents / 100,
            net_revenue_hkd: (s.revenue_cents - maintCents) / 100,
            booking_count: s.booking_count,
            utilization_pct: utilPct,
            booked_minutes: s.booked_minutes,
          });

          // Store in asset_metrics
          await pools.rdycore.query(
            `INSERT INTO asset_metrics (workspace_id, asset_type, asset_id, period_type, period_key,
               revenue_cents, maintenance_cost_cents, booking_count, utilization_pct)
             VALUES ($1, 'rig', $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (workspace_id, asset_id, period_type, period_key)
             DO UPDATE SET revenue_cents = $5, maintenance_cost_cents = $6,
               booking_count = $7, utilization_pct = $8`,
            [
              wsId,
              rig.slug,
              periodType,
              periodKey,
              s.revenue_cents,
              maintCents,
              s.booking_count,
              utilPct,
            ],
          );
        }

        return text({ period: { type: periodType, key: periodKey }, assets });
      }

      // Golf: single bay
      const revenueCol = "(final_price * 100)::int";
      const dateFilter =
        periodType === "daily"
          ? "booking_date = $2"
          : `booking_date >= (date_trunc('month', $2::date))::date AND booking_date < (date_trunc('month', $2::date) + INTERVAL '1 month')::date`;

      const { rows: bayStats } = await pool.query(
        `SELECT COUNT(*)::int AS booking_count,
                COALESCE(SUM(${revenueCol}), 0)::int AS revenue_cents,
                COALESCE(SUM(duration_minutes), 0)::int AS booked_minutes
         FROM bookings
         WHERE workspace_id = $1 AND status NOT IN ('cancelled') AND ${dateFilter}`,
        [wsId, periodKey],
      );
      const bs = bayStats[0];
      const wsConfigRows = await pools.rdycore.query(
        "SELECT config FROM workspaces WHERE id = $1",
        [wsId],
      );
      const opMin = getOperatingMinutes(wsConfigRows.rows[0]?.config ?? {});
      const dayCount = periodType === "daily" ? 1 : 30;
      const utilPctGolf =
        opMin * dayCount > 0
          ? Math.round((bs.booked_minutes / (opMin * dayCount)) * 10000) / 100
          : 0;

      await pools.rdycore.query(
        `INSERT INTO asset_metrics (workspace_id, asset_type, asset_id, period_type, period_key,
           revenue_cents, booking_count, utilization_pct)
         VALUES ($1, 'bay', 'bay-1', $2, $3, $4, $5, $6)
         ON CONFLICT (workspace_id, asset_id, period_type, period_key)
         DO UPDATE SET revenue_cents = $4, booking_count = $5, utilization_pct = $6`,
        [wsId, periodType, periodKey, bs.revenue_cents, bs.booking_count, utilPctGolf],
      );

      return text({
        period: { type: periodType, key: periodKey },
        assets: [
          {
            asset_id: "bay-1",
            asset_type: "bay",
            revenue_cents: bs.revenue_cents,
            revenue_hkd: bs.revenue_cents / 100,
            booking_count: bs.booking_count,
            utilization_pct: utilPctGolf,
          },
        ],
      });
    },
  });

  // ============================================================
  //  TOOL: staff_performance — coach/staff analytics
  // ============================================================

  api.registerTool({
    name: "staff_performance",
    description:
      "Revenue per coach, booking count, and repeat customer rate. " +
      "Shows which coaches drive the most revenue and retain customers.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        period_type: { type: "string", description: "daily, weekly, monthly (default: monthly)" },
        period_key: { type: "string", description: "Period key (default: current month)" },
      },
      required: [],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;
      const dbName = await resolveDbName(wsId);
      if (!dbName) return text({ error: "Workspace not found" });

      const pool = getPool(dbName);
      const periodType = p.period_type ?? "monthly";
      let periodKey = p.period_key;
      if (!periodKey) {
        if (periodType === "daily") periodKey = yesterdayHK();
        else if (periodType === "weekly") periodKey = currentPeriodWeek();
        else periodKey = currentPeriodMonth();
      }

      const revenueExpr = dbName === "racing" ? "final_price_cents" : "(final_price * 100)::int";

      // Date filter
      const dateFilter =
        periodType === "daily"
          ? "b.booking_date = $2::date"
          : periodType === "weekly"
            ? "b.booking_date >= CURRENT_DATE - INTERVAL '7 days'"
            : `b.booking_date >= (date_trunc('month', $2::date))::date AND b.booking_date < (date_trunc('month', $2::date) + INTERVAL '1 month')::date`;

      const { rows: coachStats } = await pool.query(
        `SELECT
           c.id AS coach_id,
           c.name AS coach_name,
           COUNT(b.id)::int AS booking_count,
           COALESCE(SUM(b.duration_minutes), 0)::int AS total_minutes,
           COALESCE(SUM(${revenueExpr}), 0)::int AS revenue_cents,
           COUNT(DISTINCT b.customer_email)::int AS unique_customers
         FROM coaches c
         LEFT JOIN bookings b ON b.coach_id = c.id
           AND b.workspace_id = $1 AND b.status NOT IN ('cancelled')
           AND ${dateFilter}
         WHERE c.workspace_id = $1 AND c.is_active = true
         GROUP BY c.id, c.name
         ORDER BY revenue_cents DESC`,
        periodType === "weekly" ? [wsId] : [wsId, periodKey],
      );

      // Repeat customer rate per coach: customers who booked >1 time with same coach
      const coachResults = [];
      for (const cs of coachStats) {
        let repeatRate = 0;
        if (cs.unique_customers > 0) {
          const { rows: repeats } = await pool.query(
            `SELECT COUNT(*)::int AS repeat_customers
             FROM (
               SELECT customer_email
               FROM bookings
               WHERE coach_id = $1 AND workspace_id = $2 AND status NOT IN ('cancelled')
                 AND booking_date >= CURRENT_DATE - INTERVAL '90 days'
               GROUP BY customer_email
               HAVING COUNT(*) > 1
             ) sub`,
            [cs.coach_id, wsId],
          );
          repeatRate =
            cs.unique_customers > 0
              ? Math.round((repeats[0].repeat_customers / cs.unique_customers) * 10000) / 100
              : 0;
        }

        const hoursWorked = cs.total_minutes / 60;
        coachResults.push({
          coach_name: cs.coach_name,
          booking_count: cs.booking_count,
          revenue_hkd: cs.revenue_cents / 100,
          hours_worked: Math.round(hoursWorked * 100) / 100,
          revenue_per_hour_hkd:
            hoursWorked > 0 ? Math.round(cs.revenue_cents / hoursWorked / 100) : 0,
          unique_customers: cs.unique_customers,
          repeat_customer_rate_pct: repeatRate,
        });
      }

      return text({
        period: { type: periodType, key: periodKey },
        coaches: coachResults,
        total_revenue_hkd: coachResults.reduce((s, c) => s + c.revenue_hkd, 0),
        total_bookings: coachResults.reduce((s, c) => s + c.booking_count, 0),
      });
    },
  });

  // ============================================================
  //  Dynamic pricing suggestions (called after daily snapshot)
  // ============================================================

  async function generatePricingSuggestions(workspaceId: string): Promise<void> {
    const dbName = await resolveDbName(workspaceId);
    if (!dbName) return;

    const pool = getPool(dbName);
    const timeCol = dbName === "racing" ? "start_time" : "booking_time";

    // Resource count
    let resourceCount = 1;
    if (dbName === "racing") {
      const { rows: rigs } = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM rigs WHERE workspace_id = $1 AND active = true",
        [workspaceId],
      );
      resourceCount = rigs[0]?.cnt ?? 1;
    }

    // Check bookings 3+ days out — surge pricing candidates
    const { rows: futureBookings } = await pool.query(
      `SELECT booking_date, COUNT(*)::int AS cnt
       FROM bookings
       WHERE workspace_id = $1
         AND booking_date >= CURRENT_DATE + INTERVAL '3 days'
         AND booking_date <= CURRENT_DATE + INTERVAL '14 days'
         AND status NOT IN ('cancelled')
       GROUP BY booking_date
       HAVING COUNT(*) >= $2 * 0.9`,
      [workspaceId, resourceCount * 13], // ~90% of slots (13 hours * resources)
    );

    for (const fb of futureBookings) {
      await pools.rdycore.query(
        `INSERT INTO optimization_actions (workspace_id, recommendation, category, expected_impact_pct, priority)
         SELECT $1, $2, 'pricing', 15, 'high'
         WHERE NOT EXISTS (
           SELECT 1 FROM optimization_actions
           WHERE workspace_id = $1 AND category = 'pricing' AND status = 'suggested'
             AND recommendation LIKE $3
         )`,
        [
          workspaceId,
          `Surge pricing opportunity on ${fb.booking_date}: ${fb.cnt} bookings already (${Math.round((fb.cnt / (resourceCount * 13)) * 100)}% fill). Consider +10-20% premium.`,
          `%${fb.booking_date}%`,
        ],
      );
    }

    // Check tomorrow's empty slots — flash deal candidates
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString("sv-SE", { timeZone: "Asia/Hong_Kong" });

    const { rows: tomorrowBookings } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM bookings
       WHERE workspace_id = $1 AND booking_date = $2 AND status NOT IN ('cancelled')`,
      [workspaceId, tomorrowStr],
    );

    const tomorrowFillPct =
      resourceCount * 13 > 0 ? (tomorrowBookings[0].cnt / (resourceCount * 13)) * 100 : 0;

    if (tomorrowFillPct < 40) {
      await pools.rdycore.query(
        `INSERT INTO optimization_actions (workspace_id, recommendation, category, expected_impact_pct, priority)
         SELECT $1, $2, 'pricing', 10, 'medium'
         WHERE NOT EXISTS (
           SELECT 1 FROM optimization_actions
           WHERE workspace_id = $1 AND category = 'pricing' AND status = 'suggested'
             AND recommendation LIKE $3
         )`,
        [
          workspaceId,
          `Flash deal for ${tomorrowStr}: Only ${Math.round(tomorrowFillPct)}% filled. Consider last-minute member discount to fill gaps.`,
          `%${tomorrowStr}%flash%`,
        ],
      );
    }

    // Check for consistent weekly gaps (happy hour candidates)
    const { rows: weeklyGaps } = await pool.query(
      `SELECT
         EXTRACT(DOW FROM booking_date)::int AS dow,
         EXTRACT(HOUR FROM ${timeCol})::int AS hour,
         COUNT(*)::numeric / NULLIF(COUNT(DISTINCT booking_date), 0) AS avg_per_day
       FROM bookings
       WHERE workspace_id = $1
         AND booking_date >= CURRENT_DATE - INTERVAL '28 days'
         AND booking_date < CURRENT_DATE
         AND status NOT IN ('cancelled')
       GROUP BY 1, 2
       HAVING COUNT(*)::numeric / NULLIF(COUNT(DISTINCT booking_date), 0) < $2 * 0.3`,
      [workspaceId, resourceCount],
    );

    if (weeklyGaps.length >= 5) {
      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const gapSummary = weeklyGaps
        .slice(0, 5)
        .map((g: any) => `${dayNames[g.dow]} ${g.hour}:00`)
        .join(", ");

      await pools.rdycore.query(
        `INSERT INTO optimization_actions (workspace_id, recommendation, category, expected_impact_pct, priority)
         SELECT $1, $2, 'pricing', 8, 'medium'
         WHERE NOT EXISTS (
           SELECT 1 FROM optimization_actions
           WHERE workspace_id = $1 AND category = 'pricing' AND status = 'suggested'
             AND recommendation LIKE '%happy hour%'
             AND created_at > CURRENT_DATE - INTERVAL '7 days'
         )`,
        [
          workspaceId,
          `Happy hour opportunity: ${weeklyGaps.length} consistently low-fill time slots detected (e.g. ${gapSummary}). Consider discounted rates to drive traffic.`,
        ],
      );
    }
  }

  // ============================================================
  //  TOOL: churn_alerts — at-risk member identification
  // ============================================================

  api.registerTool({
    name: "churn_alerts",
    description:
      "Identify at-risk members based on booking recency. Scores churn risk " +
      "(low <14d, medium 14-30d, high 30-60d, churned >60d). " +
      "Updates customer_signals table and returns members needing outreach.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        risk_level: {
          type: "string",
          description: "Filter by risk: low, medium, high, churned (default: all at-risk)",
        },
        refresh: { type: "boolean", description: "Force recalculate signals (default: false)" },
      },
      required: [],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;
      const dbName = await resolveDbName(wsId);
      if (!dbName) return text({ error: "Workspace not found" });

      const pool = getPool(dbName);

      // Get all members with their last booking date in this vertical
      const { rows: memberBookings } = await pool.query(
        `SELECT b.customer_email, MAX(b.booking_date) AS last_booking
         FROM bookings b
         WHERE b.workspace_id = $1 AND b.status NOT IN ('cancelled')
         GROUP BY b.customer_email`,
        [wsId],
      );

      // Map email → last booking date
      const lastBookingMap = new Map<string, string>();
      for (const mb of memberBookings) {
        if (mb.customer_email) lastBookingMap.set(mb.customer_email, mb.last_booking);
      }

      // Get members linked to this workspace's tenant
      const { rows: members } = await pools.rdycore.query(
        `SELECT m.id, m.email, m.name, m.membership_tier
         FROM members m
         JOIN tenant_workspaces tw ON tw.tenant_id = m.tenant_id
         WHERE tw.workspace_id = $1`,
        [wsId],
      );

      const today = new Date(todayHK());
      const signals = [];

      for (const member of members) {
        const lastDateStr = lastBookingMap.get(member.email);
        const lastDate = lastDateStr ? new Date(lastDateStr) : null;
        const daysSince = lastDate
          ? Math.floor((today.getTime() - lastDate.getTime()) / 86400000)
          : 999;

        const risk =
          daysSince < 14 ? "low" : daysSince < 30 ? "medium" : daysSince < 60 ? "high" : "churned";

        const outreach =
          risk === "medium"
            ? `Send a check-in message to ${member.name ?? member.email} — ${daysSince} days since last visit`
            : risk === "high"
              ? `Urgent: ${member.name ?? member.email} hasn't visited in ${daysSince} days. Consider a comeback offer.`
              : risk === "churned"
                ? `${member.name ?? member.email} appears churned (${daysSince}d). Win-back campaign recommended.`
                : null;

        // Upsert into customer_signals
        if (p.refresh || risk !== "low") {
          await pools.rdycore.query(
            `INSERT INTO customer_signals (member_id, workspace_id, last_booking_date, days_since_last_booking, churn_risk, suggested_outreach)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (member_id, workspace_id)
             DO UPDATE SET last_booking_date = $3, days_since_last_booking = $4, churn_risk = $5,
               suggested_outreach = $6, updated_at = now()`,
            [member.id, wsId, lastDate, daysSince, risk, outreach],
          );
        }

        if (risk !== "low") {
          signals.push({
            member_name: member.name,
            email: member.email,
            tier: member.membership_tier,
            last_booking: lastDateStr ?? "never",
            days_since: daysSince,
            churn_risk: risk,
            suggested_outreach: outreach,
          });
        }
      }

      // Filter by risk level if requested
      const filtered = p.risk_level
        ? signals.filter((s) => s.churn_risk === p.risk_level)
        : signals;

      return text({
        total_at_risk: filtered.length,
        by_risk: {
          medium: filtered.filter((s) => s.churn_risk === "medium").length,
          high: filtered.filter((s) => s.churn_risk === "high").length,
          churned: filtered.filter((s) => s.churn_risk === "churned").length,
        },
        members: filtered.sort((a, b) => b.days_since - a.days_since),
      });
    },
  });

  // ============================================================
  //  TOOL: membership_funnel — conversion tracking
  // ============================================================

  api.registerTool({
    name: "membership_funnel",
    description:
      "Track membership conversion rates: walk-in → member → VIP. " +
      "Shows how many customers at each tier, recent conversions, and time-to-convert.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        period_months: { type: "number", description: "Lookback period in months (default: 3)" },
      },
      required: [],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;
      const months = p.period_months ?? 3;

      // Get member tier distribution for this workspace
      const { rows: tierDist } = await pools.rdycore.query(
        `SELECT m.membership_tier, COUNT(*)::int AS cnt
         FROM members m
         JOIN tenant_workspaces tw ON tw.tenant_id = m.tenant_id
         WHERE tw.workspace_id = $1
         GROUP BY m.membership_tier
         ORDER BY cnt DESC`,
        [wsId],
      );

      // Recent tier upgrades (members updated in last N months)
      const { rows: recentUpgrades } = await pools.rdycore.query(
        `SELECT m.membership_tier, COUNT(*)::int AS cnt
         FROM members m
         JOIN tenant_workspaces tw ON tw.tenant_id = m.tenant_id
         WHERE tw.workspace_id = $1
           AND m.updated_at > NOW() - ($2 || ' months')::interval
           AND m.membership_tier != 'basic'
         GROUP BY m.membership_tier`,
        [wsId, months],
      );

      // New members in period
      const { rows: newMembers } = await pools.rdycore.query(
        `SELECT COUNT(*)::int AS cnt,
                COUNT(*) FILTER (WHERE m.membership_tier != 'basic')::int AS converted
         FROM members m
         JOIN tenant_workspaces tw ON tw.tenant_id = m.tenant_id
         WHERE tw.workspace_id = $1
           AND m.created_at > NOW() - ($2 || ' months')::interval`,
        [wsId, months],
      );

      // Walk-in detection: unique booking emails NOT in members
      const dbName = await resolveDbName(wsId);
      if (!dbName) return text({ error: "Workspace not found" });
      const pool = getPool(dbName);

      const { rows: walkIns } = await pool.query(
        `SELECT COUNT(DISTINCT customer_email)::int AS cnt
         FROM bookings
         WHERE workspace_id = $1
           AND booking_date > CURRENT_DATE - ($2 || ' months')::interval
           AND status NOT IN ('cancelled')
           AND customer_email NOT IN (
             SELECT m.email FROM members m
             JOIN tenant_workspaces tw ON tw.tenant_id = m.tenant_id
             WHERE tw.workspace_id = $1
           )`,
        [wsId, months],
      );

      const totalCustomers =
        (walkIns[0]?.cnt ?? 0) + tierDist.reduce((s: number, t: any) => s + t.cnt, 0);
      const memberCount = tierDist.reduce((s: number, t: any) => s + t.cnt, 0);
      const conversionRate =
        totalCustomers > 0 ? Math.round((memberCount / totalCustomers) * 10000) / 100 : 0;

      return text({
        period_months: months,
        funnel: {
          total_unique_customers: totalCustomers,
          walk_ins: walkIns[0]?.cnt ?? 0,
          members: memberCount,
          conversion_rate_pct: conversionRate,
        },
        tier_distribution: tierDist,
        recent_upgrades: recentUpgrades,
        new_members_in_period: newMembers[0]?.cnt ?? 0,
        new_members_converted: newMembers[0]?.converted ?? 0,
      });
    },
  });

  // ============================================================
  //  TOOL: segment_analysis — per-segment profitability
  // ============================================================

  api.registerTool({
    name: "segment_analysis",
    description:
      "Profitability breakdown by customer segment (VIP, member, walk-in). " +
      "Shows revenue, bookings, avg ticket, and retention per segment.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        period_type: { type: "string", description: "daily, weekly, monthly (default: monthly)" },
        period_key: { type: "string", description: "Period key (default: current)" },
      },
      required: [],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;
      const dbName = await resolveDbName(wsId);
      if (!dbName) return text({ error: "Workspace not found" });

      const pool = getPool(dbName);
      const periodType = p.period_type ?? "monthly";
      let periodKey = p.period_key;
      if (!periodKey) {
        if (periodType === "daily") periodKey = yesterdayHK();
        else if (periodType === "weekly") periodKey = currentPeriodWeek();
        else periodKey = currentPeriodMonth();
      }

      // Check stored segment_snapshots first
      const { rows: stored } = await pools.rdycore.query(
        `SELECT segment, metrics FROM segment_snapshots
         WHERE workspace_id = $1 AND period_type = $2 AND period_key = $3`,
        [wsId, periodType, periodKey],
      );

      if (stored.length > 0) {
        return text({
          period: { type: periodType, key: periodKey },
          segments: stored.map((r: any) => ({
            segment: r.segment,
            ...(typeof r.metrics === "string" ? JSON.parse(r.metrics) : r.metrics),
          })),
        });
      }

      // Compute from bookings — join with members to get tier
      const revenueExpr =
        dbName === "racing" ? "b.final_price_cents" : "(b.final_price * 100)::int";
      const dateFilter =
        periodType === "daily"
          ? "b.booking_date = $2::date"
          : periodType === "weekly"
            ? "b.booking_date >= CURRENT_DATE - INTERVAL '7 days'"
            : `b.booking_date >= (date_trunc('month', $2::date))::date AND b.booking_date < (date_trunc('month', $2::date) + INTERVAL '1 month')::date`;

      const { rows: segmentStats } = await pool.query(
        `SELECT
           COALESCE(
             CASE
               WHEN m.membership_tier IN ('vip', 'VIP') THEN 'vip'
               WHEN m.membership_tier IN ('basic', 'member', 'pro') THEN 'member'
               ELSE 'walk_in'
             END, 'walk_in'
           ) AS segment,
           COUNT(b.id)::int AS bookings,
           COALESCE(SUM(${revenueExpr}), 0)::int AS revenue_cents,
           COUNT(DISTINCT b.customer_email)::int AS unique_customers
         FROM bookings b
         LEFT JOIN members m ON m.email = b.customer_email
         WHERE b.workspace_id = $1 AND b.status NOT IN ('cancelled')
           AND ${dateFilter}
         GROUP BY 1`,
        periodType === "weekly" ? [wsId] : [wsId, periodKey],
      );

      const segments = segmentStats.map((s: any) => {
        const avgTicket = s.bookings > 0 ? Math.round(s.revenue_cents / s.bookings) : 0;
        const metrics = {
          revenue_cents: s.revenue_cents,
          revenue_hkd: s.revenue_cents / 100,
          bookings: s.bookings,
          avg_ticket_cents: avgTicket,
          avg_ticket_hkd: avgTicket / 100,
          unique_customers: s.unique_customers,
        };

        // Store snapshot
        pools.rdycore.query(
          `INSERT INTO segment_snapshots (workspace_id, period_type, period_key, segment, metrics)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workspace_id, period_type, period_key, segment)
           DO UPDATE SET metrics = $5`,
          [wsId, periodType, periodKey, s.segment, JSON.stringify(metrics)],
        );

        return { segment: s.segment, ...metrics };
      });

      return text({
        period: { type: periodType, key: periodKey },
        segments,
        total_revenue_hkd: segments.reduce((s: number, seg: any) => s + seg.revenue_hkd, 0),
      });
    },
  });

  // ============================================================
  //  TOOL: cross_sell_detect — cross-vertical opportunity finder
  // ============================================================

  api.registerTool({
    name: "cross_sell_detect",
    description:
      "Find members who only book in one vertical (golf or racing) and flag them " +
      "as cross-sell opportunities. Updates customer_signals with suggestions.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
      },
      required: [],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;

      // Get members for this workspace's tenant
      const { rows: members } = await pools.rdycore.query(
        `SELECT m.id, m.email, m.name
         FROM members m
         JOIN tenant_workspaces tw ON tw.tenant_id = m.tenant_id
         WHERE tw.workspace_id = $1`,
        [wsId],
      );

      // Check bookings in both verticals for each member
      const golfPool = getPool("golf");
      const racingPool = getPool("racing");

      const opportunities = [];

      for (const member of members) {
        const { rows: golfBookings } = await golfPool.query(
          `SELECT COUNT(*)::int AS cnt FROM bookings
           WHERE customer_email = $1 AND status NOT IN ('cancelled')
             AND booking_date >= CURRENT_DATE - INTERVAL '180 days'`,
          [member.email],
        );

        const { rows: racingBookings } = await racingPool.query(
          `SELECT COUNT(*)::int AS cnt FROM bookings
           WHERE customer_email = $1 AND status NOT IN ('cancelled')
             AND booking_date >= CURRENT_DATE - INTERVAL '180 days'`,
          [member.email],
        );

        const hasGolf = (golfBookings[0]?.cnt ?? 0) > 0;
        const hasRacing = (racingBookings[0]?.cnt ?? 0) > 0;

        let opportunity: string | null = null;
        let suggestion: string | null = null;

        if (hasGolf && !hasRacing) {
          opportunity = "golf_to_racing";
          suggestion = `${member.name ?? member.email} is a golf-only customer. Offer a racing trial session.`;
        } else if (hasRacing && !hasGolf) {
          opportunity = "racing_to_golf";
          suggestion = `${member.name ?? member.email} is a racing-only customer. Offer a golf intro package.`;
        }

        if (opportunity) {
          await pools.rdycore.query(
            `INSERT INTO customer_signals (member_id, workspace_id, cross_sell_opportunity, suggested_outreach)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (member_id, workspace_id)
             DO UPDATE SET cross_sell_opportunity = $3,
               suggested_outreach = COALESCE(customer_signals.suggested_outreach, '') || E'\n' || $4,
               updated_at = now()`,
            [member.id, wsId, opportunity, suggestion],
          );

          opportunities.push({
            member_name: member.name,
            email: member.email,
            opportunity,
            suggestion,
            golf_bookings: golfBookings[0]?.cnt ?? 0,
            racing_bookings: racingBookings[0]?.cnt ?? 0,
          });
        }
      }

      return text({
        total_opportunities: opportunities.length,
        by_type: {
          golf_to_racing: opportunities.filter((o) => o.opportunity === "golf_to_racing").length,
          racing_to_golf: opportunities.filter((o) => o.opportunity === "racing_to_golf").length,
        },
        opportunities,
      });
    },
  });

  // ============================================================
  //  TOOL: benchmark_compare — competitor benchmarking
  // ============================================================

  api.registerTool({
    name: "benchmark_compare",
    description:
      "Compare your KPIs against competitor benchmarks. " +
      "Use action=list to see stored benchmarks, action=add to add a benchmark, " +
      "action=compare to see your performance vs competitors.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        action: { type: "string", description: "list, add, delete, compare" },
        benchmark_id: { type: "string", description: "Benchmark UUID (for delete)" },
        competitor_name: { type: "string", description: "Competitor name or 'industry_average'" },
        metric: {
          type: "string",
          description: "Metric name (e.g. price_per_hour, utilization_rate)",
        },
        value: { type: "number", description: "Benchmark value" },
        source: {
          type: "string",
          description: "manual, web_scrape, industry_report (default: manual)",
        },
      },
      required: ["action"],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;

      if (p.action === "list") {
        const { rows } = await pools.rdycore.query(
          `SELECT id, competitor_name, metric, value, source, recorded_at
           FROM competitor_benchmarks
           WHERE workspace_id = $1
           ORDER BY competitor_name, metric`,
          [wsId],
        );
        return text({ benchmarks: rows, total: rows.length });
      }

      if (p.action === "add") {
        if (!p.competitor_name || !p.metric || p.value === undefined) {
          return text({ error: "competitor_name, metric, and value are required" });
        }
        const { rows } = await pools.rdycore.query(
          `INSERT INTO competitor_benchmarks (workspace_id, competitor_name, metric, value, source)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, competitor_name, metric, value`,
          [wsId, p.competitor_name, p.metric, p.value, p.source ?? "manual"],
        );
        return text({ message: "Benchmark added", benchmark: rows[0] });
      }

      if (p.action === "delete") {
        if (!p.benchmark_id) return text({ error: "benchmark_id required" });
        const { rowCount } = await pools.rdycore.query(
          "DELETE FROM competitor_benchmarks WHERE id = $1",
          [p.benchmark_id],
        );
        return text({ message: rowCount ? "Benchmark deleted" : "Not found" });
      }

      if (p.action === "compare") {
        // Get latest benchmarks
        const { rows: benchmarks } = await pools.rdycore.query(
          `SELECT DISTINCT ON (competitor_name, metric)
             competitor_name, metric, value, source, recorded_at
           FROM competitor_benchmarks
           WHERE workspace_id = $1
           ORDER BY competitor_name, metric, recorded_at DESC`,
          [wsId],
        );

        if (benchmarks.length === 0) {
          return text({ error: "No benchmarks stored. Use action=add to add competitor data." });
        }

        // Get own KPIs from latest monthly snapshot
        const { rows: ownSnaps } = await pools.rdycore.query(
          `SELECT metrics FROM profitability_snapshots
           WHERE workspace_id = $1 AND period_type = 'daily'
           ORDER BY period_key DESC LIMIT 30`,
          [wsId],
        );

        const ownMetrics: Record<string, number> = {};
        if (ownSnaps.length > 0) {
          let totalRev = 0,
            totalBookings = 0,
            totalUtil = 0;
          for (const s of ownSnaps) {
            const m = typeof s.metrics === "string" ? JSON.parse(s.metrics) : s.metrics;
            totalRev += m.revenue_cents ?? 0;
            totalBookings += m.booking_count ?? 0;
            totalUtil += m.utilization_pct ?? 0;
          }
          ownMetrics["utilization_rate"] = Math.round((totalUtil / ownSnaps.length) * 100) / 100;
          ownMetrics["avg_ticket"] =
            totalBookings > 0 ? Math.round(totalRev / totalBookings) / 100 : 0;
          ownMetrics["monthly_revenue"] = Math.round(totalRev / 100);
          ownMetrics["daily_bookings"] = Math.round((totalBookings / ownSnaps.length) * 100) / 100;
        }

        const comparisons = benchmarks.map((b: any) => {
          const ownVal = ownMetrics[b.metric];
          const diff =
            ownVal !== undefined && b.value > 0
              ? Math.round(((ownVal - b.value) / b.value) * 10000) / 100
              : null;
          return {
            competitor: b.competitor_name,
            metric: b.metric,
            their_value: b.value,
            your_value: ownVal ?? "no data",
            diff_pct: diff,
            status:
              diff === null ? "no data" : diff > 5 ? "ahead" : diff < -5 ? "behind" : "similar",
          };
        });

        return text({ comparisons });
      }

      return text({ error: `Unknown action: ${p.action}` });
    },
  });

  // ============================================================
  //  TOOL: break_even_analysis — break-even calculator
  // ============================================================

  api.registerTool({
    name: "break_even_analysis",
    description:
      "Calculate break-even point: how many days of revenue at current pace " +
      "covers total monthly costs. Shows fixed vs variable cost split.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
      },
      required: [],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;

      // Monthly costs
      const { rows: costs } = await pools.rdycore.query(
        `SELECT
           COALESCE(SUM(CASE frequency
             WHEN 'monthly' THEN amount_cents
             WHEN 'weekly' THEN amount_cents * 4.33
             WHEN 'annual' THEN amount_cents / 12
             ELSE 0 END), 0)::int AS monthly_cost_cents,
           COALESCE(SUM(CASE WHEN frequency = 'one_time' THEN amount_cents ELSE 0 END), 0)::int AS one_time_cents
         FROM business_costs
         WHERE workspace_id = $1
           AND effective_from <= CURRENT_DATE
           AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)`,
        [wsId],
      );

      const monthlyCostCents = costs[0]?.monthly_cost_cents ?? 0;

      // Avg daily revenue from last 30 daily snapshots
      const { rows: revSnaps } = await pools.rdycore.query(
        `SELECT AVG((metrics->>'revenue_cents')::int)::int AS avg_daily_revenue
         FROM profitability_snapshots
         WHERE workspace_id = $1 AND period_type = 'daily'
         ORDER BY period_key DESC LIMIT 30`,
        [wsId],
      );

      const avgDailyRevenue = revSnaps[0]?.avg_daily_revenue ?? 0;
      const breakEvenDays =
        avgDailyRevenue > 0 ? Math.ceil(monthlyCostCents / avgDailyRevenue) : null;

      // Cost breakdown by category
      const { rows: costBreakdown } = await pools.rdycore.query(
        `SELECT category,
           COALESCE(SUM(CASE frequency
             WHEN 'monthly' THEN amount_cents
             WHEN 'weekly' THEN amount_cents * 4.33
             WHEN 'annual' THEN amount_cents / 12
             ELSE 0 END), 0)::int AS monthly_cents
         FROM business_costs
         WHERE workspace_id = $1
           AND effective_from <= CURRENT_DATE
           AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
         GROUP BY category
         ORDER BY monthly_cents DESC`,
        [wsId],
      );

      return text({
        monthly_costs_hkd: monthlyCostCents / 100,
        avg_daily_revenue_hkd: avgDailyRevenue / 100,
        break_even_days: breakEvenDays,
        break_even_status:
          breakEvenDays === null
            ? "no revenue data"
            : breakEvenDays <= 30
              ? `profitable — break even in ${breakEvenDays} days`
              : `not yet profitable — need ${breakEvenDays} days at current pace`,
        cost_breakdown: costBreakdown.map((c: any) => ({
          category: c.category,
          monthly_hkd: c.monthly_cents / 100,
        })),
        one_time_costs_hkd: (costs[0]?.one_time_cents ?? 0) / 100,
      });
    },
  });

  // ============================================================
  //  TOOL: cash_flow_forecast — projected cash flow
  // ============================================================

  api.registerTool({
    name: "cash_flow_forecast",
    description:
      "Project cash flow for next N periods based on historical revenue/cost patterns. " +
      "Shows expected cash in/out and net position.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        periods_ahead: { type: "number", description: "Number of months to forecast (default: 3)" },
      },
      required: [],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;
      const periodsAhead = p.periods_ahead ?? 3;

      // Historical monthly totals (last 6 months)
      const { rows: monthlyHistory } = await pools.rdycore.query(
        `SELECT
           LEFT(period_key, 7) AS month,
           SUM((metrics->>'revenue_cents')::int) AS revenue_cents,
           SUM((metrics->>'cost_cents')::int) AS cost_cents,
           SUM((metrics->>'credit_topups_cents')::int) AS topups_cents,
           SUM((metrics->>'refunds_cents')::int) AS refunds_cents
         FROM profitability_snapshots
         WHERE workspace_id = $1 AND period_type = 'daily'
         GROUP BY 1
         ORDER BY 1 DESC
         LIMIT 6`,
        [wsId],
      );

      if (monthlyHistory.length === 0) {
        return text({ error: "No historical data. Run take_snapshot first." });
      }

      // Average monthly figures
      const avgRevenue = Math.round(
        monthlyHistory.reduce((s: number, m: any) => s + (m.revenue_cents ?? 0), 0) /
          monthlyHistory.length,
      );
      const avgCost = Math.round(
        monthlyHistory.reduce((s: number, m: any) => s + (m.cost_cents ?? 0), 0) /
          monthlyHistory.length,
      );
      const avgTopups = Math.round(
        monthlyHistory.reduce((s: number, m: any) => s + (m.topups_cents ?? 0), 0) /
          monthlyHistory.length,
      );
      const avgRefunds = Math.round(
        monthlyHistory.reduce((s: number, m: any) => s + (m.refunds_cents ?? 0), 0) /
          monthlyHistory.length,
      );

      // Growth trend (simple linear)
      const recentRevenue =
        monthlyHistory.length >= 2 ? (monthlyHistory[0]?.revenue_cents ?? 0) : avgRevenue;
      const olderRevenue =
        monthlyHistory.length >= 2
          ? (monthlyHistory[monthlyHistory.length - 1]?.revenue_cents ?? 0)
          : avgRevenue;
      const growthRate =
        olderRevenue > 0
          ? (recentRevenue - olderRevenue) / olderRevenue / Math.max(monthlyHistory.length - 1, 1)
          : 0;

      // Project forward
      const forecast = [];
      let cumulativeNet = 0;

      for (let i = 1; i <= periodsAhead; i++) {
        const projDate = new Date();
        projDate.setMonth(projDate.getMonth() + i);
        const monthKey = projDate
          .toLocaleDateString("sv-SE", { timeZone: "Asia/Hong_Kong" })
          .slice(0, 7);

        const growthFactor = 1 + growthRate * i;
        const projRevenue = Math.round(avgRevenue * growthFactor);
        const projCashIn = projRevenue + avgTopups;
        const projCashOut = avgCost + avgRefunds;
        const netFlow = projCashIn - projCashOut;
        cumulativeNet += netFlow;

        forecast.push({
          month: monthKey,
          projected_revenue_hkd: projRevenue / 100,
          projected_costs_hkd: avgCost / 100,
          cash_in_hkd: projCashIn / 100,
          cash_out_hkd: projCashOut / 100,
          net_flow_hkd: netFlow / 100,
          cumulative_net_hkd: cumulativeNet / 100,
        });
      }

      return text({
        based_on_months: monthlyHistory.length,
        monthly_growth_rate_pct: Math.round(growthRate * 10000) / 100,
        historical: monthlyHistory.reverse().map((m: any) => ({
          month: m.month,
          revenue_hkd: (m.revenue_cents ?? 0) / 100,
          cost_hkd: (m.cost_cents ?? 0) / 100,
          net_hkd: ((m.revenue_cents ?? 0) - (m.cost_cents ?? 0)) / 100,
        })),
        forecast,
      });
    },
  });

  // ============================================================
  //  TOOL: xero_sync — Xero accounting integration
  // ============================================================

  api.registerTool({
    name: "xero_sync",
    description:
      "Connect to Xero accounting and sync expenses into business_costs. " +
      "Actions: status (check connection), connect (get OAuth URL), callback (complete OAuth with code), " +
      "sync (pull recent expenses), disconnect (remove connection).",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        action: { type: "string", description: "status, connect, callback, sync, disconnect" },
        code: { type: "string", description: "OAuth authorization code (for callback action)" },
        months: { type: "number", description: "Months of expenses to sync (default: 3)" },
      },
      required: ["action"],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;

      // Xero OAuth2 config — stored as workspace config or env
      const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID ?? "";
      const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET ?? "";
      const XERO_REDIRECT_URI =
        process.env.XERO_REDIRECT_URI ?? "https://openclaw.rdylimited.com/webhooks/xero-callback";
      const XERO_SCOPES =
        "openid profile email accounting.transactions.read accounting.contacts.read offline_access";

      if (p.action === "status") {
        const { rows } = await pools.rdycore.query(
          `SELECT config->'xero' AS xero FROM workspaces WHERE id = $1`,
          [wsId],
        );
        const xero = rows[0]?.xero;
        if (!xero || !xero.access_token) {
          return text({
            connected: false,
            message: "Xero not connected. Use action=connect to start OAuth.",
          });
        }
        return text({
          connected: true,
          tenant_name: xero.tenant_name ?? "unknown",
          last_sync: xero.last_sync ?? "never",
          token_expires: xero.expires_at ?? "unknown",
        });
      }

      if (p.action === "connect") {
        if (!XERO_CLIENT_ID) {
          return text({
            error:
              "XERO_CLIENT_ID not configured. Set env vars XERO_CLIENT_ID and XERO_CLIENT_SECRET.",
          });
        }
        const state = `${wsId}:${Date.now()}`;
        const authUrl =
          `https://login.xero.com/identity/connect/authorize?` +
          `response_type=code&client_id=${XERO_CLIENT_ID}&redirect_uri=${encodeURIComponent(XERO_REDIRECT_URI)}` +
          `&scope=${encodeURIComponent(XERO_SCOPES)}&state=${encodeURIComponent(state)}`;

        // Store state for verification
        await pools.rdycore.query(
          `UPDATE workspaces SET config = jsonb_set(COALESCE(config, '{}'), '{xero}', $2)
           WHERE id = $1`,
          [wsId, JSON.stringify({ oauth_state: state, status: "pending" })],
        );

        return text({
          message: "Open this URL to connect your Xero account:",
          auth_url: authUrl,
          instructions:
            "After authorizing, Xero will redirect with a code. Use action=callback with that code.",
        });
      }

      if (p.action === "callback") {
        if (!p.code) return text({ error: "Authorization code required" });
        if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET) {
          return text({ error: "Xero credentials not configured" });
        }

        try {
          // Exchange code for tokens
          const tokenRes = await fetch("https://identity.xero.com/connect/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization:
                "Basic " +
                Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString("base64"),
            },
            body: `grant_type=authorization_code&code=${p.code}&redirect_uri=${encodeURIComponent(XERO_REDIRECT_URI)}`,
          });

          if (!tokenRes.ok) {
            return text({
              error: `Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`,
            });
          }

          const tokens: any = await tokenRes.json();

          // Get Xero tenant (organisation)
          const connectionsRes = await fetch("https://api.xero.com/connections", {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          });
          const connections: any = await connectionsRes.json();
          const tenant = connections[0]; // First connected org

          // Store tokens in workspace config
          const xeroConfig = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
            tenant_id: tenant?.tenantId,
            tenant_name: tenant?.tenantName,
            status: "connected",
            last_sync: null,
          };

          await pools.rdycore.query(
            `UPDATE workspaces SET config = jsonb_set(COALESCE(config, '{}'), '{xero}', $2)
             WHERE id = $1`,
            [wsId, JSON.stringify(xeroConfig)],
          );

          return text({
            message: `Connected to Xero: ${tenant?.tenantName}. Use action=sync to pull expenses.`,
          });
        } catch (err: any) {
          return text({ error: `OAuth callback failed: ${err.message}` });
        }
      }

      if (p.action === "sync") {
        // Get stored tokens
        const { rows } = await pools.rdycore.query(
          `SELECT config->'xero' AS xero FROM workspaces WHERE id = $1`,
          [wsId],
        );
        const xero = rows[0]?.xero;
        if (!xero?.access_token) {
          return text({ error: "Xero not connected. Use action=connect first." });
        }

        // Refresh token if expired
        let accessToken = xero.access_token;
        if (new Date(xero.expires_at) < new Date()) {
          if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET) {
            return text({ error: "Cannot refresh token — Xero credentials not configured" });
          }
          const refreshRes = await fetch("https://identity.xero.com/connect/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization:
                "Basic " +
                Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString("base64"),
            },
            body: `grant_type=refresh_token&refresh_token=${xero.refresh_token}`,
          });

          if (!refreshRes.ok) {
            return text({ error: "Token refresh failed. Reconnect with action=connect." });
          }

          const newTokens: any = await refreshRes.json();
          accessToken = newTokens.access_token;

          await pools.rdycore.query(
            `UPDATE workspaces SET config = jsonb_set(config, '{xero}',
               config->'xero' || $2::jsonb)
             WHERE id = $1`,
            [
              wsId,
              JSON.stringify({
                access_token: newTokens.access_token,
                refresh_token: newTokens.refresh_token,
                expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
              }),
            ],
          );
        }

        // Pull invoices/bills (expenses) from Xero
        const months = p.months ?? 3;
        const sinceDate = new Date();
        sinceDate.setMonth(sinceDate.getMonth() - months);
        const sinceDateStr = sinceDate.toISOString().split("T")[0];

        const invoicesRes = await fetch(
          `https://api.xero.com/api.xro/2.0/Invoices?where=Type%3D%22ACCPAY%22%20AND%20Date%3E%3DDateTime(${sinceDate.getFullYear()},${sinceDate.getMonth() + 1},${sinceDate.getDate()})&order=Date%20DESC`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Xero-Tenant-Id": xero.tenant_id,
              Accept: "application/json",
            },
          },
        );

        if (!invoicesRes.ok) {
          return text({ error: `Xero API error: ${invoicesRes.status}` });
        }

        const invoicesData: any = await invoicesRes.json();
        const invoices = invoicesData.Invoices ?? [];

        // Map Xero line items to business_costs
        let synced = 0;
        const categoryMap: Record<string, string> = {
          rent: "rent",
          lease: "rent",
          office: "rent",
          salary: "staff",
          wage: "staff",
          payroll: "staff",
          electric: "utilities",
          water: "utilities",
          internet: "utilities",
          phone: "utilities",
          repair: "equipment",
          maintenance: "equipment",
          hardware: "equipment",
          advertising: "marketing",
          "google ads": "marketing",
          facebook: "marketing",
          promotion: "marketing",
        };

        for (const inv of invoices) {
          for (const line of inv.LineItems ?? []) {
            const desc = (line.Description ?? "").toLowerCase();
            let category = "other";
            for (const [keyword, cat] of Object.entries(categoryMap)) {
              if (desc.includes(keyword)) {
                category = cat;
                break;
              }
            }

            const amountCents = Math.round((line.LineAmount ?? 0) * 100);
            if (amountCents <= 0) continue;

            // Upsert by matching name + effective_from
            const effectiveDate = inv.Date ? inv.Date.split("T")[0] : todayHK();
            const { rowCount } = await pools.rdycore.query(
              `INSERT INTO business_costs (workspace_id, category, name, amount_cents, currency, frequency, effective_from, created_by, notes)
               SELECT $1, $2, $3, $4, 'HKD', 'one_time', $5::date, 'xero_sync', $6
               WHERE NOT EXISTS (
                 SELECT 1 FROM business_costs
                 WHERE workspace_id = $1 AND name = $3 AND effective_from = $5::date AND created_by = 'xero_sync'
               )`,
              [
                wsId,
                category,
                line.Description ?? `Xero: ${inv.InvoiceNumber}`,
                amountCents,
                effectiveDate,
                `Xero Invoice: ${inv.InvoiceNumber}`,
              ],
            );
            if (rowCount && rowCount > 0) synced++;
          }
        }

        // Update last sync timestamp
        await pools.rdycore.query(
          `UPDATE workspaces SET config = jsonb_set(config, '{xero,last_sync}', $2::jsonb)
           WHERE id = $1`,
          [wsId, JSON.stringify(new Date().toISOString())],
        );

        return text({
          message: `Synced ${synced} new expenses from Xero (${invoices.length} invoices processed)`,
          period: `Last ${months} months since ${sinceDateStr}`,
          invoices_processed: invoices.length,
          new_costs_added: synced,
        });
      }

      if (p.action === "disconnect") {
        await pools.rdycore.query(`UPDATE workspaces SET config = config - 'xero' WHERE id = $1`, [
          wsId,
        ]);
        return text({ message: "Xero disconnected. Synced costs remain in business_costs." });
      }

      return text({ error: `Unknown action: ${p.action}` });
    },
  });

  // ============================================================
  //  TOOL: bank_balance — cash position tracking
  // ============================================================

  api.registerTool({
    name: "bank_balance",
    description:
      "Track bank balances and cash position. " +
      "Actions: record (add a balance snapshot), history (view balance history), " +
      "import_csv (import bank statement CSV), current (latest balance).",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        action: { type: "string", description: "record, history, import_csv, current" },
        account_name: {
          type: "string",
          description: "Bank account name (e.g. 'HSBC Operating', 'Hang Seng Savings')",
        },
        balance: { type: "number", description: "Current balance in HKD (for record action)" },
        csv_data: {
          type: "string",
          description: "CSV content: date,description,amount,balance per line (for import_csv)",
        },
        months: { type: "number", description: "History months (default: 3)" },
      },
      required: ["action"],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;

      // We store bank balances in profitability_snapshots with a special period_type
      // Alternatively, use the workspace config to track balances

      if (p.action === "record") {
        if (!p.account_name || p.balance === undefined) {
          return text({ error: "account_name and balance required" });
        }
        const balanceCents = Math.round(p.balance * 100);
        const today = todayHK();

        await pools.rdycore.query(
          `INSERT INTO profitability_snapshots (workspace_id, period_type, period_key, metrics)
           VALUES ($1, 'bank_balance', $2, $3)
           ON CONFLICT (workspace_id, period_type, period_key)
           DO UPDATE SET metrics = profitability_snapshots.metrics || $3::jsonb`,
          [
            wsId,
            today,
            JSON.stringify({
              [p.account_name]: balanceCents,
              recorded_at: new Date().toISOString(),
            }),
          ],
        );

        return text({
          message: `Balance recorded: ${p.account_name} = HK$${p.balance.toLocaleString()}`,
          date: today,
        });
      }

      if (p.action === "current") {
        const { rows } = await pools.rdycore.query(
          `SELECT period_key, metrics FROM profitability_snapshots
           WHERE workspace_id = $1 AND period_type = 'bank_balance'
           ORDER BY period_key DESC LIMIT 1`,
          [wsId],
        );

        if (rows.length === 0) {
          return text({ error: "No bank balances recorded. Use action=record to add one." });
        }

        const m =
          typeof rows[0].metrics === "string" ? JSON.parse(rows[0].metrics) : rows[0].metrics;
        const accounts: { name: string; balance_hkd: number }[] = [];
        let totalCents = 0;

        for (const [key, val] of Object.entries(m)) {
          if (key === "recorded_at") continue;
          const cents = Number(val);
          accounts.push({ name: key, balance_hkd: cents / 100 });
          totalCents += cents;
        }

        return text({
          as_of: rows[0].period_key,
          accounts,
          total_balance_hkd: totalCents / 100,
        });
      }

      if (p.action === "history") {
        const months = p.months ?? 3;
        const { rows } = await pools.rdycore.query(
          `SELECT period_key, metrics FROM profitability_snapshots
           WHERE workspace_id = $1 AND period_type = 'bank_balance'
             AND period_key >= (CURRENT_DATE - ($2 || ' months')::interval)::date::text
           ORDER BY period_key`,
          [wsId, months],
        );

        const history = rows.map((r: any) => {
          const m = typeof r.metrics === "string" ? JSON.parse(r.metrics) : r.metrics;
          let total = 0;
          const accounts: Record<string, number> = {};
          for (const [key, val] of Object.entries(m)) {
            if (key === "recorded_at") continue;
            const cents = Number(val);
            accounts[key] = cents / 100;
            total += cents;
          }
          return { date: r.period_key, accounts, total_hkd: total / 100 };
        });

        return text({ months, history });
      }

      if (p.action === "import_csv") {
        if (!p.csv_data)
          return text({ error: "csv_data required (date,description,amount,balance per line)" });
        if (!p.account_name) return text({ error: "account_name required for CSV import" });

        const lines = p.csv_data.trim().split("\n");
        let imported = 0;
        let lastBalance = 0;
        let lastDate = "";

        for (const line of lines) {
          const parts = line.split(",").map((s: string) => s.trim());
          if (parts.length < 3) continue;

          // Try to parse: date, description, amount, [balance]
          const date = parts[0];
          const description = parts[1];
          const amount = parseFloat(parts[2]);
          const balance = parts[3] ? parseFloat(parts[3]) : null;

          if (!date || isNaN(amount)) continue;

          // Record as a one-time cost or revenue
          if (amount < 0) {
            // Expense
            const amountCents = Math.round(Math.abs(amount) * 100);
            await pools.rdycore.query(
              `INSERT INTO business_costs (workspace_id, category, name, amount_cents, currency, frequency, effective_from, created_by, notes)
               SELECT $1, 'other', $2, $3, 'HKD', 'one_time', $4::date, 'bank_csv', $5
               WHERE NOT EXISTS (
                 SELECT 1 FROM business_costs
                 WHERE workspace_id = $1 AND name = $2 AND effective_from = $4::date AND created_by = 'bank_csv'
               )`,
              [wsId, description, amountCents, date, `Bank CSV: ${p.account_name}`],
            );
            imported++;
          }

          if (balance !== null) {
            lastBalance = balance;
            lastDate = date;
          }
        }

        // Record latest balance if available
        if (lastDate && lastBalance) {
          const balanceCents = Math.round(lastBalance * 100);
          await pools.rdycore.query(
            `INSERT INTO profitability_snapshots (workspace_id, period_type, period_key, metrics)
             VALUES ($1, 'bank_balance', $2, $3)
             ON CONFLICT (workspace_id, period_type, period_key)
             DO UPDATE SET metrics = profitability_snapshots.metrics || $3::jsonb`,
            [wsId, lastDate, JSON.stringify({ [p.account_name]: balanceCents })],
          );
        }

        return text({
          message: `Imported ${imported} transactions from CSV`,
          account: p.account_name,
          lines_processed: lines.length,
          expenses_added: imported,
          latest_balance: lastBalance ? { date: lastDate, balance_hkd: lastBalance } : null,
        });
      }

      return text({ error: `Unknown action: ${p.action}` });
    },
  });

  // ============================================================
  //  TOOL: competitor_import — bulk competitor data import
  // ============================================================

  api.registerTool({
    name: "competitor_import",
    description:
      "Import competitor pricing and benchmark data in bulk. " +
      "Actions: import_csv (CSV with competitor_name,metric,value per line), " +
      "import_structured (add multiple benchmarks at once), scrape_hint (suggest what to look for).",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected" },
        action: { type: "string", description: "import_csv, import_structured, scrape_hint" },
        csv_data: {
          type: "string",
          description: "CSV: competitor_name,metric,value[,source] per line",
        },
        benchmarks: {
          type: "array",
          description: "Array of {competitor_name, metric, value, source} objects",
          items: {
            type: "object",
            properties: {
              competitor_name: { type: "string" },
              metric: { type: "string" },
              value: { type: "number" },
              source: { type: "string" },
            },
          },
        },
        vertical: { type: "string", description: "golf or racing (for scrape_hint)" },
      },
      required: ["action"],
    },
    async execute(_id: string, p: any) {
      const wsId = p.workspace_id;

      if (p.action === "import_csv") {
        if (!p.csv_data) return text({ error: "csv_data required" });

        const lines = p.csv_data.trim().split("\n");
        let imported = 0;

        for (const line of lines) {
          const parts = line.split(",").map((s: string) => s.trim());
          if (parts.length < 3) continue;

          const [competitorName, metric, valueStr, source] = parts;
          const value = parseFloat(valueStr);
          if (!competitorName || !metric || isNaN(value)) continue;

          await pools.rdycore.query(
            `INSERT INTO competitor_benchmarks (workspace_id, competitor_name, metric, value, source)
             VALUES ($1, $2, $3, $4, $5)`,
            [wsId, competitorName, metric, value, source ?? "manual"],
          );
          imported++;
        }

        return text({
          message: `Imported ${imported} benchmarks from CSV`,
          lines_processed: lines.length,
        });
      }

      if (p.action === "import_structured") {
        if (!p.benchmarks || !Array.isArray(p.benchmarks)) {
          return text({ error: "benchmarks array required" });
        }

        let imported = 0;
        for (const b of p.benchmarks) {
          if (!b.competitor_name || !b.metric || b.value === undefined) continue;
          await pools.rdycore.query(
            `INSERT INTO competitor_benchmarks (workspace_id, competitor_name, metric, value, source)
             VALUES ($1, $2, $3, $4, $5)`,
            [wsId, b.competitor_name, b.metric, b.value, b.source ?? "manual"],
          );
          imported++;
        }

        return text({ message: `Imported ${imported} benchmarks` });
      }

      if (p.action === "scrape_hint") {
        const vertical = p.vertical ?? "golf";

        const hints =
          vertical === "golf"
            ? {
                vertical: "sim_golf",
                suggested_competitors: [
                  "Golf Zone HK",
                  "X-Golf HK",
                  "Par-Tee Time",
                  "industry_average",
                ],
                metrics_to_track: [
                  { metric: "price_per_hour", description: "Hourly bay rental price in HKD" },
                  { metric: "membership_monthly", description: "Monthly membership fee in HKD" },
                  { metric: "coaching_rate", description: "Per-session coaching rate in HKD" },
                  {
                    metric: "utilization_rate",
                    description: "Estimated utilization % (from reviews/observations)",
                  },
                  { metric: "membership_count", description: "Estimated number of members" },
                  { metric: "rating", description: "Google/TripAdvisor rating (1-5)" },
                ],
                data_sources: [
                  "Google Maps reviews and pricing info",
                  "Competitor websites (pricing pages)",
                  "Social media follower counts as proxy for popularity",
                  "Industry reports from HKGA (Hong Kong Golf Association)",
                ],
              }
            : {
                vertical: "sim_racing",
                suggested_competitors: [
                  "Apex Racing HK",
                  "SimGrid HK",
                  "Race Room HK",
                  "industry_average",
                ],
                metrics_to_track: [
                  { metric: "price_per_hour", description: "Hourly rig rental price in HKD" },
                  { metric: "membership_monthly", description: "Monthly membership fee in HKD" },
                  { metric: "rig_count", description: "Number of sim rigs" },
                  { metric: "utilization_rate", description: "Estimated utilization %" },
                  {
                    metric: "group_discount_pct",
                    description: "Group booking discount percentage",
                  },
                  { metric: "rating", description: "Google rating (1-5)" },
                ],
                data_sources: [
                  "Google Maps reviews and pricing info",
                  "Competitor websites and booking pages",
                  "Facebook/Instagram engagement as popularity proxy",
                  "Industry events and sim racing community forums",
                ],
              };

        return text({
          message: "Here's what to look for when gathering competitor data:",
          ...hints,
          import_instruction:
            "Once you have data, use action=import_csv with format: competitor_name,metric,value,source per line. Or provide it conversationally and I'll use action=import_structured.",
        });
      }

      return text({ error: `Unknown action: ${p.action}` });
    },
  });

  log.info("[rdy-profitability] registered profitability optimizer extension");
}
