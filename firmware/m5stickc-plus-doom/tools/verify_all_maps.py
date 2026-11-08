#!/usr/bin/env python3
"""Load every shareware Episode 1 map on a USB-connected Xiaodex."""

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


def warp(device, map_number: int) -> None:
    request_id = f"warp{map_number}"
    request = {
        "cmd": "device_control",
        "v": 1,
        "id": request_id,
        "op": "warp",
        "map": map_number,
    }
    device.write(json.dumps(request, separators=(",", ":")).encode() + b"\n")
    device.flush()
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        raw = device.readline()
        if not raw:
            continue
        line = raw.decode("utf-8", errors="replace").strip()
        if line:
            print(f"[serial] {line}")
        try:
            response = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (response.get("ack") == "device_control" and
                response.get("id") == request_id and
                response.get("op") == "warp"):
            if response.get("state") != "accepted":
                raise RuntimeError(f"warp rejected: {response}")
            return
    raise RuntimeError(f"timed out requesting E1M{map_number}")


def verify_health(status: dict, map_number: int) -> dict[str, int]:
    if status.get("episode") != 1 or status.get("map") != map_number:
        raise RuntimeError(f"expected E1M{map_number}, got {status}")
    for counter in (
        "drawseg_overflows",
        "opening_overflows",
        "vissprite_overflows",
    ):
        if int(status.get(counter, -1)) != 0:
            raise RuntimeError(f"E1M{map_number} reported {counter}: {status}")

    metrics = {
        "zone_free": int(status.get("zone_free", 0)),
        "zone_largest": int(status.get("zone_largest", 0)),
        "stack_free": int(status.get("stack_free", 0)),
        "heap_8bit_free": int(status.get("heap_8bit_free", 0)),
        "heap_8bit_largest": int(status.get("heap_8bit_largest", 0)),
    }
    minimums = {
        "zone_free": 1,
        "zone_largest": 1,
        "stack_free": 4096,
        "heap_8bit_free": 8192,
        "heap_8bit_largest": 1024,
    }
    for name, minimum in minimums.items():
        if metrics[name] < minimum:
            raise RuntimeError(
                f"E1M{map_number} {name}={metrics[name]} below {minimum}"
            )
    return metrics


def pulse_key(device, key: bytes, delay: float = 0.22) -> None:
    device.write(key)
    device.flush()
    time.sleep(delay)


def soak_map(
    device, map_number: int, seconds: float, save_slot: int | None
) -> dict:
    start = read_status(device)
    verify_health(start, map_number)
    start_pose = (
        int(start.get("player_x", 0)),
        int(start.get("player_y", 0)),
        int(start.get("player_angle", 0)),
    )
    pattern = (b"w", b"a", b"f", b"d", b" ", b"w", b"f", b"s")
    deadline = time.monotonic() + seconds
    next_status = time.monotonic()
    index = 0
    latest = start
    while time.monotonic() < deadline:
        pulse_key(device, pattern[index % len(pattern)], 0.12)
        index += 1
        if time.monotonic() >= next_status:
            latest = read_status(device)
            verify_health(latest, map_number)
            next_status = time.monotonic() + 2.0

    end_pose = (
        int(latest.get("player_x", 0)),
        int(latest.get("player_y", 0)),
        int(latest.get("player_angle", 0)),
    )
    if end_pose == start_pose:
        raise RuntimeError(f"E1M{map_number} soak did not move or turn the player")

    if save_slot is not None:
        # Main menu: New, Options, Load, Save. SaveDef opens on slot zero.
        pulse_key(device, b"m", 0.5)
        for _ in range(3):
            pulse_key(device, b"s", 0.3)
        pulse_key(device, b" ", 0.6)
        for _ in range(save_slot):
            pulse_key(device, b"s", 0.25)
        pulse_key(device, b" ", 1.2)
        latest = read_status(device)
        verify_health(latest, map_number)
        print(f"Saved E1M{map_number} to slot {save_slot} during soak")

    print(f"Soaked E1M{map_number} for {seconds:.1f}s with move/fire/use")
    return latest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port")
    parser.add_argument("--open-delay", type=float, default=5.0)
    parser.add_argument("--screenshot", type=Path)
    parser.add_argument("--soak-map", type=int, choices=range(1, 10), default=6)
    parser.add_argument("--soak-seconds", type=float, default=0.0)
    parser.add_argument(
        "--save-slot",
        type=int,
        choices=range(8),
        help="overwrite this save slot (0-7) during the optional soak",
    )
    args = parser.parse_args()
    if args.soak_seconds < 0:
        raise RuntimeError("--soak-seconds cannot be negative")
    if args.save_slot is not None and args.soak_seconds <= 0:
        raise RuntimeError("--save-slot requires a positive --soak-seconds")

    port = resolve_port(args.port)
    device = open_serial(port, 115200, 25.0)
    try:
        time.sleep(args.open_delay)
        device.reset_input_buffer()
        first = read_status(device)
        minima = verify_health(first, 1)
        print("Verified E1M1")

        if args.soak_seconds > 0 and args.soak_map == 1:
            status = soak_map(device, 1, args.soak_seconds, args.save_slot)
            health = verify_health(status, 1)
            minima = {name: min(minima[name], health[name]) for name in minima}

        for map_number in range(2, 10):
            warp(device, map_number)
            time.sleep(1.0)
            status = read_status(device, timeout=25.0)
            health = verify_health(status, map_number)
            minima = {name: min(minima[name], health[name]) for name in minima}
            print(f"Verified E1M{map_number}")
            if args.soak_seconds > 0 and args.soak_map == map_number:
                status = soak_map(
                    device, map_number, args.soak_seconds, args.save_slot
                )
                health = verify_health(status, map_number)
                minima = {name: min(minima[name], health[name]) for name in minima}

        if args.screenshot:
            capture = DeviceController(device, timeout=30.0).capture()
            output = save_capture_png(capture, args.screenshot)
            print(f"Captured E1M9 to {output}")
        if args.soak_seconds > 0:
            warp(device, args.soak_map)
            time.sleep(1.0)
            reloaded = read_status(device, timeout=25.0)
            health = verify_health(reloaded, args.soak_map)
            minima = {name: min(minima[name], health[name]) for name in minima}
            print(f"Reloaded E1M{args.soak_map} after the full map pass")
        print("Minimum health: " + ", ".join(f"{k}={v}" for k, v in minima.items()))
        print(f"All nine Episode 1 maps loaded on {port}")
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"verify_all_maps: {error}", file=sys.stderr)
        raise SystemExit(1) from error
