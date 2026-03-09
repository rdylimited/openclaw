#!/usr/bin/env python3
"""
NYSE market-hours model switcher for OpenClaw + Cortex.

Checks actual NYSE calendar (holidays, early closes, weekends) and sets:
  - Market OPEN   → rdyfinance-pro (thinking ON, deep analysis)
  - Market CLOSED → rdy-scout      (thinking OFF, fast replies)

Agents affected: main (chartstrike webchat + WA groups), utrade (WA utrade group)
Hot-reload: OpenClaw detects openclaw.json changes automatically — no restart needed.
Cortex: updates CORTEX_LOCAL_MODEL in ~/cortex/.env and restarts container if changed.
"""

import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import exchange_calendars as ec
import pandas as pd

CONFIG_PATH = Path.home() / ".openclaw" / "openclaw.json"
CORTEX_ENV_PATH = Path.home() / "cortex" / ".env"
CORTEX_COMPOSE_DIR = Path.home() / "cortex"

MODEL_MARKET_OPEN   = "rdyfinance-pro/rdycore-pro"
MODEL_MARKET_CLOSED = "rdy-scout/rdycore-pro"
FALLBACKS = ["moonshot/kimi-k2.5"]

# Cortex uses raw vLLM model IDs (no provider prefix)
CORTEX_MODEL_MARKET_OPEN   = "rdyfinance-pro"
CORTEX_MODEL_MARKET_CLOSED = "rdycore-pro"

AGENTS_TO_SWITCH = {"main", "utrade"}


def is_nyse_open() -> tuple[bool, str]:
    """Returns (is_open, reason) using live NYSE exchange_calendars."""
    nyse = ec.get_calendar("XNYS")
    now_utc = pd.Timestamp.now(tz="UTC")

    # is_session needs a tz-naive date string
    today_str = now_utc.strftime("%Y-%m-%d")
    is_session = nyse.is_session(today_str)

    if not is_session:
        day_name = now_utc.strftime("%A")
        return False, f"no session today ({day_name} / holiday)"

    is_open = nyse.is_open_on_minute(now_utc)
    reason = "market open" if is_open else "market closed (outside trading hours)"
    return is_open, reason


def switch_model(target_model: str) -> bool:
    """Update openclaw.json. Returns True if a change was made."""
    with open(CONFIG_PATH) as f:
        config = json.load(f)

    agents  = config.get("agents", {})
    defaults = agents.get("defaults", {})
    agent_list = agents.get("list", [])
    changed = False

    # Default model (covers main + any agent without explicit override)
    if defaults.get("model", {}).get("primary") != target_model:
        defaults["model"]      = {"primary": target_model, "fallbacks": FALLBACKS}
        defaults["imageModel"] = {"primary": target_model, "fallbacks": FALLBACKS}
        changed = True

    # Explicit per-agent overrides
    for agent in agent_list:
        if agent.get("id") in AGENTS_TO_SWITCH:
            if agent.get("model", {}).get("primary") != target_model:
                agent["model"] = {"primary": target_model, "fallbacks": FALLBACKS}
                changed = True

    if changed:
        with open(CONFIG_PATH, "w") as f:
            json.dump(config, f, indent=2)

    return changed


def switch_cortex_model(target_model: str) -> bool:
    """Update CORTEX_LOCAL_MODEL in ~/cortex/.env and restart if changed."""
    if not CORTEX_ENV_PATH.exists():
        print("  [cortex] .env not found, skipping")
        return False

    env_content = CORTEX_ENV_PATH.read_text()

    # Check current value
    match = re.search(r"^CORTEX_LOCAL_MODEL=(.+)$", env_content, re.MULTILINE)
    current = match.group(1).strip() if match else None

    if current == target_model:
        return False

    # Update or append the env var
    if match:
        new_content = re.sub(
            r"^CORTEX_LOCAL_MODEL=.+$",
            f"CORTEX_LOCAL_MODEL={target_model}",
            env_content,
            flags=re.MULTILINE,
        )
    else:
        new_content = env_content.rstrip() + f"\nCORTEX_LOCAL_MODEL={target_model}\n"

    CORTEX_ENV_PATH.write_text(new_content)

    # Restart cortex container
    try:
        subprocess.run(
            ["docker", "compose", "up", "-d", "--force-recreate", "cortex"],
            cwd=CORTEX_COMPOSE_DIR,
            capture_output=True,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, subprocess.SubprocessError) as e:
        print(f"  [cortex] restart failed: {e}")

    return True


def main():
    now_hkt = datetime.now().strftime("%Y-%m-%d %H:%M:%S HKT")
    is_open, reason = is_nyse_open()

    # OpenClaw switch
    target  = MODEL_MARKET_OPEN if is_open else MODEL_MARKET_CLOSED
    changed = switch_model(target)
    print(f"[{now_hkt}] NYSE: {reason} → {target} ({'CHANGED' if changed else 'unchanged'})")

    # Cortex switch
    cortex_target = CORTEX_MODEL_MARKET_OPEN if is_open else CORTEX_MODEL_MARKET_CLOSED
    cortex_changed = switch_cortex_model(cortex_target)
    print(f"  [cortex] model → {cortex_target} ({'CHANGED' if cortex_changed else 'unchanged'})")


if __name__ == "__main__":
    main()
