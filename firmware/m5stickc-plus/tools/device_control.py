#!/usr/bin/env python3
"""Inspect and control one USB-connected M5StickC Plus.

The device-control protocol is deliberately line-oriented: firmware logs may
appear between JSON replies without corrupting a screenshot transfer.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import glob
import json
import re
import secrets
import struct
import sys
import time
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Optional


PROTOCOL_VERSION = 1
DEFAULT_BAUD = 115200
DEFAULT_TIMEOUT = 15.0
DEFAULT_OPEN_DELAY = 2.2
USB_SERIAL_PATTERN = "/dev/cu.usbserial-*"
USB_SERIAL_RE = re.compile(r"^/dev/cu\.usbserial-[A-Za-z0-9._-]+$")
BUTTONS = frozenset(("A", "B"))
BUTTON_ACTIONS = frozenset(("tap", "press", "release", "hold"))


class DeviceControlError(RuntimeError):
    """Base class for expected controller failures."""


class PortSelectionError(DeviceControlError):
    """Raised when a USB serial port cannot be selected unambiguously."""


class ResponseTimeout(DeviceControlError):
    """Raised when the device does not send the expected response in time."""


class ProtocolError(DeviceControlError):
    """Raised when the device sends a malformed or inconsistent response."""


@dataclass(frozen=True)
class Capture:
    """One validated RGB332 framebuffer capture."""

    width: int
    height: int
    pixels: bytes
    crc32: str
    chunks: int


def resolve_port(
    explicit_port: Optional[str],
    *,
    globber: Callable[[str], Iterable[str]] = glob.glob,
) -> str:
    """Return an explicit port or the sole matching M5 USB serial port."""

    if explicit_port:
        if not USB_SERIAL_RE.fullmatch(explicit_port):
            raise PortSelectionError(
                "--port must be an explicit /dev/cu.usbserial-* device"
            )
        return explicit_port

    ports = sorted(set(globber(USB_SERIAL_PATTERN)))
    if not ports:
        raise PortSelectionError(
            "no /dev/cu.usbserial-* device found; connect the M5StickC Plus "
            "or provide --port"
        )
    if len(ports) > 1:
        choices = ", ".join(ports)
        raise PortSelectionError(
            f"multiple USB serial devices found ({choices}); select one with --port"
        )
    return ports[0]


def _compact_json(message: Dict[str, Any]) -> bytes:
    return json.dumps(message, separators=(",", ":"), ensure_ascii=True).encode(
        "utf-8"
    ) + b"\n"


def _integer(
    message: Dict[str, Any],
    key: str,
    *,
    minimum: Optional[int] = None,
    maximum: Optional[int] = None,
) -> int:
    value = message.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError(f"capture {key!r} must be an integer")
    if minimum is not None and value < minimum:
        raise ProtocolError(f"capture {key!r} must be at least {minimum}")
    if maximum is not None and value > maximum:
        raise ProtocolError(f"capture {key!r} must be at most {maximum}")
    return value


def _decode_crc32(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9A-Fa-f]{8}", value):
        raise ProtocolError("capture crc32 must be exactly eight hexadecimal digits")
    return value.lower()


class DeviceController:
    """Line-safe implementation of the USB device-control protocol."""

    def __init__(
        self,
        device: Any,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        clock: Callable[[], float] = time.monotonic,
        request_id_factory: Callable[[], str] = lambda: secrets.token_hex(8),
    ) -> None:
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self.device = device
        self.timeout = timeout
        self._clock = clock
        self._request_id_factory = request_id_factory

    def _write(self, message: Dict[str, Any]) -> None:
        self.device.write(_compact_json(message))
        self.device.flush()

    def _read_json(self, deadline: float) -> Dict[str, Any]:
        """Read the next JSON object, silently skipping firmware log lines."""

        while self._clock() < deadline:
            raw_line = self.device.readline()
            if not raw_line:
                continue
            try:
                if isinstance(raw_line, bytes):
                    line = raw_line.decode("utf-8")
                else:
                    line = str(raw_line)
                message = json.loads(line)
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if isinstance(message, dict):
                return message
        raise ResponseTimeout("timed out waiting for a response from the device")

    @staticmethod
    def _is_control_reply(
        message: Dict[str, Any], request_id: str, operation: str
    ) -> bool:
        return (
            message.get("ack") == "device_control"
            and message.get("v") == PROTOCOL_VERSION
            and message.get("id") == request_id
            and message.get("op") == operation
        )

    def _next_control_reply(
        self, request_id: str, operation: str, deadline: float
    ) -> Dict[str, Any]:
        while True:
            message = self._read_json(deadline)
            if self._is_control_reply(message, request_id, operation):
                return message

    @staticmethod
    def _raise_device_error(message: Dict[str, Any]) -> None:
        if message.get("state") != "error":
            return
        detail = message.get("error")
        if not isinstance(detail, str) or not detail:
            detail = "device rejected the request"
        raise ProtocolError(detail)

    def status(self) -> Dict[str, Any]:
        """Return the existing detailed firmware status payload."""

        self._write({"cmd": "status"})
        deadline = self._clock() + self.timeout
        while True:
            message = self._read_json(deadline)
            if message.get("ack") != "status":
                continue
            if message.get("ok") is not True:
                raise ProtocolError("device rejected the status request")
            data = message.get("data")
            if not isinstance(data, dict):
                raise ProtocolError("status response is missing its data object")
            return data

    def button(
        self,
        button: str,
        action: str,
        *,
        duration_ms: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Send one synthetic button action and wait for its acknowledgement."""

        button = button.upper()
        action = action.lower()
        if button not in BUTTONS:
            raise ValueError("button must be A or B")
        if action not in BUTTON_ACTIONS:
            raise ValueError("action must be tap, press, release, or hold")
        if action == "hold":
            if (
                isinstance(duration_ms, bool)
                or not isinstance(duration_ms, int)
                or not 50 <= duration_ms <= 30_000
            ):
                raise ValueError("hold duration_ms must be between 50 and 30000")
        elif duration_ms is not None:
            raise ValueError("duration_ms is only valid for a hold action")

        request_id = self._request_id_factory()
        request: Dict[str, Any] = {
            "cmd": "device_control",
            "v": PROTOCOL_VERSION,
            "id": request_id,
            "op": "button",
            "button": button,
            "action": action,
        }
        if duration_ms is not None:
            request["duration_ms"] = duration_ms

        self._write(request)
        deadline = self._clock() + self.timeout
        reply = self._next_control_reply(request_id, "button", deadline)
        self._raise_device_error(reply)
        if reply.get("state") != "accepted":
            raise ProtocolError(
                "button response must have state 'accepted' or 'error'"
            )
        return reply

    def capture(self) -> Capture:
        """Capture, validate, and return the device's RGB332 framebuffer."""

        request_id = self._request_id_factory()
        self._write(
            {
                "cmd": "device_control",
                "v": PROTOCOL_VERSION,
                "id": request_id,
                "op": "capture",
            }
        )
        deadline = self._clock() + self.timeout

        begin = self._next_control_reply(request_id, "capture", deadline)
        self._raise_device_error(begin)
        if begin.get("state") != "begin":
            raise ProtocolError("first capture response must have state 'begin'")

        width = _integer(begin, "width", minimum=1, maximum=2048)
        height = _integer(begin, "height", minimum=1, maximum=2048)
        expected_bytes = _integer(begin, "bytes", minimum=1, maximum=16_777_216)
        chunk_bytes = _integer(begin, "chunk_bytes", minimum=1, maximum=4096)
        if begin.get("format") != "rgb332":
            raise ProtocolError("device capture format must be 'rgb332'")
        if expected_bytes != width * height:
            raise ProtocolError(
                "RGB332 capture byte count must equal width multiplied by height"
            )

        pixels = bytearray(expected_bytes)
        covered = bytearray(expected_bytes)
        chunks: Dict[int, tuple[int, bytes]] = {}
        received_bytes = 0

        while True:
            message = self._next_control_reply(request_id, "capture", deadline)
            self._raise_device_error(message)
            state = message.get("state")
            if state == "chunk":
                seq = _integer(message, "seq", minimum=0)
                offset = _integer(
                    message, "offset", minimum=0, maximum=expected_bytes - 1
                )
                encoded = message.get("data")
                if not isinstance(encoded, str):
                    raise ProtocolError("capture chunk data must be base64 text")
                try:
                    data = base64.b64decode(encoded, validate=True)
                except (binascii.Error, ValueError) as error:
                    raise ProtocolError("capture chunk contains invalid base64") from error
                if not data or len(data) > chunk_bytes:
                    raise ProtocolError("capture chunk has an invalid decoded length")
                if offset != seq * chunk_bytes:
                    raise ProtocolError("capture chunk offset does not match its sequence")
                end = offset + len(data)
                if end > expected_bytes:
                    raise ProtocolError("capture chunk extends past the framebuffer")

                previous = chunks.get(seq)
                if previous is not None:
                    if previous != (offset, data):
                        raise ProtocolError("capture repeated a sequence with new data")
                    continue
                if any(covered[offset:end]):
                    raise ProtocolError("capture chunks overlap")
                chunks[seq] = (offset, data)
                pixels[offset:end] = data
                covered[offset:end] = b"\x01" * len(data)
                received_bytes += len(data)
                continue

            if state != "end":
                raise ProtocolError(f"unexpected capture state {state!r}")

            reported_chunks = _integer(message, "chunks", minimum=0)
            reported_bytes = _integer(message, "bytes", minimum=0)
            reported_crc = _decode_crc32(message.get("crc32"))
            if reported_chunks != len(chunks):
                raise ProtocolError("capture end reported the wrong chunk count")
            if reported_bytes != expected_bytes or received_bytes != expected_bytes:
                raise ProtocolError("capture ended before every framebuffer byte arrived")
            if sorted(chunks) != list(range(len(chunks))):
                raise ProtocolError("capture chunk sequence is not contiguous")
            if not all(covered):
                raise ProtocolError("capture contains gaps")

            computed_crc = f"{zlib.crc32(pixels) & 0xFFFFFFFF:08x}"
            if reported_crc != computed_crc:
                raise ProtocolError(
                    f"capture CRC32 mismatch: device={reported_crc}, "
                    f"host={computed_crc}"
                )
            return Capture(
                width=width,
                height=height,
                pixels=bytes(pixels),
                crc32=computed_crc,
                chunks=len(chunks),
            )


def rgb332_to_rgb888(pixels: bytes) -> bytes:
    """Expand packed RGB332 pixels to 24-bit RGB."""

    rgb = bytearray(len(pixels) * 3)
    output = 0
    for value in pixels:
        red = (value >> 5) & 0x07
        green = (value >> 2) & 0x07
        blue = value & 0x03
        red5 = (red << 2) | (red >> 1)
        green6 = (green << 3) | green
        blue5 = (0, 11, 21, 31)[blue]
        rgb[output] = (red5 << 3) | (red5 >> 2)
        rgb[output + 1] = (green6 << 2) | (green6 >> 4)
        rgb[output + 2] = (blue5 << 3) | (blue5 >> 2)
        output += 3
    return bytes(rgb)


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    checksum = zlib.crc32(kind)
    checksum = zlib.crc32(payload, checksum) & 0xFFFFFFFF
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", checksum)
    )


def encode_png_rgb(width: int, height: int, rgb: bytes) -> bytes:
    """Encode unfiltered 24-bit RGB data as a dependency-free PNG."""

    if width <= 0 or height <= 0:
        raise ValueError("PNG dimensions must be positive")
    row_bytes = width * 3
    if len(rgb) != row_bytes * height:
        raise ValueError("RGB byte count does not match PNG dimensions")

    scanlines = bytearray((row_bytes + 1) * height)
    source = 0
    target = 0
    for _ in range(height):
        scanlines[target] = 0
        target += 1
        scanlines[target : target + row_bytes] = rgb[source : source + row_bytes]
        source += row_bytes
        target += row_bytes

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(scanlines, level=9))
        + _png_chunk(b"IEND", b"")
    )


def save_capture_png(capture: Capture, output: Path) -> Path:
    """Convert a capture to RGB and atomically replace its output PNG."""

    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    encoded = encode_png_rgb(
        capture.width, capture.height, rgb332_to_rgb888(capture.pixels)
    )
    temporary = output.with_name(f".{output.name}.{secrets.token_hex(4)}.tmp")
    try:
        temporary.write_bytes(encoded)
        temporary.replace(output)
    finally:
        if temporary.exists():
            temporary.unlink()
    return output


def capture_gallery(
    controller: DeviceController,
    output_directory: Path,
    *,
    sleeper: Callable[[float], None] = time.sleep,
) -> list[Path]:
    """Navigate the core UI and capture five screens over one serial session."""

    output_directory = output_directory.expanduser().resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    outputs = []

    def capture_named(filename: str) -> None:
        outputs.append(
            save_capture_png(controller.capture(), output_directory / filename)
        )

    capture_named("01-home.png")
    controller.button("A", "tap")
    sleeper(0.5)
    capture_named("02-pet.png")
    controller.button("A", "tap")
    sleeper(0.5)
    capture_named("03-info.png")
    controller.button("B", "hold", duration_ms=800)
    sleeper(1.0)
    capture_named("04-menu.png")
    controller.button("B", "tap")
    sleeper(0.5)
    capture_named("05-settings.png")
    return outputs


def open_serial(port: str, baud: int, timeout: float) -> Any:
    """Open serial with control lines low to avoid an intentional reset pulse."""

    try:
        import serial
    except ImportError as error:
        raise DeviceControlError(
            "pyserial is required; install firmware/m5stickc-plus/tools/requirements.txt"
        ) from error

    device = serial.Serial()
    device.port = port
    device.baudrate = baud
    device.timeout = min(0.25, timeout)
    device.write_timeout = min(3.0, timeout)
    device.rtscts = False
    device.dsrdtr = False
    device.dtr = False
    device.rts = False
    device.exclusive = True
    device.open()
    return device


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Inspect, press buttons on, and capture the screen of one "
            "USB-connected M5StickC Plus."
        )
    )
    parser.add_argument(
        "--port",
        help=(
            "exact /dev/cu.usbserial-* path; omitted only when exactly one "
            "matching device is connected"
        ),
    )
    parser.add_argument("--baud", type=int, default=DEFAULT_BAUD)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument(
        "--open-delay",
        type=float,
        default=DEFAULT_OPEN_DELAY,
        help=(
            "seconds to let the Stick reboot after serial open "
            f"(default: {DEFAULT_OPEN_DELAY})"
        ),
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="print device, Wi-Fi, battery, and pet status")

    for action in ("tap", "press", "release"):
        command = commands.add_parser(action, help=f"{action} synthetic button A or B")
        command.add_argument("button", type=str.upper, choices=sorted(BUTTONS))

    hold = commands.add_parser("hold", help="hold synthetic button A or B")
    hold.add_argument("button", type=str.upper, choices=sorted(BUTTONS))
    hold.add_argument(
        "--duration-ms",
        type=int,
        default=1200,
        help="hold duration in milliseconds (default: 1200)",
    )

    screenshot = commands.add_parser(
        "screenshot", help="capture the displayed framebuffer as a PNG"
    )
    screenshot.add_argument("output", type=Path)
    gallery = commands.add_parser(
        "gallery",
        help=(
            "navigate and capture home, pet, info, menu, and settings "
            "in one USB session"
        ),
    )
    gallery.add_argument("output_directory", type=Path)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.baud <= 0:
        raise DeviceControlError("--baud must be positive")
    if args.timeout <= 0:
        raise DeviceControlError("--timeout must be positive")
    if args.open_delay < 0:
        raise DeviceControlError("--open-delay cannot be negative")

    port = resolve_port(args.port)
    device = open_serial(port, args.baud, args.timeout)
    try:
        if args.open_delay:
            time.sleep(args.open_delay)
        device.reset_input_buffer()
        controller = DeviceController(device, timeout=args.timeout)

        if args.command == "status":
            print(json.dumps(controller.status(), indent=2, sort_keys=True))
            return 0
        if args.command in ("tap", "press", "release"):
            controller.button(args.button, args.command)
            print(f"{args.button} {args.command} accepted by {port}")
            return 0
        if args.command == "hold":
            controller.button(
                args.button, "hold", duration_ms=args.duration_ms
            )
            print(
                f"{args.button} hold ({args.duration_ms} ms) accepted by {port}"
            )
            return 0
        if args.command == "screenshot":
            capture = controller.capture()
            output = save_capture_png(capture, args.output)
            print(
                f"captured {capture.width}x{capture.height} RGB332 screen "
                f"to {output} (CRC32 {capture.crc32})"
            )
            return 0
        if args.command == "gallery":
            outputs = capture_gallery(controller, args.output_directory)
            print(f"captured UI gallery from {port}:")
            for output in outputs:
                print(f"  {output}")
            return 0
        raise DeviceControlError(f"unsupported command {args.command!r}")
    finally:
        device.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (DeviceControlError, OSError) as error:
        print(f"device_control: {error}", file=sys.stderr)
        raise SystemExit(1) from error
