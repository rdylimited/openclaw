# ChartStrike OpenClaw Extension

Market intelligence extension for [OpenClaw](https://github.com/openclaw/openclaw) that provides real-time options flow data, AI-powered signal analysis, and automated Boardroom debates — all accessible via WhatsApp.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  OpenClaw (lionclaw 100.113.161.109)                    │
│  ┌───────────────────────────────────────────────────┐  │
│  │  chartstrike extension                            │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │  │
│  │  │ 25 market│ │ scout    │ │ scout-service    │  │  │
│  │  │ tools    │ │ analysis │ │ (background)     │  │  │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────────────┘  │  │
│  │       │             │            │                 │  │
│  │  ┌────┴─────┐ ┌────┴─────┐ ┌────┴──────┐         │  │
│  │  │/debate   │ │ WhatsApp │ │ 60s poll  │         │  │
│  │  │command   │ │ alerts   │ │ loop      │         │  │
│  │  └────┬─────┘ └──────────┘ └────┬──────┘         │  │
│  └───────┼──────────────────────────┼────────────────┘  │
└──────────┼──────────────────────────┼───────────────────┘
           │                          │
     ┌─────▼─────┐            ┌──────▼──────┐
     │ Boardroom │            │  Pit API    │
     │ :8002     │            │  :8001      │
     │ rdycore-  │            │  (100.114.  │
     │ pro       │            │   112.7)    │
     └───────────┘            └──────┬──────┘
                                     │
                              ┌──────▼──────┐
                              │ UW MCP      │
                              │ Server      │
                              │ :8010       │
                              │ (100.67.    │
                              │  250.11)    │
                              └─────────────┘

     ┌─────────────┐
     │ qwen3-4b-   │
     │ scout :8082  │
     │ (100.115.   │
     │  36.67)     │
     └─────────────┘
```

## Files

```
extensions/chartstrike/
├── package.json              # @openclaw/chartstrike
├── openclaw.plugin.json      # Plugin manifest with config schema
├── index.ts                  # Entry — registers tools, /debate, scout service
└── src/
    ├── pit-client.ts         # HTTP client for Pit API + textResult() helper
    ├── scout-client.ts       # HTTP client for qwen3-4b-scout vLLM
    ├── scout-service.ts      # Background signal monitor (polls, alerts, auto-debates)
    └── tools.ts              # 25 market data tools + 3 signal tracking tools
```

**968 lines total** across 5 TypeScript source files.

## Features

### 1. Market Data Tools (25 tools)

General market tools (no ticker required):

| Tool                | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `market_pulse`      | Real-time market overview — volume, sentiment, top movers  |
| `market_tide`       | Aggregate options flow direction (bullish/bearish/neutral) |
| `flow_alerts`       | High-conviction flow alerts across all tickers             |
| `flow_spike`        | Unusual volume spikes and large block trades               |
| `darkpool_recent`   | Recent dark pool prints                                    |
| `lit_flow_recent`   | Recent lit exchange flow                                   |
| `oi_change`         | Open interest changes                                      |
| `market_news`       | Latest market news headlines                               |
| `congress_trades`   | Congressional trading activity                             |
| `economic_calendar` | Upcoming economic events                                   |
| `insider_sentiment` | Aggregate insider buy/sell sentiment                       |
| `sectors_overview`  | Sector rotation and ETF flow                               |
| `stock_screener`    | Screen stocks by technical/fundamental criteria            |
| `options_screener`  | Screen options by volume, OI, greeks                       |

Ticker-specific tools (require `ticker` parameter):

| Tool                    | Description                           |
| ----------------------- | ------------------------------------- |
| `ticker_flow_alerts`    | Flow alerts for a specific ticker     |
| `ticker_flow_recent`    | Recent options flow for a ticker      |
| `ticker_net_premium`    | Net premium (call vs put dollar flow) |
| `ticker_darkpool`       | Dark pool activity for a ticker       |
| `ticker_gex`            | Gamma exposure (GEX) profile          |
| `ticker_summary`        | Comprehensive ticker summary          |
| `ticker_options_volume` | Options volume breakdown              |
| `ticker_insider`        | Insider transactions                  |
| `ticker_shorts`         | Short interest and borrow data        |

### 2. Signal Tracking Tools (3 tools)

| Tool               | Description                                                |
| ------------------ | ---------------------------------------------------------- |
| `record_signal`    | Record a trading signal with ticker, direction, confidence |
| `review_signals`   | Review recorded signals and outcomes                       |
| `signal_scorecard` | Performance scorecard of signal accuracy                   |

### 3. Scout Analysis Tool

`scout_analysis` — Quick AI-powered analysis using qwen3-4b-scout (300 tps, 32K context).

1. Fetches context from Pit API: ticker summary + flow alerts + net premium
2. Sends to qwen3-4b-scout for a bull/bear/hold verdict with confidence
3. Returns structured analysis with data source availability

### 4. `/debate` Command

Triggers a full Boardroom AI debate via WhatsApp:

```
/debate TSLA
```

**Debate flow:**

1. Calls `POST http://boardroom:8002/debates/` with the ticker
2. Boardroom runs a 3-round debate using rdycore-pro (Qwen3.5 MoE, 200K context):
   - Round 1: Bull + Bear agents argue in parallel
   - Round 2: Contrarian agent challenges the consensus
   - Round 3: Judge renders final decision
3. Returns formatted WhatsApp message with decision, confidence, bull/bear theses

**Data sourcing:** If Redis has recent signals for the ticker, those are used. Otherwise, Boardroom enriches from Pit API via MCP bridge (stock state, greeks, max pain, NOPE, short data, news).

### 5. Background Scout Service

Runs continuously, polling Pit API every 60 seconds:

| Threshold              | Action                                        |
| ---------------------- | --------------------------------------------- |
| `\|strength\| >= 0.7`  | WhatsApp alert with scout analysis            |
| `\|strength\| >= 0.85` | Auto-triggers Boardroom debate + sends result |

**Dedup:** Tracks seen signal IDs, alerted tickers, and debated tickers with 1-hour TTL to prevent spam.

**Alert format:**

```
TSLA Alert (0.90 bearish): flow_spike PUT @ $250 exp 2026-03-21 | Premium: $1,200,000
Scout: Heavy institutional put buying suggests downside protection ahead of earnings.
Reply /debate TSLA for full analysis.
```

## Configuration

All settings are configurable via `openclaw.plugin.json` config schema or plugin config in `~/.openclaw/openclaw.json`:

| Key                   | Default                     | Description                                 |
| --------------------- | --------------------------- | ------------------------------------------- |
| `pitUrl`              | `http://100.114.112.7:8001` | Pit API base URL                            |
| `boardroomUrl`        | `http://100.114.112.7:8002` | Boardroom API base URL                      |
| `scoutUrl`            | `http://100.115.36.67:8082` | qwen3-4b-scout vLLM endpoint                |
| `scoutModel`          | `qwen3-4b-scout`            | Scout model name                            |
| `alertThreshold`      | `0.7`                       | Minimum signal strength for WhatsApp alerts |
| `autoDebateThreshold` | `0.85`                      | Minimum signal strength for auto-debate     |
| `pollIntervalMs`      | `60000`                     | Scout poll interval (ms)                    |
| `whatsappTarget`      | `85293830979`               | WhatsApp number for alerts (no + prefix)    |

## Infrastructure

| Service        | Host            | Port  | Model                     |
| -------------- | --------------- | ----- | ------------------------- |
| Pit API        | 100.114.112.7   | 8001  | —                         |
| Boardroom      | 100.114.112.7   | 8002  | rdycore-pro (Qwen3.5 MoE) |
| UW MCP Server  | 100.67.250.11   | 8010  | — (103 data tools)        |
| qwen3-4b-scout | 100.115.36.67   | 8082  | Qwen3 4B AWQ              |
| rdycore-pro    | 100.115.36.67   | 8000  | Qwen3.5 MoE (200K ctx)    |
| OpenClaw       | 100.113.161.109 | 18789 | rdycore-pro               |

## Boardroom Configuration

Key settings on the Boardroom VM (`~/chartstrike/services/the-boardroom/.env`):

```env
VLLM_URL=http://100.115.36.67:8000
VLLM_MODEL=rdycore-pro
VLLM_TIMEOUT=120
VLLM_MAX_TOKENS=4096
VLLM_TEMPERATURE=0.7
DEBATE_TIMEOUT=180
MCP_BRIDGE_URL=http://100.67.250.11:8010
```

**Important:** rdycore-pro uses `chat_template_kwargs: {"enable_thinking": false}` for structured JSON output to avoid `<think>` tags consuming the token budget.

## Development

### Build & Deploy

```bash
# On lionclaw (100.113.161.109)
cd ~/openclaw-src
pnpm build
python3 patches/apply-vllm-streaming-fix.py  # must run after pnpm install

# Restart (handle port zombie)
systemctl --user stop openclaw-lion
kill -9 $(ss -tlnp | grep 18789 | grep -oP 'pid=\K[0-9]+') 2>/dev/null
systemctl --user start openclaw-lion
```

### Verify

```bash
# Check health
curl http://100.114.112.7:8002/health

# Test debate directly
curl -X POST http://100.114.112.7:8002/debates/ \
  -H 'Content-Type: application/json' \
  -d '{"ticker":"AAPL","stream_to_chat":false}'

# Check scout logs
journalctl --user -u openclaw-lion -f | grep scout

# Test /debate via WhatsApp
# Send "/debate TSLA" to the bot's WhatsApp number
```

## Git History

Branch: `my-patches` on lionclaw

```
b241707c5 fix: improve auto-debate WhatsApp format
78802a0b0 fix: improve debate WhatsApp format — show bull/bear theses
4f1157c70 fix: add label+details fields for AgentTool type compliance
11d004cbd fix: consolidate alerts per ticker, strip <think> tags
addac9e45 fix: prevent re-entrant polls and duplicate auto-debates
8f9194b8e fix: use openclaw CLI for WhatsApp send
a1fa976a0 fix: scout service data parsing
3dad556d0 feat: add chartstrike extension with scout monitoring
```
