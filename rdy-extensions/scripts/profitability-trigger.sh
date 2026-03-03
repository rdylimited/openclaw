#!/usr/bin/env bash
# Trigger a profitability report via OpenClaw hooks/wake endpoint
# Usage: profitability-trigger.sh <report_type>
# report_type: daily_brief | weekly_digest | monthly_review | annual_review

REPORT_TYPE="${1:-daily_brief}"
OPENCLAW_PORT="${OPENCLAW_PORT:-18789}"
HOOKS_TOKEN="${HOOKS_TOKEN:?HOOKS_TOKEN env var required}"

curl -s -X POST "http://localhost:${OPENCLAW_PORT}/hooks/wake" \
  -H "Authorization: Bearer ${HOOKS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"text\":\"Run the ${REPORT_TYPE} profitability report for all workspaces and send it to me\"}" \
  || echo "[profitability-trigger] Failed to reach OpenClaw on port ${OPENCLAW_PORT}"
