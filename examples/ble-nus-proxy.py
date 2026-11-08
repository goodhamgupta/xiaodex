#!/usr/bin/env python3
import argparse
import asyncio
import contextlib
import json
import sys

from bleak import BleakClient, BleakScanner

NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"


async def find_device(name_prefix: str, timeout: float):
    print(f"[ble] scanning for {name_prefix!r} for {timeout:g}s", flush=True)
    devices = await BleakScanner.discover(timeout=timeout, return_adv=True)
    for _, (device, adv) in devices.items():
        name = device.name or adv.local_name or ""
        uuids = [u.lower() for u in (adv.service_uuids or [])]
        if name.startswith(name_prefix) or NUS_SERVICE in uuids:
            print(f"[ble] found {name or device.address} {device.address}", flush=True)
            return device
    raise RuntimeError(f"no BLE device found with prefix {name_prefix!r} or NUS service")


async def connect_tcp(host: str, port: int):
    while True:
        try:
            reader, writer = await asyncio.open_connection(host, port)
            print(f"[tcp] connected {host}:{port}", flush=True)
            return reader, writer
        except OSError as error:
            print(f"[tcp] waiting for {host}:{port}: {error}", flush=True)
            await asyncio.sleep(1)


def log_line(prefix: str, line: bytes):
    text = line.decode("utf-8", errors="replace").strip()
    if not text:
        return
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            summary = {}
            for key in ("cmd", "ack", "ok", "total", "running", "waiting", "pet_state", "msg"):
                if key in parsed:
                    summary[key] = parsed[key]
            text = json.dumps(summary or parsed, separators=(",", ":"))
    except json.JSONDecodeError:
        pass
    if len(text) > 220:
        text = text[:217] + "..."
    print(f"{prefix} {text}", flush=True)


async def main():
    parser = argparse.ArgumentParser(description="Bridge codex_buddy TCP JSONL to BLE Nordic UART Service.")
    parser.add_argument("--name-prefix", default="Codex-")
    parser.add_argument("--address")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--scan-timeout", type=float, default=10)
    parser.add_argument("--write-timeout", type=float, default=45)
    parser.add_argument("--reconnect-delay", type=float, default=2)
    args = parser.parse_args()

    while True:
        try:
            await run_once(args)
        except KeyboardInterrupt:
            raise
        except Exception as error:
            print(f"[bridge] disconnected: {error}", flush=True)
        print(f"[bridge] reconnecting in {args.reconnect_delay:g}s", flush=True)
        await asyncio.sleep(args.reconnect_delay)


async def run_once(args):
    target = args.address or await find_device(args.name_prefix, args.scan_timeout)
    reader, writer = await connect_tcp(args.host, args.port)

    try:
        async with BleakClient(target) as client:
            print(f"[ble] connected {client.address}", flush=True)
            print("[ble] if macOS asks for a passkey, type the number shown on the M5 screen", flush=True)

            ble_rx_buf = bytearray()

            def on_notify(_, data: bytearray):
                if not data:
                    return
                writer.write(bytes(data))
                ble_rx_buf.extend(data)
                while True:
                    try:
                        idx = ble_rx_buf.index(10)
                    except ValueError:
                        break
                    line = bytes(ble_rx_buf[:idx])
                    del ble_rx_buf[:idx + 1]
                    log_line("[ble->tcp]", line)

            await client.start_notify(NUS_TX, on_notify)

            async def tcp_to_ble():
                tcp_rx_buf = bytearray()
                while True:
                    data = await reader.read(180)
                    if not data:
                        print("[tcp] closed", flush=True)
                        return
                    tcp_rx_buf.extend(data)
                    while True:
                        try:
                            idx = tcp_rx_buf.index(10)
                        except ValueError:
                            break
                        line = bytes(tcp_rx_buf[:idx])
                        del tcp_rx_buf[:idx + 1]
                        log_line("[tcp->ble]", line)
                    await asyncio.wait_for(
                        client.write_gatt_char(NUS_RX, data, response=True),
                        timeout=args.write_timeout,
                    )

            async def tcp_drain():
                while True:
                    await writer.drain()
                    await asyncio.sleep(0.05)

            tasks = [asyncio.create_task(tcp_to_ble()), asyncio.create_task(tcp_drain())]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            for task in done:
                task.result()
    finally:
        writer.close()
        await writer.wait_closed()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
