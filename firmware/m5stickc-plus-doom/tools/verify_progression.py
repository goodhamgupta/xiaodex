#!/usr/bin/env python3
"""Hardware smoke test: use GBADoom's exit-level cheat and reach E1M2."""

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


# GBADoom's eight-key Exit Level sequence translated to the USB fallback:
# LEFT, R, LEFT, L, FIRE, LEFT, RIGHT, USE.
EXIT_SEQUENCE = (b"a", b"e", b"a", b"q", b"f", b"a", b"d", b" ")


def read_status(device, timeout: float = 20.0):
    device.write(b'{"cmd":"status"}\n')
    device.flush()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        raw = device.readline()
        if not raw:
            continue
        line = raw.decode("utf-8", errors="replace").strip()
        if line:
            print(f"[serial] {line}")
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("ack") == "status" and message.get("ok") is True:
            return message["data"]
    raise RuntimeError("timed out waiting for status")


def drain_logs(device, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        raw = device.readline()
        if raw:
            print(f"[serial] {raw.decode('utf-8', errors='replace').strip()}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port")
    parser.add_argument("--open-delay", type=float, default=5.0)
    parser.add_argument("--screenshot", type=Path)
    args = parser.parse_args()

    port = resolve_port(args.port)
    device = open_serial(port, 115200, 20.0)
    try:
        time.sleep(args.open_delay)
        device.reset_input_buffer()
        before = read_status(device)
        if before.get("episode") != 1 or before.get("map") != 1:
            raise RuntimeError(f"expected E1M1 before test, got {before}")

        for key in EXIT_SEQUENCE:
            device.write(key)
            device.flush()
            time.sleep(0.25)  # serial key auto-release is 180 ms

        # Accelerate the intermission counters and continue to the next map.
        drain_logs(device, 1.5)
        for _ in range(4):
            device.write(b" ")
            device.flush()
            time.sleep(0.65)
        drain_logs(device, 5.0)

        after = read_status(device)
        if after.get("episode") != 1 or after.get("map") != 2:
            raise RuntimeError(f"expected E1M2 after exit, got {after}")
        if args.screenshot:
            capture = DeviceController(device, timeout=30.0).capture()
            output = save_capture_png(capture, args.screenshot)
            print(f"Captured E1M2 to {output}")
        print(f"Xiaodex progressed from E1M1 to E1M2 on {port}")
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"verify_progression: {error}", file=sys.stderr)
        raise SystemExit(1) from error
