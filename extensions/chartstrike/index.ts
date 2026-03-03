/**
 * ChartStrike OpenClaw Extension
 *
 * Provides market intelligence tools (Pit API), scout analysis (qwen3-4b-scout),
 * /debate command (Boardroom integration), and background signal monitoring
 * with WhatsApp alerts.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { configurePit, pitFetch, textResult } from "./src/pit-client.js";
import { configureScout, scoutAnalyze } from "./src/scout-client.js";
import { configureScoutService, scoutService } from "./src/scout-service.js";
import { registerTools } from "./src/tools.js";

const BOARDROOM_URL_DEFAULT = "http://100.114.112.7:8002";
let boardroomUrl = BOARDROOM_URL_DEFAULT;

function formatDebateForWhatsApp(data: Record<string, unknown>): string {
  const ticker = data.ticker ?? "";
  const decision = data.decision ?? data.final_decision ?? "unknown";
  const confidence = data.confidence ?? data.final_confidence ?? "?";
  const rationale = data.rationale ?? data.summary ?? "";
  const rounds = data.rounds_completed ?? data.debate_rounds ?? "?";
  return (
    `*Boardroom Debate: ${ticker}*\n` +
    `Decision: *${decision}* (${confidence}% confidence)\n` +
    `Rounds: ${rounds}\n` +
    `${rationale}`
  );
}

const plugin = {
  id: "chartstrike",
  name: "ChartStrike Market Intelligence",
  description:
    "Market data, scout analysis, Boardroom debates, and real-time signal monitoring with WhatsApp alerts.",

  register(api: OpenClawPluginApi) {
    // --- Read plugin config ---
    const cfg = api.pluginConfig ?? {};
    const pitUrl = (cfg.pitUrl as string) || "http://100.114.112.7:8001";
    const scoutUrl = (cfg.scoutUrl as string) || "http://100.115.36.67:8082";
    const scoutModel = (cfg.scoutModel as string) || "qwen3-4b-scout";
    boardroomUrl = (cfg.boardroomUrl as string) || BOARDROOM_URL_DEFAULT;
    const alertThreshold = (cfg.alertThreshold as number) || 0.7;
    const autoDebateThreshold = (cfg.autoDebateThreshold as number) || 0.85;
    const pollIntervalMs = (cfg.pollIntervalMs as number) || 60_000;
    const whatsappTarget = (cfg.whatsappTarget as string) || "85293830979";

    // --- Configure modules ---
    configurePit(pitUrl);
    configureScout(scoutUrl, scoutModel);
    configureScoutService({
      boardroomUrl,
      alertThreshold,
      autoDebateThreshold,
      pollIntervalMs,
      whatsappTarget,
    });

    api.logger.info(
      `ChartStrike extension loaded (pit=${pitUrl}, scout=${scoutUrl}, boardroom=${boardroomUrl})`,
    );

    // --- Register all market data + signal tracking tools ---
    registerTools(api);

    // --- scout_analysis tool ---
    api.registerTool({
      name: "scout_analysis",
      description:
        "Get a quick scout analysis on any ticker using qwen3-4b-scout. " +
        "Fetches context from Pit API (summary + flow + net premium) and asks the scout for a bull/bear/hold verdict.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string", description: "Stock ticker symbol, e.g. AAPL" },
        },
        required: ["ticker"],
      },
      async execute(_id: string, p: Record<string, unknown>) {
        const ticker = (p.ticker as string).toUpperCase();

        // Gather context from Pit
        const [summary, flow, netPrem] = await Promise.allSettled([
          pitFetch(`/flow/${ticker}/summary`),
          pitFetch(`/flow/${ticker}/flow-alerts`),
          pitFetch(`/flow/${ticker}/net-prem`),
        ]);

        const context = JSON.stringify({
          summary: summary.status === "fulfilled" ? summary.value : null,
          flow_alerts: flow.status === "fulfilled" ? flow.value : null,
          net_premium: netPrem.status === "fulfilled" ? netPrem.value : null,
        });

        const verdict = await scoutAnalyze(ticker, context);

        return textResult({
          ticker,
          scout_model: scoutModel,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          analysis: verdict.summary,
          data_sources: {
            summary: summary.status === "fulfilled",
            flow_alerts: flow.status === "fulfilled",
            net_premium: netPrem.status === "fulfilled",
          },
        });
      },
    });

    // --- /debate command ---
    api.registerCommand({
      name: "debate",
      description: "Trigger a Boardroom AI debate for a ticker. Usage: /debate TSLA",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const ticker = ctx.args?.trim().toUpperCase();
        if (!ticker) {
          return {
            content: [{ type: "text", text: "Usage: /debate <TICKER>\nExample: /debate TSLA" }],
          };
        }

        try {
          const res = await fetch(`${boardroomUrl}/debates/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticker }),
          });

          if (!res.ok) {
            const body = await res.text().catch(() => "");
            return {
              content: [{ type: "text", text: `Boardroom error ${res.status}: ${body}` }],
            };
          }

          const data = (await res.json()) as Record<string, unknown>;
          return {
            content: [{ type: "text", text: formatDebateForWhatsApp(data) }],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Debate failed: ${err}` }],
          };
        }
      },
    });

    // --- Background scout service ---
    api.registerService(scoutService);
  },
};

export default plugin;
