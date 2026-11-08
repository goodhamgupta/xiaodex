#!/usr/bin/env python3
"""Wait for one real tilt gesture and one physical A press."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "m5stickc-plus" / "tools"))

from device_control import DeviceController, open_serial, resolve_port  # noqa: E402


def set_test_mode(device, active: bool, wait_for_ack: bool = True) -> None:
    operation = "physical_test" if active else "physical_end"
    request_id = operation
    request = {
        "cmd": "device_control", "v": 1, "id": request_id, "op": operation
    }
    device.write(json.dumps(request, separators=(",", ":")).encode() + b"\n")
    device.flush()
    if not wait_for_ack:
        return
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        raw = device.readline()
        if not raw:
            continue
        try:
            response = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if (response.get("ack") == "device_control" and
                response.get("id") == request_id and
                response.get("state") == "accepted"):
            return
    raise RuntimeError(f"timed out starting {operation}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port")
    parser.add_argument("--open-delay", type=float, default=5.0)
    parser.add_argument("--timeout", type=float, default=60.0)
    args = parser.parse_args()

    port = resolve_port(args.port)
    device = open_serial(port, 115200, 10.0)
    try:
        time.sleep(args.open_delay)
        device.reset_input_buffer()
        controller = DeviceController(device, timeout=10.0)
        set_test_mode(device, True)
        deadline = time.monotonic() + args.timeout
        tilt_seen = False
        a_seen = False
        movement_seen = False
        peak = 0.0
        initial = controller.status()
        start_x = int(initial.get("player_x", 0))
        start_y = int(initial.get("player_y", 0))
        start_angle = int(initial.get("player_angle", 0))
        last_report = 0.0
        last_state = None
        while time.monotonic() < deadline and not (tilt_seen and a_seen and movement_seen):
            status = controller.status()
            peak = max(peak, abs(float(status.get("tilt_x", 0))),
                       abs(float(status.get("tilt_y", 0))))
            tilt_seen = tilt_seen or peak >= 0.18
            a_seen = a_seen or status.get("button_a") is True
            x = int(status.get("player_x", start_x))
            y = int(status.get("player_y", start_y))
            angle = int(status.get("player_angle", start_angle))
            angle_delta = min((angle - start_angle) & 0xFFFFFFFF,
                              (start_angle - angle) & 0xFFFFFFFF)
            movement_seen = movement_seen or abs(x - start_x) >= 2 or abs(y - start_y) >= 2 or angle_delta >= 0x01000000
            state = (tilt_seen, a_seen, movement_seen)
            now = time.monotonic()
            if state != last_state or now - last_report >= 1.0:
                print(
                    f"tilt={'yes' if tilt_seen else 'waiting'} "
                    f"movement={'yes' if movement_seen else 'waiting'} "
                    f"physical-A={'yes' if a_seen else 'waiting'} peak={peak:.3f}g",
                    flush=True,
                )
                last_state = state
                last_report = now
            time.sleep(0.08)
        if not tilt_seen or not a_seen or not movement_seen:
            raise RuntimeError(
                f"timed out (tilt={tilt_seen}, movement={movement_seen}, "
                f"physical_a={a_seen}, peak={peak:.3f}g)"
            )
        print(f"Physical tilt movement/turn and A verified on {port}")
        return 0
    finally:
        try:
            set_test_mode(device, False, wait_for_ack=False)
        except OSError:
            pass
        device.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"verify_physical_controls: {error}", file=sys.stderr)
        raise SystemExit(1) from error
