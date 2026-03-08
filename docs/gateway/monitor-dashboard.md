---
summary: "Single-file real-time dashboard for monitoring OpenClaw agent activity"
read_when:
  - Setting up the gateway monitor dashboard
  - Debugging WebSocket connection issues
  - Adding or mapping new agent avatars
title: "Gateway Monitor Dashboard"
---

# Gateway Monitor Dashboard

A standalone single-file HTML dashboard (`openclaw-monitor.html`) that visualises OpenClaw agent activities in real-time via the Gateway WebSocket API.

## Features

- Live agent cards — one per agent, showing current state (idle / thinking / tool / error)
- Real-time activity feed with streaming text deduplication
- Collapsible feed panel to maximise agent tile visibility
- Dark terminal aesthetic with avatar sprites and state icons
- Responsive flex grid — cards wrap to additional rows when more than 5 agents are present

## Prerequisites

1. **Static asset server** — the dashboard loads avatar and banner images from a local HTTP server. By default it expects assets at `http://<host>:8899/`. Serve them with:

   ```bash
   python3 ~/.claude/scripts/serve.py ~/banana_squad/outputs 8899 &
   ```

2. **Dashboard server** — serve the HTML file itself from a *separate* origin (port 8900 is used by convention):

   ```bash
   python3 ~/.claude/scripts/serve.py ~/ 8900 &
   ```

   The dashboard and assets must be on **different origins** so the browser treats them as separate servers.

## Configuration

### 1. Gateway token

Edit the dashboard and set `TOKEN` to a gateway token from your `openclaw.json`:

```html
const TOKEN = 'your-gateway-token-here';
const WS_URL = 'ws://<gateway-host>:<port>/ws';
```

### 2. Allow the dashboard origin

Add the dashboard's origin to `gateway.controlUi.allowedOrigins` in `~/.openclaw/openclaw.json`:

```json
{
  "gateway": {
    "controlUi": {
      "allowedOrigins": [
        "http://<dashboard-host>:8900"
      ],
      "dangerouslyDisableDeviceAuth": true
    }
  }
}
```

`dangerouslyDisableDeviceAuth` is required when accessing the Control UI from a remote LAN address rather than localhost.

Restart OpenClaw after editing the config.

## WebSocket Handshake

The dashboard implements the full gateway handshake:

1. **Server → Client**: `connect.challenge` event with `nonce`
2. **Client → Server**: `connect` request:

```json
{
  "type": "req",
  "id": "connect-1",
  "method": "connect",
  "params": {
    "minProtocol": 1,
    "maxProtocol": 10,
    "client": {
      "id": "openclaw-control-ui",
      "version": "1.0.0",
      "platform": "browser",
      "mode": "ui"
    },
    "auth": { "token": "<token>" },
    "scopes": [
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing"
    ]
  }
}
```

> **Note:** The `scopes` array is required to request `operator.read`, without which `agents.list` returns an error. The `auth` object must not contain a `device` field — `ConnectParamsSchema` uses `additionalProperties: false`.

3. **Server → Client**: `res` frame with `payload.type === "hello-ok"` containing a `snapshot` with `sessionDefaults.defaultAgentId`.

## Agent Discovery

Agents are discovered from two sources:

- `snapshot.sessionDefaults.defaultAgentId` from the hello-ok response
- `agents.list` RPC called immediately after auth (requires `operator.read` scope)

## Avatar Mapping

The avatar sprite sheet (`openclaw-avatars-v2-enhanced.png`) is a 3×1 horizontal strip:

| Position | Class | Agents |
|---|---|---|
| 0% (left) | `.av-lion` | `main`, any agent with `lion` or `wecom` in its id |
| 50% (centre) | `.av-utrade` | agents with `utrade` or `trade` in their id |
| 100% (right) | `.av-miffy` | agents with `miffy` in their id |
| fallback | `.av-other` | all other agents (shows a text initial) |

To add a new avatar variant, extend `agentColor()` in the dashboard script and add a corresponding `.av-<name>` CSS class with the appropriate `background-position`.

## State Icons

The state icon sprite sheet (`openclaw-states-v1-faithful.png`) is a 2×2 grid:

| Position | State |
|---|---|
| top-left (0% 0%) | thinking |
| top-right (100% 0%) | tool |
| bottom-left (0% 100%) | idle |
| bottom-right (100% 100%) | error |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Keeps reconnecting" | Dashboard origin not in `allowedOrigins` | Add `http://<host>:<port>` to `openclaw.json` and restart |
| "Invalid request frame" | Missing required fields in connect params | Ensure `id`, `minProtocol`, `maxProtocol`, `client.mode` are all present |
| "AWAITING CONNECTION..." at idle | No events arrive until agent activity | Normal — cards populate on first event or via `agents.list` |
| `agents.list returned: null` | Missing `operator.read` scope | Add `scopes` array to connect params (see above) |
| Feed flooding with text tokens | Streaming text events | Dashboard deduplicates by `runId` — update in place |
| Avatar shows initials instead of image | Agent id not matched by `agentColor()` | Extend the function with a new pattern match |
