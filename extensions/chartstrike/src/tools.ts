/**
 * Market data tools (from Pit API) and signal tracking tools.
 * Migrated from ~/.openclaw/extensions/chartstrike/index.ts
 */
import * as fs from "fs";
import * as path from "path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { pitFetch, pitPost, textResult } from "./pit-client.js";

const SIGNALS_FILE = path.join(
  process.env.HOME || "/home/samau",
  ".openclaw",
  "chartstrike-signals.json",
);

// --- Signal types & storage ---

interface Signal {
  id: string;
  ticker: string;
  direction: "bullish" | "bearish";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  price_at_signal: number;
  key_level: number | null;
  reasoning: string;
  recorded_at: string;
  source_tool: string;
  reviewed_at?: string;
  price_at_review?: number;
  outcome?: "correct" | "incorrect" | "pending";
  pnl_percent?: number;
}

function loadSignals(): Signal[] {
  try {
    if (fs.existsSync(SIGNALS_FILE)) {
      return JSON.parse(fs.readFileSync(SIGNALS_FILE, "utf-8"));
    }
  } catch {
    /* ignore */
  }
  return [];
}

function saveSignals(signals: Signal[]): void {
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(signals, null, 2));
}

function now(): string {
  return new Date().toLocaleString("en-HK", { timeZone: "Asia/Hong_Kong", hour12: false });
}

function calculateStreak(signals: Signal[]): string {
  const scored = signals.filter((s) => s.outcome !== "pending").reverse();
  if (scored.length === 0) return "No scored signals yet";
  let streak = 0;
  const firstOutcome = scored[0].outcome;
  for (const s of scored) {
    if (s.outcome === firstOutcome) streak++;
    else break;
  }
  return `${streak} ${firstOutcome === "correct" ? "wins" : "losses"} in a row`;
}

// --- Registration ---

export function registerTools(api: OpenClawPluginApi): void {
  // ============================================================
  //  SIGNAL TRACKING TOOLS
  // ============================================================

  api.registerTool({
    label: "",
    name: "record_signal",
    description:
      "Record a trading signal/prediction for tracking. Call this whenever you identify a whale swing or notable market signal.",
    parameters: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Stock ticker symbol, e.g. AAPL" },
        direction: {
          type: "string",
          enum: ["bullish", "bearish"],
          description: "Signal direction",
        },
        confidence: {
          type: "string",
          enum: ["HIGH", "MEDIUM", "LOW"],
          description: "Confidence level",
        },
        price_at_signal: {
          type: "number",
          description: "Current stock price when signal was identified",
        },
        key_level: { type: "number", description: "Key strike price or level (optional)" },
        reasoning: {
          type: "string",
          description: "What whale activity or data triggered this signal",
        },
        source_tool: {
          type: "string",
          description: "Which tool provided the data (e.g. flow_alerts)",
        },
      },
      required: [
        "ticker",
        "direction",
        "confidence",
        "price_at_signal",
        "reasoning",
        "source_tool",
      ],
    },
    async execute(_id: string, p: Record<string, unknown>) {
      const signals = loadSignals();
      const signal: Signal = {
        id: `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ticker: (p.ticker as string).toUpperCase(),
        direction: p.direction as "bullish" | "bearish",
        confidence: p.confidence as "HIGH" | "MEDIUM" | "LOW",
        price_at_signal: p.price_at_signal as number,
        key_level: (p.key_level as number) || null,
        reasoning: p.reasoning as string,
        recorded_at: new Date().toISOString(),
        source_tool: p.source_tool as string,
        outcome: "pending",
      };
      signals.push(signal);
      saveSignals(signals);
      return textResult({
        status: "recorded",
        signal_id: signal.id,
        message: `Signal recorded: ${signal.ticker} ${signal.direction.toUpperCase()} at $${signal.price_at_signal} (${signal.confidence})`,
        total_signals: signals.length,
        pending_review: signals.filter((s) => s.outcome === "pending").length,
      });
    },
  });

  api.registerTool({
    label: "",
    name: "review_signals",
    description:
      "Review pending signals against current market prices. Checks if past predictions were correct.",
    parameters: {
      type: "object",
      properties: {
        days_back: { type: "number", description: "How many days back to review (default: 7)" },
      },
      required: [],
    },
    async execute(_id: string, p: Record<string, unknown>) {
      const signals = loadSignals();
      const daysBack = (p.days_back as number) || 7;
      const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
      const pending = signals.filter((s) => s.outcome === "pending" && s.recorded_at >= cutoff);

      if (pending.length === 0) {
        return textResult({
          message: `No pending signals in the last ${daysBack} days.`,
          total_signals: signals.length,
        });
      }

      const tickers = [...new Set(pending.map((s) => s.ticker))];
      const prices: Record<string, number | null> = {};
      for (const ticker of tickers) {
        try {
          const data = await pitFetch<Record<string, unknown>>(`/flow/${ticker}/summary`);
          const d = (data?.data ?? data) as Record<string, unknown>;
          const price = d?.price ?? d?.last_price ?? null;
          prices[ticker] = typeof price === "number" ? price : null;
        } catch {
          prices[ticker] = null;
        }
      }

      const results: Record<string, unknown>[] = [];
      for (const signal of pending) {
        const currentPrice = prices[signal.ticker];
        if (currentPrice === null || currentPrice === undefined) {
          results.push({
            ...signal,
            current_price: null,
            outcome: "pending",
            note: "Could not fetch price",
          });
          continue;
        }
        const pctChange = ((currentPrice - signal.price_at_signal) / signal.price_at_signal) * 100;
        const wentUp = pctChange > 0.5;
        const wentDown = pctChange < -0.5;
        let outcome: "correct" | "incorrect" | "pending" = "pending";
        if (signal.direction === "bullish" && wentUp) outcome = "correct";
        else if (signal.direction === "bearish" && wentDown) outcome = "correct";
        else if (signal.direction === "bullish" && wentDown) outcome = "incorrect";
        else if (signal.direction === "bearish" && wentUp) outcome = "incorrect";
        if (outcome !== "pending") {
          signal.reviewed_at = new Date().toISOString();
          signal.price_at_review = currentPrice;
          signal.outcome = outcome;
          signal.pnl_percent = parseFloat(pctChange.toFixed(2));
        }
        results.push({
          signal_id: signal.id,
          ticker: signal.ticker,
          direction: signal.direction,
          confidence: signal.confidence,
          price_at_signal: signal.price_at_signal,
          current_price: currentPrice,
          pct_change: parseFloat(pctChange.toFixed(2)),
          outcome,
          reasoning: signal.reasoning,
          recorded_at: signal.recorded_at,
        });
      }
      saveSignals(signals);
      const all = signals.filter((s) => s.outcome !== "pending");
      const correct = all.filter((s) => s.outcome === "correct").length;
      const incorrect = all.filter((s) => s.outcome === "incorrect").length;
      const total = correct + incorrect;
      return textResult({
        review_date: now(),
        days_back: daysBack,
        signals_reviewed: results.length,
        results,
        scorecard: {
          total_scored: total,
          correct,
          incorrect,
          still_pending: signals.filter((s) => s.outcome === "pending").length,
          accuracy: total > 0 ? `${((correct / total) * 100).toFixed(1)}%` : "N/A",
          streak: calculateStreak(signals),
        },
      });
    },
  });

  api.registerTool({
    label: "",
    name: "signal_scorecard",
    description:
      "Get overall signal accuracy scorecard — lifetime stats on prediction accuracy, best/worst tickers, streaks.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const signals = loadSignals();
      const scored = signals.filter((s) => s.outcome !== "pending");
      const correct = scored.filter((s) => s.outcome === "correct");
      const incorrect = scored.filter((s) => s.outcome === "incorrect");
      const pending = signals.filter((s) => s.outcome === "pending");
      const tickerStats: Record<string, { correct: number; incorrect: number; signals: number }> =
        {};
      for (const s of scored) {
        if (!tickerStats[s.ticker])
          tickerStats[s.ticker] = { correct: 0, incorrect: 0, signals: 0 };
        tickerStats[s.ticker].signals++;
        if (s.outcome === "correct") tickerStats[s.ticker].correct++;
        else tickerStats[s.ticker].incorrect++;
      }
      const confStats: Record<string, { correct: number; total: number }> = {};
      for (const s of scored) {
        if (!confStats[s.confidence]) confStats[s.confidence] = { correct: 0, total: 0 };
        confStats[s.confidence].total++;
        if (s.outcome === "correct") confStats[s.confidence].correct++;
      }
      const avgPnl =
        scored.length > 0
          ? scored.reduce((sum, s) => sum + (s.pnl_percent || 0), 0) / scored.length
          : 0;
      return textResult({
        as_of: now(),
        lifetime: {
          total_signals: signals.length,
          scored: scored.length,
          correct: correct.length,
          incorrect: incorrect.length,
          pending: pending.length,
          accuracy:
            scored.length > 0 ? `${((correct.length / scored.length) * 100).toFixed(1)}%` : "N/A",
          avg_pnl_percent: parseFloat(avgPnl.toFixed(2)),
          streak: calculateStreak(signals),
        },
        by_ticker: tickerStats,
        by_confidence: Object.fromEntries(
          Object.entries(confStats).map(([k, v]) => [
            k,
            { ...v, accuracy: `${((v.correct / v.total) * 100).toFixed(1)}%` },
          ]),
        ),
        recent_signals: signals.slice(-10).reverse(),
      });
    },
  });

  // ============================================================
  //  MARKET DATA TOOLS (from Pit API)
  // ============================================================

  const marketTools: Array<{ name: string; description: string; path: string }> = [
    {
      name: "market_pulse",
      description:
        "Get overall market pulse — bullish/bearish sentiment, sector rotation, key movers.",
      path: "/flow/market-pulse",
    },
    {
      name: "market_tide",
      description:
        "Get market tide — net premium flow across the entire market showing institutional positioning.",
      path: "/flow/market-tide",
    },
    {
      name: "flow_alerts",
      description:
        "Get latest unusual options flow alerts — large whale trades, sweeps, unusual activity.",
      path: "/flow/flow-alerts",
    },
    {
      name: "flow_spike",
      description: "Get tickers with unusual volume spikes indicating whale activity.",
      path: "/flow/spike",
    },
    {
      name: "darkpool_recent",
      description: "Get recent dark pool trades — large institutional block trades off-exchange.",
      path: "/flow/darkpool-recent",
    },
    {
      name: "lit_flow_recent",
      description: "Get recent lit (exchange) flow — large visible trades on public exchanges.",
      path: "/flow/lit-flow-recent",
    },
    {
      name: "oi_change",
      description: "Get open interest changes — new positions being opened or closed.",
      path: "/flow/oi-change",
    },
    { name: "market_news", description: "Get latest market news headlines.", path: "/flow/news" },
    {
      name: "congress_trades",
      description: "Get recent congressional stock trades.",
      path: "/flow/congress-trades",
    },
    {
      name: "economic_calendar",
      description: "Get upcoming economic events calendar.",
      path: "/flow/economic-calendar",
    },
    {
      name: "insider_sentiment",
      description: "Get insider sentiment — aggregate insider buying vs selling activity.",
      path: "/flow/insider-sentiment",
    },
    {
      name: "sectors_overview",
      description: "Get sector performance overview.",
      path: "/flow/sectors",
    },
    {
      name: "stock_screener",
      description: "Screen stocks by various criteria.",
      path: "/flow/screener/stocks",
    },
    {
      name: "options_screener",
      description: "Screen options for unusual activity.",
      path: "/flow/screener/options",
    },
  ];

  for (const t of marketTools) {
    api.registerTool({
      label: "",
      name: t.name,
      description: t.description,
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return textResult(await pitFetch(t.path));
      },
    });
  }

  // --- Ticker-specific tools ---

  const tickerTools: Array<{ name: string; description: string; pathSuffix: string }> = [
    {
      name: "ticker_flow_alerts",
      description: "Get unusual options flow alerts for a specific ticker.",
      pathSuffix: "flow-alerts",
    },
    {
      name: "ticker_flow_recent",
      description: "Get recent options flow for a specific ticker.",
      pathSuffix: "flow-recent",
    },
    {
      name: "ticker_net_premium",
      description: "Get net premium flow — whether whales are net buying calls or puts.",
      pathSuffix: "net-prem",
    },
    {
      name: "ticker_darkpool",
      description: "Get dark pool activity for a specific ticker.",
      pathSuffix: "darkpool",
    },
    {
      name: "ticker_gex",
      description: "Get gamma exposure (GEX) — key hedging levels creating support/resistance.",
      pathSuffix: "gex",
    },
    {
      name: "ticker_summary",
      description: "Get comprehensive summary for a ticker — key stats, flow, sentiment, price.",
      pathSuffix: "summary",
    },
    {
      name: "ticker_options_volume",
      description: "Get options volume breakdown — calls vs puts, by expiry.",
      pathSuffix: "options-volume",
    },
    {
      name: "ticker_insider",
      description: "Get insider trading activity for a ticker.",
      pathSuffix: "insider",
    },
    {
      name: "ticker_shorts",
      description: "Get short interest data — short volume, days to cover, utilization.",
      pathSuffix: "shorts",
    },
  ];

  for (const t of tickerTools) {
    api.registerTool({
      label: "",
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string", description: "Stock ticker symbol, e.g. AAPL, TSLA, SPY" },
        },
        required: ["ticker"],
      },
      async execute(_id: string, p: Record<string, unknown>) {
        return textResult(
          await pitFetch(`/flow/${(p.ticker as string).toUpperCase()}/${t.pathSuffix}`),
        );
      },
    });
  }

  // ============================================================
  //  DAILY SUMMARY (aggregated from Pit DB)
  // ============================================================

  api.registerTool({
    label: "",
    name: "daily_summary",
    description:
      "Get aggregated daily signal summary with time-series data. Returns: signal counts by type/ticker, strongest signals, bull/bear ratio, confluent tickers, PLUS hourly_flow (hour-by-hour breakdown), daily_accumulation (rolling N-day totals), and monthly_accumulation (N-month totals). Use this to narrate flow evolution over time, not just flat aggregates.",
    parameters: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Date in YYYY-MM-DD format (default: today UTC)",
        },
        include_timeseries: {
          type: "boolean",
          description: "Include hourly, daily, monthly time-series (default: true)",
        },
        lookback_days: {
          type: "number",
          description: "Days of daily accumulation history (1-90, default: 7)",
        },
        lookback_months: {
          type: "number",
          description: "Months of monthly accumulation history (1-12, default: 3)",
        },
      },
      required: [],
    },
    async execute(_id: string, p: Record<string, unknown>) {
      const params = new URLSearchParams();
      if (p.date) params.set("date", String(p.date));
      if (p.include_timeseries !== undefined)
        params.set("include_timeseries", String(p.include_timeseries));
      if (p.lookback_days) params.set("lookback_days", String(p.lookback_days));
      if (p.lookback_months) params.set("lookback_months", String(p.lookback_months));
      const qs = params.toString() ? `?${params.toString()}` : "";
      return textResult(await pitFetch(`/reports/daily-summary${qs}`));
    },
  });

  // ============================================================
  //  WATCHLIST MANAGEMENT TOOLS
  // ============================================================

  api.registerTool({
    label: "",
    name: "list_watchlists",
    description:
      "List current high-priority tickers (30s poll) and watchlist tickers (5min poll) being monitored for signals.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      return textResult(await pitFetch("/config/watchlist"));
    },
  });

  api.registerTool({
    label: "",
    name: "add_to_watchlist",
    description:
      "Add one or more tickers to the watchlist (5min poll) or high-priority list (30s poll). Requires owner authorization.",
    parameters: {
      type: "object",
      properties: {
        tickers: {
          type: "string",
          description: "Comma-separated ticker symbols to add, e.g. AAPL,TSLA,NVDA",
        },
        list_name: {
          type: "string",
          enum: ["watchlist", "high_priority"],
          description: "Which list to add to (default: watchlist)",
        },
      },
      required: ["tickers"],
    },
    async execute(_id: string, p: Record<string, unknown>) {
      const tickers = (p.tickers as string)
        .split(",")
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean);
      const listName = (p.list_name as string) || "watchlist";
      return textResult(await pitPost("/config/watchlist", { list_name: listName, add: tickers }));
    },
  });

  api.registerTool({
    label: "",
    name: "remove_from_watchlist",
    description:
      "Remove one or more tickers from the watchlist or high-priority list. Requires owner authorization.",
    parameters: {
      type: "object",
      properties: {
        tickers: {
          type: "string",
          description: "Comma-separated ticker symbols to remove, e.g. AAPL,TSLA",
        },
        list_name: {
          type: "string",
          enum: ["watchlist", "high_priority"],
          description: "Which list to remove from (default: watchlist)",
        },
      },
      required: ["tickers"],
    },
    async execute(_id: string, p: Record<string, unknown>) {
      const tickers = (p.tickers as string)
        .split(",")
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean);
      const listName = (p.list_name as string) || "watchlist";
      return textResult(
        await pitPost("/config/watchlist", { list_name: listName, remove: tickers }),
      );
    },
  });
}
