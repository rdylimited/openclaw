import pg from "pg";

// --- Database connection pools ---
// rdycore: tenants, workspaces, members, wallets, invoices
// Workspace-specific databases resolved dynamically

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

// --- Helpers ---

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function today() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Hong_Kong" });
}

// --- Extension entry point ---

export default function (api: any) {
  const log = api.logger ?? { info: console.log, warn: console.warn, error: console.error };

  // ============================================================
  //  QUERY BOOKINGS
  // ============================================================

  api.registerTool({
    name: "query_bookings",
    description: "Query bookings for the current workspace. Filter by date and status.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected, do not ask user" },
        date: { type: "string", description: "YYYY-MM-DD (defaults to today)" },
        status: { type: "string", description: "Filter: confirmed/pending/cancelled (optional)" },
      },
      required: [],
    },
    async execute(_id: string, p: { workspace_id: string; date?: string; status?: string }) {
      const dbName = await resolveDbName(p.workspace_id);
      if (!dbName) return text({ error: "Workspace not found or no database configured" });

      const pool = getPool(dbName);
      const date = p.date ?? today();

      const conditions = ["b.workspace_id = $1", "b.booking_date = $2"];
      const params: any[] = [p.workspace_id, date];
      let idx = 3;

      if (p.status) {
        conditions.push(`b.status = $${idx}`);
        params.push(p.status);
        idx++;
      }

      // Different JOIN depending on vertical
      const joinClause =
        dbName === "golf"
          ? "LEFT JOIN coaches c ON b.coach_id = c.id"
          : "LEFT JOIN rigs r ON b.rig_id = r.id";

      const selectExtra =
        dbName === "golf"
          ? "c.name as coach_name, b.service_type, b.final_price"
          : "r.name as rig_name, r.slug as rig_slug, b.activity_type, b.final_price_cents";

      const { rows } = await pool.query(
        `SELECT b.id, b.booking_date, b.start_time,
                b.duration_minutes, b.customer_name, b.customer_email,
                b.status, b.payment_status, b.notes, ${selectExtra}
         FROM bookings b
         ${joinClause}
         WHERE ${conditions.join(" AND ")}
         ORDER BY b.start_time`,
        params,
      );

      return text({ database: dbName, date, bookings: rows, total: rows.length });
    },
  });

  // ============================================================
  //  CHECK AVAILABILITY
  // ============================================================

  api.registerTool({
    name: "check_availability",
    description: "Check available time slots for a date in the current workspace.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected, do not ask user" },
        date: { type: "string", description: "YYYY-MM-DD" },
        resource_slug: {
          type: "string",
          description: "Resource slug (e.g., rig-1, rig-2) — optional",
        },
      },
      required: ["date"],
    },
    async execute(_id: string, p: { workspace_id: string; date: string; resource_slug?: string }) {
      const dbName = await resolveDbName(p.workspace_id);
      if (!dbName) return text({ error: "Workspace not found" });

      const pool = getPool(dbName);

      if (dbName === "racing") {
        // Racing: show per-rig bookings
        const rigFilter = p.resource_slug ? "AND r.slug = $3" : "";
        const params: any[] = [p.workspace_id, p.date];
        if (p.resource_slug) params.push(p.resource_slug);

        const { rows } = await pool.query(
          `SELECT r.slug, r.name, r.capabilities,
                  COALESCE(json_agg(
                    json_build_object('start', b.start_time, 'end', b.end_time, 'activity', b.activity_type, 'status', b.status, 'customer', b.customer_name)
                    ORDER BY b.start_time
                  ) FILTER (WHERE b.id IS NOT NULL), '[]') as bookings
           FROM rigs r
           LEFT JOIN bookings b ON b.rig_id = r.id
             AND b.booking_date = $2 AND b.status NOT IN ('cancelled')
           WHERE r.workspace_id = $1 AND r.active = true ${rigFilter}
           GROUP BY r.id, r.slug, r.name, r.capabilities
           ORDER BY r.slug`,
          params,
        );

        return text({ database: dbName, date: p.date, rigs: rows });
      } else {
        // Golf: show all bookings for the date (single bay)
        const { rows } = await pool.query(
          `SELECT b.start_time, b.booking_time, b.duration_minutes,
                  b.status, b.customer_name, c.name as coach_name
           FROM bookings b
           LEFT JOIN coaches c ON b.coach_id = c.id
           WHERE b.workspace_id = $1 AND b.booking_date = $2
             AND b.status NOT IN ('cancelled')
           ORDER BY b.booking_time`,
          [p.workspace_id, p.date],
        );

        return text({
          database: dbName,
          date: p.date,
          note: "SimGolf has 1 bay. Any time not listed is available.",
          booked_slots: rows,
        });
      }
    },
  });

  // ============================================================
  //  LIST RESOURCES (rigs for racing, coaches for golf)
  // ============================================================

  api.registerTool({
    name: "list_resources",
    description: "List bookable resources for the current workspace (rigs, coaches, etc).",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected, do not ask user" },
      },
      required: [],
    },
    async execute(_id: string, p: { workspace_id: string }) {
      const dbName = await resolveDbName(p.workspace_id);
      if (!dbName) return text({ error: "Workspace not found" });

      const pool = getPool(dbName);

      if (dbName === "racing") {
        const { rows: rigs } = await pool.query(
          `SELECT id, slug, name, drive_side, capabilities, sim_titles, config
           FROM rigs WHERE workspace_id = $1 AND active = true ORDER BY slug`,
          [p.workspace_id],
        );
        const { rows: coaches } = await pool.query(
          `SELECT id, name, specializations, rating, hourly_rate_cents, is_active
           FROM coaches WHERE workspace_id = $1 AND is_active = true ORDER BY name`,
          [p.workspace_id],
        );
        return text({ database: dbName, rigs, coaches });
      } else {
        const { rows } = await pool.query(
          `SELECT id, name, email, specialization, rating, is_active
           FROM coaches WHERE workspace_id = $1 AND is_active = true ORDER BY name`,
          [p.workspace_id],
        );
        return text({ database: dbName, coaches: rows });
      }
    },
  });

  // ============================================================
  //  CREATE BOOKING
  // ============================================================

  api.registerTool({
    name: "create_booking",
    description:
      "Create a new booking in the current workspace. Requires date, time, duration, and customer details.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM (24h)" },
        duration_minutes: { type: "number" },
        customer_name: { type: "string" },
        customer_email: { type: "string" },
        customer_phone: { type: "string" },
        // Shared
        coach_id: { type: "string", description: "Coach UUID (optional)" },
        // Racing-specific
        rig_slug: { type: "string", description: "Rig slug e.g. rig-1 (if applicable)" },
        activity_type: {
          type: "string",
          description: "Activity type e.g. racing, flight, f1, drifting, rally (if applicable)",
        },
        sim_title: { type: "string", description: "Sim title (optional)" },
        membership_tier: {
          type: "string",
          description: "member, vip, etc. NULL = walk-in pricing",
        },
        group_size: {
          type: "number",
          description: "Number of rigs to book (default 1). For group sessions.",
        },
        group_discount_pct: {
          type: "number",
          description: "Group discount percentage (e.g. 10 for 10% off)",
        },
        // Shared
        payment_method: { type: "string", description: "credits, 2c2p, cash, or free" },
        notes: { type: "string" },
      },
      required: ["date", "time", "duration_minutes", "customer_name"],
    },
    async execute(_id: string, p: any) {
      const dbName = await resolveDbName(p.workspace_id);
      if (!dbName) return text({ error: "Workspace not found" });

      const pool = getPool(dbName);

      // Calculate end time
      const [hh, mm] = p.time.split(":").map(Number);
      const endMinutes = hh * 60 + mm + p.duration_minutes;
      const endTime = `${String(Math.floor(endMinutes / 60) % 24).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;

      if (dbName === "racing") {
        if (!p.rig_slug) return text({ error: "rig_slug is required for racing bookings" });
        if (!p.activity_type)
          return text({ error: "activity_type is required for racing bookings" });

        // Resolve rig — check status
        const { rows: rigs } = await pool.query(
          "SELECT id, name, status FROM rigs WHERE workspace_id = $1 AND slug = $2 AND active = true",
          [p.workspace_id, p.rig_slug],
        );
        if (rigs.length === 0) return text({ error: `Rig "${p.rig_slug}" not found` });
        if (rigs[0].status !== "available")
          return text({ error: `Rig "${p.rig_slug}" is currently ${rigs[0].status}` });

        // Check downtime windows
        const bookingStart = `${p.date}T${p.time}:00`;
        const bookingEnd = `${p.date}T${endTime}:00`;
        const { rows: downtimes } = await pool.query(
          `SELECT id, reason FROM rig_downtime
           WHERE rig_id = $1 AND start_at <= $2::timestamptz AND (end_at IS NULL OR end_at >= $3::timestamptz)`,
          [rigs[0].id, bookingEnd, bookingStart],
        );
        if (downtimes.length > 0)
          return text({ error: `Rig is down for maintenance: ${downtimes[0].reason}` });

        // Check booking conflicts
        const { rows: conflicts } = await pool.query(
          `SELECT id FROM bookings
           WHERE rig_id = $1 AND booking_date = $2 AND status NOT IN ('cancelled')
             AND start_time < $3::time AND end_time > $4::time`,
          [rigs[0].id, p.date, endTime, p.time],
        );
        if (conflicts.length > 0)
          return text({ error: "Time slot conflicts with existing booking" });

        // Resolve price from pricing_rules table (highest priority match wins)
        const { rows: pricingRules } = await pool.query(
          `SELECT price_per_hour_cents, name FROM pricing_rules
           WHERE workspace_id = $1 AND is_active = true
             AND (activity_types = '{}' OR $2 = ANY(activity_types))
             AND (membership_tier IS NULL OR membership_tier = $3)
             AND (time_start IS NULL OR $4::time >= time_start)
             AND (time_end IS NULL OR $4::time < time_end)
           ORDER BY priority DESC LIMIT 1`,
          [p.workspace_id, p.activity_type, p.membership_tier ?? null, p.time],
        );
        const ratePerHourCents = pricingRules[0]?.price_per_hour_cents ?? 35000;
        const pricingRuleName = pricingRules[0]?.name ?? "Default";
        const priceCents = Math.round((ratePerHourCents * p.duration_minutes) / 60);

        // Coach fee (if applicable)
        let coachFeeCents = 0;
        let coachName: string | null = null;
        if (p.coach_id) {
          const { rows: coaches } = await pool.query(
            "SELECT name, hourly_rate_cents FROM coaches WHERE id = $1 AND is_active = true",
            [p.coach_id],
          );
          if (coaches.length > 0) {
            coachFeeCents = Math.round(coaches[0].hourly_rate_cents * (p.duration_minutes / 60));
            coachName = coaches[0].name;
          }
        }

        // Group booking support
        const groupSize = p.group_size ?? 1;
        const groupDiscountPct = p.group_discount_pct ?? 0;
        const rigSubtotal = priceCents * groupSize;
        const groupDiscount =
          groupDiscountPct > 0 ? Math.round((rigSubtotal * groupDiscountPct) / 100) : 0;
        const totalCents = rigSubtotal - groupDiscount + coachFeeCents;
        const groupBookingId =
          groupSize > 1 ? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : null;

        const { rows: inserted } = await pool.query(
          `INSERT INTO bookings (workspace_id, rig_id, coach_id, activity_type, sim_title, booking_date, start_time, end_time,
             duration_minutes, customer_name, customer_email, customer_phone,
             price_cents, final_price_cents, currency, payment_method, status, notes,
             group_size, group_booking_id, group_discount_pct, membership_tier)
           VALUES ($1, $2, $3, $4, $5, $6, $7::time, $8::time, $9, $10, $11, $12, $13, $14, 'HKD', $15, 'confirmed', $16,
                   $17, $18, $19, $20)
           RETURNING id, booking_date, start_time, end_time, final_price_cents, status`,
          [
            p.workspace_id,
            rigs[0].id,
            p.coach_id ?? null,
            p.activity_type,
            p.sim_title ?? null,
            p.date,
            p.time,
            endTime,
            p.duration_minutes,
            p.customer_name,
            p.customer_email ?? null,
            p.customer_phone ?? null,
            priceCents,
            totalCents,
            p.payment_method ?? "cash",
            p.notes ?? null,
            groupSize,
            groupBookingId,
            groupDiscountPct,
            p.membership_tier ?? null,
          ],
        );

        return text({
          message: "Booking created",
          booking: {
            ...inserted[0],
            rig: rigs[0].name,
            pricing_rule: pricingRuleName,
            rate_per_hour_hkd: ratePerHourCents / 100,
            rig_rental_hkd: priceCents / 100,
            coach_fee_hkd: coachFeeCents / 100,
            coach_name: coachName,
            group_size: groupSize,
            group_discount_pct: groupDiscountPct,
            group_discount_hkd: groupDiscount / 100,
            total_hkd: totalCents / 100,
          },
        });
      } else {
        // Golf booking
        // Check conflicts (single bay — just check date+time overlap)
        const { rows: conflicts } = await pool.query(
          `SELECT id FROM bookings
           WHERE workspace_id = $1 AND booking_date = $2 AND status NOT IN ('cancelled')
             AND booking_time < $3::time AND (booking_time + (duration_minutes || ' minutes')::interval) > $4::time`,
          [p.workspace_id, p.date, endTime, p.time],
        );
        if (conflicts.length > 0)
          return text({ error: "Time slot conflicts with existing booking" });

        // Get pricing from admin_settings
        const { rows: settings } = await pool.query(
          "SELECT setting_value FROM admin_settings WHERE workspace_id = $1 AND setting_key = 'pricing'",
          [p.workspace_id],
        );
        const pricing = settings[0]?.setting_value ?? {};
        const baseRate = pricing.base_per_hour ?? 250;
        const price = baseRate * (p.duration_minutes / 60);
        const coachFee = p.coach_id
          ? (pricing.coach_per_30min ?? 300) * (p.duration_minutes / 30)
          : 0;
        const finalPrice = price + coachFee;

        const { rows: inserted } = await pool.query(
          `INSERT INTO bookings (workspace_id, coach_id, booking_date, booking_time, duration_minutes,
             customer_name, customer_email, customer_phone,
             price, final_price, payment_method, status, notes)
           VALUES ($1, $2, $3, $4::time, $5, $6, $7, $8, $9, $9, $10, 'confirmed', $11)
           RETURNING id, booking_date, booking_time, duration_minutes, final_price, status`,
          [
            p.workspace_id,
            p.coach_id ?? null,
            p.date,
            p.time,
            p.duration_minutes,
            p.customer_name,
            p.customer_email ?? null,
            p.customer_phone ?? null,
            finalPrice,
            p.payment_method ?? "cash",
            p.notes ?? null,
          ],
        );

        return text({
          message: "Booking created",
          booking: { ...inserted[0], amount_hkd: finalPrice },
        });
      }
    },
  });

  // ============================================================
  //  CANCEL BOOKING
  // ============================================================

  api.registerTool({
    name: "cancel_booking",
    description: "Cancel a booking and optionally refund credits.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected, do not ask user" },
        booking_id: { type: "string" },
        refund_credits: {
          type: "boolean",
          description: "Whether to refund credits to the member's wallet",
        },
      },
      required: ["booking_id"],
    },
    async execute(
      _id: string,
      p: { workspace_id: string; booking_id: string; refund_credits?: boolean },
    ) {
      const dbName = await resolveDbName(p.workspace_id);
      if (!dbName) return text({ error: "Workspace not found" });

      const pool = getPool(dbName);

      const { rows } = await pool.query(
        "UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status != 'cancelled' RETURNING id, customer_name, customer_email, payment_method, final_price, final_price_cents",
        [p.booking_id],
      );
      if (rows.length === 0) return text({ error: "Booking not found or already cancelled" });

      const booking = rows[0];
      let refunded = false;

      // Refund credits via rdycore wallet if requested
      if (p.refund_credits && booking.payment_method === "credits" && booking.customer_email) {
        const amountHkd =
          booking.final_price ?? (booking.final_price_cents ? booking.final_price_cents / 100 : 0);
        if (amountHkd > 0) {
          const { rows: wallets } = await pools.rdycore.query(
            "SELECT id, balance FROM member_wallets WHERE email = $1",
            [booking.customer_email],
          );
          if (wallets.length > 0) {
            const newBalance = Number(wallets[0].balance) + amountHkd;
            await pools.rdycore.query("UPDATE member_wallets SET balance = $1 WHERE id = $2", [
              newBalance,
              wallets[0].id,
            ]);
            await pools.rdycore.query(
              `INSERT INTO wallet_transactions (wallet_id, workspace_id, type, amount, balance_after, description, reference_id)
               VALUES ($1, $2, 'refund', $3, $4, 'Booking cancellation refund', $5)`,
              [wallets[0].id, p.workspace_id, amountHkd, newBalance, p.booking_id],
            );
            refunded = true;
          }
        }
      }

      // Record in vertical booking history
      await pool.query(
        `INSERT INTO booking_history (booking_id, event_type, event_data, changed_by)
         VALUES ($1, 'cancelled', '{"status":"cancelled"}', 'ai_assistant')`,
        [p.booking_id],
      );

      return text({ message: `Booking for ${booking.customer_name} cancelled`, refunded });
    },
  });

  // ============================================================
  //  GET CREDIT BALANCE (always from rdycore)
  // ============================================================

  api.registerTool({
    name: "get_credit_balance",
    description: "Get a client's credit balance. Look up by email or phone number.",
    parameters: {
      type: "object",
      properties: {
        email: { type: "string", description: "Client email address" },
        phone: { type: "string", description: "Client phone number (E.164 format)" },
      },
    },
    async execute(_id: string, p: { email?: string; phone?: string }) {
      if (!p.email && !p.phone) return text({ error: "Provide email or phone" });

      // Look up member by email or phone
      const whereClause = p.email ? "m.email = $1" : "m.phone = $1";
      const lookup = p.email ?? p.phone;

      const { rows } = await pools.rdycore.query(
        `SELECT mw.balance, mw.currency, m.name, m.email, m.phone, m.membership_tier
         FROM member_wallets mw
         JOIN members m ON mw.member_id = m.id
         WHERE ${whereClause}`,
        [lookup],
      );
      if (rows.length === 0) return text({ error: `No wallet found for ${lookup}` });

      const { rows: txns } = await pools.rdycore.query(
        `SELECT wt.type, wt.amount, wt.balance_after, wt.description, wt.created_at
         FROM wallet_transactions wt
         JOIN member_wallets mw ON wt.wallet_id = mw.id
         JOIN members m ON mw.member_id = m.id
         WHERE ${whereClause}
         ORDER BY wt.created_at DESC LIMIT 5`,
        [lookup],
      );

      return text({
        client: rows[0].name,
        phone: rows[0].phone,
        email: rows[0].email,
        tier: rows[0].membership_tier,
        balance: `${rows[0].balance} ${rows[0].currency}`,
        recent_transactions: txns,
      });
    },
  });

  // ============================================================
  //  DAILY SUMMARY
  // ============================================================

  api.registerTool({
    name: "get_daily_summary",
    description:
      "Get a summary of today's bookings, revenue, and activity for the current workspace.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected, do not ask user" },
        date: { type: "string", description: "YYYY-MM-DD (defaults to today)" },
      },
      required: [],
    },
    async execute(_id: string, p: { workspace_id: string; date?: string }) {
      const dbName = await resolveDbName(p.workspace_id);
      if (!dbName) return text({ error: "Workspace not found" });

      const pool = getPool(dbName);
      const date = p.date ?? today();

      // Booking counts by status
      const revenueCol = dbName === "racing" ? "final_price_cents" : "(final_price * 100)::int";
      const { rows: statusCounts } = await pool.query(
        `SELECT status, COUNT(*)::int as count, COALESCE(SUM(${revenueCol}), 0)::int as revenue_cents
         FROM bookings WHERE workspace_id = $1 AND booking_date = $2
         GROUP BY status`,
        [p.workspace_id, date],
      );

      // Wallet activity from rdycore
      const { rows: walletActivity } = await pools.rdycore.query(
        `SELECT type, COUNT(*)::int as count, SUM(amount)::numeric as total
         FROM wallet_transactions
         WHERE workspace_id = $1 AND created_at::date = $2
         GROUP BY type`,
        [p.workspace_id, date],
      );

      const totalRevenueCents = statusCounts.reduce(
        (sum: number, r: any) => (r.status !== "cancelled" ? sum + (r.revenue_cents ?? 0) : sum),
        0,
      );

      const result: any = {
        database: dbName,
        date,
        bookings_by_status: statusCounts,
        total_revenue_hkd: totalRevenueCents / 100,
        wallet_activity: walletActivity,
      };

      // Add vertical-specific breakdown
      if (dbName === "racing") {
        const { rows: rigBreakdown } = await pool.query(
          `SELECT r.slug, r.name, COUNT(b.id)::int as booking_count,
                  COALESCE(SUM(b.duration_minutes), 0)::int as total_minutes
           FROM rigs r
           LEFT JOIN bookings b ON b.rig_id = r.id
             AND b.booking_date = $2 AND b.status NOT IN ('cancelled')
           WHERE r.workspace_id = $1
           GROUP BY r.id, r.slug, r.name ORDER BY r.slug`,
          [p.workspace_id, date],
        );
        result.bookings_by_rig = rigBreakdown;
      }

      return text(result);
    },
  });

  // ============================================================
  //  SET RIG STATUS (maintenance / offline / available)
  // ============================================================

  api.registerTool({
    name: "set_rig_status",
    description:
      "Set a rig's status to available, maintenance, or offline. Use when a rig needs to go down for maintenance or come back online.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected, do not ask user" },
        rig_slug: { type: "string", description: "Rig slug e.g. rig-1" },
        status: { type: "string", description: "available, maintenance, or offline" },
        reason: {
          type: "string",
          description: "Reason for status change (required for maintenance/offline)",
        },
        end_at: {
          type: "string",
          description: "ISO datetime when rig should come back online (optional)",
        },
      },
      required: ["rig_slug", "status"],
    },
    async execute(
      _id: string,
      p: {
        workspace_id: string;
        rig_slug: string;
        status: string;
        reason?: string;
        end_at?: string;
      },
    ) {
      const dbName = await resolveDbName(p.workspace_id);
      if (!dbName || dbName !== "racing")
        return text({ error: "This tool only works for racing workspaces" });

      const pool = getPool(dbName);

      if (!["available", "maintenance", "offline"].includes(p.status)) {
        return text({ error: "Status must be: available, maintenance, or offline" });
      }

      const { rows: rigs } = await pool.query(
        "UPDATE rigs SET status = $1 WHERE workspace_id = $2 AND slug = $3 RETURNING id, name, status",
        [p.status, p.workspace_id, p.rig_slug],
      );
      if (rigs.length === 0) return text({ error: `Rig "${p.rig_slug}" not found` });

      // Record downtime window if not available
      if (p.status !== "available" && p.reason) {
        await pool.query(
          `INSERT INTO rig_downtime (rig_id, reason, start_at, end_at, created_by)
           VALUES ($1, $2, now(), $3, 'ai_assistant')`,
          [rigs[0].id, p.reason, p.end_at ?? null],
        );
      }

      return text({
        message: `${rigs[0].name} is now ${p.status}`,
        rig: rigs[0],
        reason: p.reason ?? null,
      });
    },
  });

  // ============================================================
  //  MANAGE PRICING RULES
  // ============================================================

  api.registerTool({
    name: "manage_pricing",
    description: "List, create, or update pricing rules for the current workspace.",
    parameters: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Auto-injected, do not ask user" },
        action: { type: "string", description: "list, create, update, or deactivate" },
        rule_id: { type: "string", description: "Rule UUID (for update/deactivate)" },
        name: { type: "string", description: "Rule name e.g. 'Standard', 'Twilight'" },
        membership_tier: { type: "string", description: "NULL for walk-in, 'member', 'vip'" },
        activity_types: {
          type: "string",
          description: "Comma-separated: racing,flight (empty = all)",
        },
        time_start: { type: "string", description: "HH:MM start of time window" },
        time_end: { type: "string", description: "HH:MM end of time window" },
        price_per_hour_cents: {
          type: "number",
          description: "Price in cents per hour (or first hour)",
        },
        price_subsequent_cents: {
          type: "number",
          description: "Price per subsequent increment (e.g. per 30min)",
        },
        subsequent_increment_min: {
          type: "number",
          description: "Increment size in minutes (default 30)",
        },
        priority: { type: "number", description: "Higher = checked first" },
      },
      required: ["action"],
    },
    async execute(_id: string, p: any) {
      const dbName = await resolveDbName(p.workspace_id);
      if (!dbName) return text({ error: "Workspace not found" });

      const pool = getPool(dbName);
      const isGolf = dbName === "golf";

      if (p.action === "list") {
        const extraCols = isGolf
          ? ", price_first_hour_cents, price_subsequent_cents, subsequent_increment_min"
          : "";
        const { rows } = await pool.query(
          `SELECT id, name, membership_tier, activity_types, time_start, time_end, day_of_week,
                  price_per_hour_cents, priority, is_active${extraCols}
           FROM pricing_rules WHERE workspace_id = $1 ORDER BY priority DESC`,
          [p.workspace_id],
        );
        return text({
          business: isGolf ? "golf" : "racing",
          rules: rows.map((r: any) => {
            const rule: any = { ...r, price_per_hour_hkd: r.price_per_hour_cents / 100 };
            if (isGolf) {
              rule.first_hour_hkd = r.price_first_hour_cents / 100;
              rule.subsequent_hkd =
                r.price_subsequent_cents != null ? r.price_subsequent_cents / 100 : null;
              rule.subsequent_per = r.subsequent_increment_min
                ? `${r.subsequent_increment_min}min`
                : null;
            }
            return rule;
          }),
        });
      }

      if (p.action === "create") {
        if (!p.name || !p.price_per_hour_cents)
          return text({ error: "name and price_per_hour_cents required" });
        const activityTypes = p.activity_types ? `{${p.activity_types}}` : "{}";

        if (isGolf) {
          const { rows } = await pool.query(
            `INSERT INTO pricing_rules (workspace_id, name, membership_tier, activity_types, time_start, time_end,
               price_first_hour_cents, price_subsequent_cents, subsequent_increment_min, price_per_hour_cents, priority)
             VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9, $7, $10)
             RETURNING id, name, price_first_hour_cents, price_subsequent_cents, subsequent_increment_min, priority`,
            [
              p.workspace_id,
              p.name,
              p.membership_tier ?? null,
              activityTypes,
              p.time_start ?? null,
              p.time_end ?? null,
              p.price_per_hour_cents,
              p.price_subsequent_cents ?? null,
              p.subsequent_increment_min ?? 30,
              p.priority ?? 0,
            ],
          );
          return text({ message: "Pricing rule created", rule: rows[0] });
        } else {
          const { rows } = await pool.query(
            `INSERT INTO pricing_rules (workspace_id, name, membership_tier, activity_types, time_start, time_end, price_per_hour_cents, priority)
             VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8)
             RETURNING id, name, price_per_hour_cents, priority`,
            [
              p.workspace_id,
              p.name,
              p.membership_tier ?? null,
              activityTypes,
              p.time_start ?? null,
              p.time_end ?? null,
              p.price_per_hour_cents,
              p.priority ?? 0,
            ],
          );
          return text({ message: "Pricing rule created", rule: rows[0] });
        }
      }

      if (p.action === "update") {
        if (!p.rule_id) return text({ error: "rule_id required for update" });
        const sets: string[] = [];
        const vals: any[] = [p.rule_id];
        let idx = 2;
        if (p.name) {
          sets.push(`name = $${idx++}`);
          vals.push(p.name);
        }
        if (p.price_per_hour_cents) {
          sets.push(`price_per_hour_cents = $${idx++}`);
          vals.push(p.price_per_hour_cents);
          if (isGolf) {
            sets.push(`price_first_hour_cents = $${idx - 1}`);
          }
        }
        if (p.price_subsequent_cents != null) {
          sets.push(`price_subsequent_cents = $${idx++}`);
          vals.push(p.price_subsequent_cents);
        }
        if (p.subsequent_increment_min) {
          sets.push(`subsequent_increment_min = $${idx++}`);
          vals.push(p.subsequent_increment_min);
        }
        if (p.priority !== undefined) {
          sets.push(`priority = $${idx++}`);
          vals.push(p.priority);
        }
        if (p.time_start) {
          sets.push(`time_start = $${idx++}`);
          vals.push(p.time_start);
        }
        if (p.time_end) {
          sets.push(`time_end = $${idx++}`);
          vals.push(p.time_end);
        }
        if (sets.length === 0) return text({ error: "No fields to update" });
        const { rows } = await pool.query(
          `UPDATE pricing_rules SET ${sets.join(", ")} WHERE id = $1 RETURNING id, name, price_per_hour_cents, priority`,
          vals,
        );
        return text({ message: "Pricing rule updated", rule: rows[0] });
      }

      if (p.action === "deactivate") {
        if (!p.rule_id) return text({ error: "rule_id required" });
        await pool.query("UPDATE pricing_rules SET is_active = false WHERE id = $1", [p.rule_id]);
        return text({ message: "Pricing rule deactivated" });
      }

      return text({ error: `Unknown action: ${p.action}` });
    },
  });

  log.info("[rdy-business-tools] registered tools with multi-database routing");
}
