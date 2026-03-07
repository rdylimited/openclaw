#!/bin/bash
# Apply WeCom Customer Service (微信客服) patches to the wecom plugin.
# Run after: openclaw plugins install @sunnoy/wecom
#
# Usage: bash ~/openclaw-src/patches/wecom-kf/apply-kf-patches.sh

set -euo pipefail
WECOM_DIR="$HOME/.openclaw/extensions/wecom/wecom"
PATCH_DIR="$(dirname "$0")"

echo "=== Applying WeCom Customer Service patches ==="

# 1. Copy new files
cp "$PATCH_DIR/kf-api.js" "$WECOM_DIR/kf-api.js"
cp "$PATCH_DIR/kf-handler.js" "$WECOM_DIR/kf-handler.js"
echo "[✓] Copied kf-api.js and kf-handler.js"

# 2. Patch http-handler.js — add kf import and routing
if ! grep -q 'handleKfInbound' "$WECOM_DIR/http-handler.js"; then
  # Add import after handleAgentInbound import
  sed -i '/import { handleAgentInbound } from "\.\/agent-inbound\.js";/a import { handleKfInbound } from "./kf-handler.js";' "$WECOM_DIR/http-handler.js"

  # Add kf routing after agent inbound block
  sed -i '/return handleAgentInbound({/,/});/{
    /});/a\
\
  // ── KF inbound: route to Customer Service handler when target has kfInbound config ──\
  const kfTarget = targets.find((t) => t.account?.kfInbound);\
  if (kfTarget) {\
    return handleKfInbound({\
      req,\
      res,\
      kfAccount: kfTarget.account.kfInbound,\
      config: kfTarget.config,\
    });\
  }
  }' "$WECOM_DIR/http-handler.js"
  echo "[✓] Patched http-handler.js"
else
  echo "[·] http-handler.js already patched"
fi

# 3. Patch agent-inbound.js — add kf_msg_or_event routing
if ! grep -q 'processKfNotification' "$WECOM_DIR/agent-inbound.js"; then
  # Add import
  sed -i '/import {$/,/} from "\.\/xml-parser\.js";/{
    /import {$/a import { processKfNotification } from "./kf-handler.js";
  }' "$WECOM_DIR/agent-inbound.js" 2>/dev/null || \
  sed -i '1a import { processKfNotification } from "./kf-handler.js";' "$WECOM_DIR/agent-inbound.js"
  echo "[✓] Patched agent-inbound.js (import)"
else
  echo "[·] agent-inbound.js already patched"
fi

# 4. Patch channel-plugin.js — add kfInboundConfigured and webhook registration
if ! grep -q 'kfInboundConfigured' "$WECOM_DIR/channel-plugin.js"; then
  echo "[!] channel-plugin.js needs manual patching — see WECOM_SETUP.md"
else
  echo "[·] channel-plugin.js already patched"
fi

echo ""
echo "=== Done. Restart OpenClaw to apply changes. ==="
echo "  systemctl --user restart openclaw-lion"
