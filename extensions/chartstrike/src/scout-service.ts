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

// Dedup: report ID -> timestamp (prevent processing same DB row twice)
const seenReports = new Map<string, number>();
// Alerted tickers — track last alert state to detect significant changes
type AlertState = { ts: number; strength: number; direction: "bullish" | "bearish" };
const alertedTickers = new Map<string, AlertState>();
// Debated tickers — only auto-debate each ticker once per TTL
const debatedTickers = new Map<string, number>();
const SEEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — covers a full session
const SIGNIFICANT_DELTA = 0.15; // re-alert if strength changes by this much

function evictStale(): void {
  const cutoff = Date.now() - SEEN_TTL_MS;
  for (const [id, ts] of seenReports) {
    if (ts < cutoff) seenReports.delete(id);
  }
  for (const [t, state] of alertedTickers) {
    if (state.ts < cutoff) alertedTickers.delete(t);
  }
  for (const [t, ts] of debatedTickers) {
    if (ts < cutoff) debatedTickers.delete(t);
  }
}

/** Check if a new signal is significantly different from the last alert */
function isSignificantChange(
  ticker: string,
  newStrength: number,
  newDir: "bullish" | "bearish",
): boolean {
  const prev = alertedTickers.get(ticker);
  if (!prev) return true; // never alerted
  if (prev.direction !== newDir) return true; // direction flipped
  if (Math.abs(newStrength - prev.strength) >= SIGNIFICANT_DELTA) return true;
  return false;
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

/** Strip <think>...</think> tags from scout output */
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function sendWhatsApp(to: string, text: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    // execFile does NOT use a shell, so special chars are safe
    await execFileAsync(
      "openclaw",
      ["message", "send", "--channel", "whatsapp", "--target", `+${to}`, "--message", text],
      { timeout: 30_000 },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only log first line to avoid flooding
    console.error(`[chartstrike-scout] WhatsApp send failed: ${msg.split("\n")[0]}`);
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
    const data = (await res.json()) as Record<string, unknown>;
    return formatDebateResult(data);
  } catch {
    return null;
  }
}

function formatDebateResult(data: Record<string, unknown>): string {
  const ticker = data.ticker ?? "";
  const decision = data.decision ?? data.final_decision ?? "unknown";
  const rawConf = Number(data.confidence ?? data.final_confidence ?? 0);
  const confidence = rawConf <= 1 ? Math.round(rawConf * 100) : Math.round(rawConf);
  const rationale = data.rationale ?? data.summary ?? "";
  const rounds = data.rounds_completed ?? data.debate_rounds ?? "?";
  const duration = data.duration_ms ? `${Math.round(Number(data.duration_ms) / 1000)}s` : "?";
  const bullConf =
    data.bull_confidence != null ? Math.round(Number(data.bull_confidence) * 100) : null;
  const bearConf =
    data.bear_confidence != null ? Math.round(Number(data.bear_confidence) * 100) : null;

  let msg = `*Boardroom Debate: ${ticker}*\nDecision: *${decision}* (${confidence}% confidence)\n`;
  if (bullConf != null && bearConf != null) {
    msg += `Bull: ${bullConf}% | Bear: ${bearConf}%\n`;
  }
  msg += `Rounds: ${rounds} | Duration: ${duration}\n`;
  if (data.bull_thesis) {
    msg += `\n*Bull:* ${String(data.bull_thesis).slice(0, 200)}\n`;
  }
  if (data.bear_thesis) {
    msg += `*Bear:* ${String(data.bear_thesis).slice(0, 200)}\n`;
  }
  msg += `\n${rationale}`;
  return msg;
}

async function pollCycle(logger: OpenClawPluginServiceContext["logger"]): Promise<void> {
  if (polling) {
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
  evictStale();

  let reports: PitReport[];
  try {
    const data = await pitFetch<PitReport[] | { data?: PitReport[] }>("/reports?limit=20");
    reports = Array.isArray(data) ? data : (data?.data ?? []);
  } catch (err) {
    logger.warn(`Scout poll failed: ${err}`);
    return;
  }

  // Find the strongest signal per ticker (consolidate)
  const bestByTicker = new Map<string, { report: PitReport; strength: number }>();
  for (const report of reports) {
    const reportId = report.id ?? `${report.ticker}-${report.created_at}`;
    if (seenReports.has(reportId)) continue;
    seenReports.set(reportId, Date.now());

    const strength = Math.abs(report.signal_strength ?? 0);
    if (strength < config.alertThreshold) continue;

    const ticker = report.ticker ?? "???";
    const existing = bestByTicker.get(ticker);
    if (!existing || strength > existing.strength) {
      bestByTicker.set(ticker, { report, strength });
    }
  }

  const above = bestByTicker.size;
  if (above > 0) {
    logger.info(`Scout poll: ${reports.length} reports, ${above} tickers above threshold`);
  }

  // Process one alert per ticker (the strongest signal)
  for (const [ticker, { report, strength }] of bestByTicker) {
    const dir = (report.signal_strength ?? 0) >= 0 ? "bullish" : "bearish";

    // Skip unless this is a significant change from the last alert
    if (!isSignificantChange(ticker, strength, dir)) continue;
    alertedTickers.set(ticker, { ts: Date.now(), strength, direction: dir });

    // Run scout analysis
    let scoutTake = "";
    try {
      const verdict = await scoutAnalyze(ticker, JSON.stringify(report));
      scoutTake = `Scout: ${stripThinkTags(verdict.summary)}`;
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
      `${ticker} Alert (${strength.toFixed(2)} ${dir}): ` +
      `${report.signal_type ?? "signal"}` +
      (optType ? ` ${optType}` : "") +
      (strike ? ` @ ${strike}` : "") +
      (expiry ? ` exp ${expiry}` : "") +
      (premium ? ` | Premium: ${premium}` : "") +
      `\n${scoutTake}` +
      `\nReply /debate ${ticker} for full analysis.`;

    logger.info(`Alert: ${ticker} strength=${strength} ${dir}`);
    await sendWhatsApp(config.whatsappTarget, alertMsg);

    // Auto-trigger debate for very strong signals (once per ticker per TTL)
    if (strength >= config.autoDebateThreshold && !debatedTickers.has(ticker)) {
      debatedTickers.set(ticker, Date.now());
      logger.info(`Auto-debate: ${ticker} (strength=${strength})`);
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

    // Initial poll after 15s delay (let WhatsApp session stabilize)
    setTimeout(() => {
      pollCycle(ctx.logger).catch((err) => ctx.logger.error(`Scout poll error: ${err}`));
    }, 15_000);

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
