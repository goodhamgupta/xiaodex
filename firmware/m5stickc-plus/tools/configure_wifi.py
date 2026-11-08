#!/usr/bin/env python3
"""Provision Codex Buddy Wi-Fi settings over one explicit USB serial port."""

import argparse
import getpass
import json
import os
import re
import sys
import time

import serial


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Store Wi-Fi and authenticated bridge settings in M5StickC Plus NVS."
    )
    parser.add_argument("--port", required=True, help="Exact /dev/cu.usbserial-* path")
    parser.add_argument("--ssid")
    parser.add_argument("--host", help="LAN address of the Mac running codex-buddy")
    parser.add_argument("--bridge-port", type=int, default=8787)
    parser.add_argument("--baud", type=int, default=115200)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--forget", action="store_true", help="Remove stored Wi-Fi credentials")
    mode.add_argument(
        "--bridge-only",
        action="store_true",
        help="Update only bridge host, port, and token; preserve saved Wi-Fi credentials",
    )
    parser.add_argument("--reset-delay", type=float, default=2.0)
    parser.add_argument("--timeout", type=float, default=8.0)
    return parser.parse_args(argv)


def require_bridge_settings(args):
    host = args.host or os.environ.get("CODEX_BUDDY_BRIDGE_HOST", "")
    token = os.environ.get("CODEX_BUDDY_TOKEN", "")
    if not host or len(host) > 64:
        raise SystemExit("provide --host or CODEX_BUDDY_BRIDGE_HOST (maximum 64 characters)")
    if not 1 <= args.bridge_port <= 65535:
        raise SystemExit("--bridge-port must be between 1 and 65535")
    if not re.fullmatch(r"[A-Za-z0-9._~-]{16,96}", token):
        raise SystemExit(
            "set CODEX_BUDDY_TOKEN to the same 16-96 character URL-safe secret used by the bridge"
        )
    return host, token


def require_wifi_settings(args):
    ssid = args.ssid or os.environ.get("CODEX_BUDDY_WIFI_SSID", "")
    password = os.environ.get("CODEX_BUDDY_WIFI_PASSWORD")
    if password is None:
        if not sys.stdin.isatty():
            raise SystemExit("set CODEX_BUDDY_WIFI_PASSWORD (it may be empty for an open network)")
        password = getpass.getpass("Wi-Fi password (empty for open network): ")

    if not ssid or len(ssid.encode("utf-8")) > 32:
        raise SystemExit("provide --ssid or CODEX_BUDDY_WIFI_SSID (maximum 32 UTF-8 bytes)")
    if len(password) > 64:
        raise SystemExit("Wi-Fi password must be at most 64 characters")
    return ssid, password


def build_command(args):
    if args.forget:
        return {"cmd": "wifi_forget"}, "wifi_forget"

    host, token = require_bridge_settings(args)
    if args.bridge_only:
        return {
            "cmd": "bridge_config",
            "host": host,
            "port": args.bridge_port,
            "token": token,
        }, "bridge_config"

    ssid, password = require_wifi_settings(args)
    return {
        "cmd": "wifi_config",
        "ssid": ssid,
        "password": password,
        "host": host,
        "port": args.bridge_port,
        "token": token,
    }, "wifi_config"


def wait_for_ack(device, expected, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = device.readline()
        if not line:
            continue
        try:
            message = json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if isinstance(message, dict) and message.get("ack") == expected:
            return message
    raise TimeoutError(f"timed out waiting for {expected} acknowledgement")


def main():
    args = parse_args()
    if not args.port.startswith("/dev/cu.usbserial-"):
        raise SystemExit("--port must be an explicit /dev/cu.usbserial-* device")

    command, expected = build_command(args)

    with serial.Serial(args.port, args.baud, timeout=0.25, write_timeout=3) as device:
        time.sleep(args.reset_delay)
        device.reset_input_buffer()
        device.write(json.dumps(command, separators=(",", ":")).encode("utf-8") + b"\n")
        device.flush()
        ack = wait_for_ack(device, expected, args.timeout)

    if not ack.get("ok"):
        if args.bridge_only:
            raise SystemExit(
                "device rejected bridge_config; run full Wi-Fi provisioning once before --bridge-only"
            )
        raise SystemExit(f"device rejected {expected}")
    if args.forget:
        print("Wi-Fi configuration removed.")
    elif args.bridge_only:
        print("Bridge configuration stored; saved Wi-Fi credentials were not changed.")
    else:
        print("Wi-Fi configuration stored; the device is connecting.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, serial.SerialException, TimeoutError) as error:
        raise SystemExit(str(error)) from error
