#!/usr/bin/env bash
# Trigger a profitability report via OpenClaw hooks/agent endpoint
# Dispatches an agent run that delivers results to Slack
# Usage: profitability-trigger.sh <report_type>
# report_type: daily_brief | weekly_digest | monthly_review | annual_review

REPORT_TYPE="${1:-daily_brief}"
OPENCLAW_PORT="${OPENCLAW_PORT:-18789}"
HOOKS_TOKEN="${HOOKS_TOKEN:-cortex-bridge-token-2026}"

curl -s -X POST "http://localhost:${OPENCLAW_PORT}/hooks/agent" \
  -H "Authorization: Bearer ${HOOKS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Run the ${REPORT_TYPE} profitability report for all workspaces\",\"name\":\"profitability-${REPORT_TYPE}\",\"deliver\":true,\"channel\":\"slack\"}" \
  || echo "[profitability-trigger] Failed to reach OpenClaw on port ${OPENCLAW_PORT}"
