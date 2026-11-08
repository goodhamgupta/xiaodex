#!/usr/bin/env python3
"""Verify that both Xiaodex action buttons restart Doom after death."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "m5stickc-plus" / "tools"))

from device_control import (  # noqa: E402
    DeviceController,
    open_serial,
    resolve_port,
    save_capture_png,
)
from verify_progression import read_status  # noqa: E402


def kill_player(device, request_id: str) -> None:
    request = {
        "cmd": "device_control",
        "v": 1,
        "id": request_id,
        "op": "kill",
    }
    device.write(json.dumps(request, separators=(",", ":")).encode() + b"\n")
    device.flush()
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        raw = device.readline()
        if not raw:
            continue
        try:
            response = json.loads(raw.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            continue
        if response.get("id") != request_id or response.get("op") != "kill":
            continue
        if response.get("state") != "accepted":
            raise RuntimeError(f"kill rejected: {response}")
        return
    raise RuntimeError("timed out requesting the death diagnostic")


def require_state(device, expected: int, label: str) -> dict:
    status = read_status(device, timeout=15.0)
    if int(status.get("player_state", -1)) != expected:
        raise RuntimeError(f"expected {label}, got {status}")
    return status


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port")
    parser.add_argument("--open-delay", type=float, default=5.0)
    parser.add_argument("--death-screenshot", type=Path)
    parser.add_argument("--reborn-screenshot", type=Path)
    args = parser.parse_args()

    port = resolve_port(args.port)
    device = open_serial(port, 115200, 25.0)
    try:
        time.sleep(args.open_delay)
        device.reset_input_buffer()
        controller = DeviceController(device, timeout=30.0)
        initial = require_state(device, 0, "PST_LIVE")
        initial_map = int(initial.get("map", 0))

        controller.button("A", "press")
        time.sleep(0.25)
        kill_player(device, "kill-a")
        time.sleep(0.5)
        dead = require_state(device, 1, "PST_DEAD")
        if int(dead.get("player_health", 1)) > 0:
            raise RuntimeError(f"dead player still has positive health: {dead}")
        if args.death_screenshot:
            save_capture_png(controller.capture(), args.death_screenshot)

        # A held across death must not skip the death screen; release, then
        # make a fresh press to restart.
        controller.button("A", "release")
        time.sleep(0.25)
        controller.button("A", "tap")
        time.sleep(1.5)
        reborn_a = require_state(device, 0, "PST_LIVE after A")
        if int(reborn_a.get("map", 0)) != initial_map:
            raise RuntimeError(f"A restarted on the wrong map: {reborn_a}")

        kill_player(device, "kill-b")
        time.sleep(0.5)
        require_state(device, 1, "PST_DEAD before B")
        controller.button("B", "tap")
        time.sleep(1.5)
        reborn_b = require_state(device, 0, "PST_LIVE after B")
        if int(reborn_b.get("map", 0)) != initial_map:
            raise RuntimeError(f"B restarted on the wrong map: {reborn_b}")
        if args.reborn_screenshot:
            save_capture_png(controller.capture(), args.reborn_screenshot)

        print(f"A and short-B both restarted E1M{initial_map} on {port}")
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"verify_death_restart: {error}", file=sys.stderr)
        raise SystemExit(1) from error
