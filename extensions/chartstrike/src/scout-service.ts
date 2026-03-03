/**
 * Background scout service — polls Pit API for high-strength signals,
 * runs qwen3-4b-scout analysis, sends WhatsApp alerts, and auto-triggers
 * Boardroom debates for very strong signals.
 */
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { pitFetch } from "./pit-client.js";
import { scoutAnalyze } from "./scout-client.js";

type ScoutConfig = {
  boardroomUrl: string;
  alertThreshold: number;
  autoDebateThreshold: number;
  pollIntervalMs: number;
  whatsappTarget: string;
};

let config: ScoutConfig = {
  boardroomUrl: "http://100.114.112.7:8002",
  alertThreshold: 0.7,
  autoDebateThreshold: 0.85,
  pollIntervalMs: 60_000,
  whatsappTarget: "85293830979",
};

export function configureScoutService(partial: Partial<ScoutConfig>): void {
  config = { ...config, ...partial };
}

// Polling lock to prevent concurrent poll cycles
let polling = false;

// Dedup: signal ID → timestamp when first seen. Evict after 1 hour.
const seenSignals = new Map<string, number>();
const SEEN_TTL_MS = 60 * 60 * 1000;

// Debated tickers — only auto-debate each ticker once per TTL
const debatedTickers = new Map<string, number>();

function evictStaleSignals(): void {
  const cutoff = Date.now() - SEEN_TTL_MS;
  for (const [id, ts] of seenSignals) {
    if (ts < cutoff) seenSignals.delete(id);
  }
  for (const [t, ts] of debatedTickers) {
    if (ts < cutoff) debatedTickers.delete(t);
  }
}

type PitReport = {
  id?: string;
  ticker?: string;
  signal_strength?: number;
  signal_type?: string;
  source?: string;
  raw_data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

async function sendWhatsApp(to: string, text: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync(
      "openclaw",
      ["message", "send", "--channel", "whatsapp", "--target", `+${to}`, "--message", text],
      { timeout: 30_000 },
    );
  } catch (err) {
    console.error("[chartstrike-scout] WhatsApp send failed:", err);
  }
}

async function triggerDebate(ticker: string): Promise<string | null> {
  try {
    const res = await fetch(`${config.boardroomUrl}/debates/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return formatDebateResult(data);
  } catch {
    return null;
  }
}

function formatDebateResult(data: Record<string, unknown>): string {
  const decision = data.decision ?? data.final_decision ?? "unknown";
  const confidence = data.confidence ?? data.final_confidence ?? "?";
  const rationale = data.rationale ?? data.summary ?? "";
  const ticker = data.ticker ?? "";
  return (
    `*Boardroom Debate: ${ticker}*\n` +
    `Decision: *${decision}* (${confidence}% confidence)\n` +
    `${rationale}`
  );
}

async function pollCycle(logger: OpenClawPluginServiceContext["logger"]): Promise<void> {
  if (polling) {
    logger.info("Scout poll skipped (previous cycle still running)");
    return;
  }
  polling = true;
  try {
    await pollCycleInner(logger);
  } finally {
    polling = false;
  }
}

async function pollCycleInner(logger: OpenClawPluginServiceContext["logger"]): Promise<void> {
  evictStaleSignals();

  let reports: PitReport[];
  try {
    const data = await pitFetch<PitReport[] | { data?: PitReport[] }>("/reports?limit=20");
    reports = Array.isArray(data) ? data : (data?.data ?? []);
  } catch (err) {
    logger.warn(`Scout poll failed: ${err}`);
    return;
  }

  const maxStrength =
    reports.length > 0 ? Math.max(...reports.map((r) => Math.abs(r.signal_strength ?? 0))) : 0;
  logger.info(
    `Scout poll: ${reports.length} reports, max strength=${maxStrength.toFixed(2)}, threshold=${config.alertThreshold}`,
  );

  for (const report of reports) {
    const signalId =
      report.id ?? `${report.ticker}-${report.signal_strength}-${report.signal_type}`;
    if (seenSignals.has(signalId)) continue;

    const strength = Math.abs(report.signal_strength ?? 0);
    if (strength < config.alertThreshold) continue;

    seenSignals.set(signalId, Date.now());
    const ticker = report.ticker ?? "???";
    const dir = (report.signal_strength ?? 0) >= 0 ? "bullish" : "bearish";

    // Run scout analysis
    let scoutTake = "";
    try {
      const verdict = await scoutAnalyze(ticker, JSON.stringify(report));
      scoutTake = `Scout: ${verdict.summary}`;
    } catch {
      scoutTake = "Scout: analysis unavailable";
    }

    // Build alert message from raw_data
    const rd = report.raw_data ?? {};
    const premium = rd.total_premium ? `$${Number(rd.total_premium).toLocaleString()}` : "";
    const strike = rd.strike ? `$${rd.strike}` : "";
    const optType = rd.type ? String(rd.type).toUpperCase() : "";
    const expiry = rd.expiry ? String(rd.expiry) : "";
    const alertMsg =
      `*${ticker} Alert* (${strength.toFixed(2)} ${dir}): ` +
      `${report.signal_type ?? "signal"}` +
      (optType ? ` ${optType}` : "") +
      (strike ? ` @ ${strike}` : "") +
      (expiry ? ` exp ${expiry}` : "") +
      (premium ? ` | Premium: ${premium}` : "") +
      `\n${scoutTake}` +
      `\nReply */debate ${ticker}* for full analysis.`;

    logger.info(`Alert: ${ticker} strength=${strength} ${dir}`);
    await sendWhatsApp(config.whatsappTarget, alertMsg);

    // Auto-trigger debate for very strong signals (once per ticker per TTL)
    if (strength >= config.autoDebateThreshold && !debatedTickers.has(ticker)) {
      debatedTickers.set(ticker, Date.now());
      logger.info(`Auto-debate triggered for ${ticker} (strength=${strength})`);
      const debateResult = await triggerDebate(ticker);
      if (debateResult) {
        await sendWhatsApp(config.whatsappTarget, debateResult);
      }
    }
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export const scoutService: OpenClawPluginService = {
  id: "chartstrike-scout",

  start: (ctx) => {
    ctx.logger.info(
      `Scout service started (poll=${config.pollIntervalMs}ms, ` +
        `alert>=${config.alertThreshold}, auto-debate>=${config.autoDebateThreshold})`,
    );

    // Initial poll after 10s delay (let WhatsApp session stabilize)
    setTimeout(() => {
      pollCycle(ctx.logger).catch((err) => ctx.logger.error(`Scout poll error: ${err}`));
    }, 10_000);

    pollTimer = setInterval(() => {
      pollCycle(ctx.logger).catch((err) => ctx.logger.error(`Scout poll error: ${err}`));
    }, config.pollIntervalMs);
  },

  stop: (ctx) => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    ctx.logger.info("Scout service stopped");
  },
};
