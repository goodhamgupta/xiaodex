#!/usr/bin/env python3
"""Offline tests for the USB M5StickC Plus controller."""

import base64
import contextlib
import io
import json
import struct
import sys
import tempfile
import unittest
import zlib
from collections import deque
from pathlib import Path


TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import device_control


class FakeSerial:
    def __init__(self, handler):
        self.handler = handler
        self.lines = deque()
        self.writes = []
        self.flushes = 0

    def write(self, payload):
        self.writes.append(payload)
        request = json.loads(payload.decode("utf-8"))
        for line in self.handler(request):
            if isinstance(line, dict):
                line = json.dumps(line).encode("utf-8")
            if isinstance(line, str):
                line = line.encode("utf-8")
            if not line.endswith(b"\n"):
                line += b"\n"
            self.lines.append(line)
        return len(payload)

    def flush(self):
        self.flushes += 1

    def readline(self):
        return self.lines.popleft() if self.lines else b""


def control_reply(request, state, **fields):
    return {
        "ack": "device_control",
        "v": 1,
        "id": request["id"],
        "op": request["op"],
        "state": state,
        **fields,
    }


def parse_png(payload):
    if not payload.startswith(b"\x89PNG\r\n\x1a\n"):
        raise AssertionError("missing PNG signature")
    offset = 8
    chunks = []
    while offset < len(payload):
        size = struct.unpack(">I", payload[offset : offset + 4])[0]
        kind = payload[offset + 4 : offset + 8]
        data = payload[offset + 8 : offset + 8 + size]
        expected_crc = struct.unpack(
            ">I", payload[offset + 8 + size : offset + 12 + size]
        )[0]
        actual_crc = zlib.crc32(kind)
        actual_crc = zlib.crc32(data, actual_crc) & 0xFFFFFFFF
        if expected_crc != actual_crc:
            raise AssertionError(f"bad {kind!r} chunk CRC")
        chunks.append((kind, data))
        offset += 12 + size
    return chunks


class PortSelectionTests(unittest.TestCase):
    def test_explicit_usb_serial_port_wins(self):
        self.assertEqual(
            device_control.resolve_port(
                "/dev/cu.usbserial-ABC_12",
                globber=lambda _pattern: ["/dev/cu.usbserial-OTHER"],
            ),
            "/dev/cu.usbserial-ABC_12",
        )

    def test_rejects_non_usbserial_explicit_port(self):
        with self.assertRaises(device_control.PortSelectionError):
            device_control.resolve_port("/dev/cu.Bluetooth-Incoming-Port")

    def test_discovers_exactly_one_port(self):
        self.assertEqual(
            device_control.resolve_port(
                None, globber=lambda _pattern: ["/dev/cu.usbserial-M5"]
            ),
            "/dev/cu.usbserial-M5",
        )

    def test_refuses_zero_or_multiple_discovered_ports(self):
        with self.assertRaisesRegex(
            device_control.PortSelectionError, "no /dev/cu.usbserial"
        ):
            device_control.resolve_port(None, globber=lambda _pattern: [])
        with self.assertRaisesRegex(
            device_control.PortSelectionError, "multiple USB serial"
        ):
            device_control.resolve_port(
                None,
                globber=lambda _pattern: [
                    "/dev/cu.usbserial-TWO",
                    "/dev/cu.usbserial-ONE",
                ],
            )


class ControllerTests(unittest.TestCase):
    def test_status_uses_legacy_command_and_ignores_logs(self):
        status = {"name": "Xiaodex", "wifi": {"connected": True}}

        def handler(request):
            self.assertEqual(request, {"cmd": "status"})
            return [
                b"[wifi] ping\n",
                b"{not json}\n",
                {"ack": "other", "ok": True},
                {"ack": "status", "ok": True, "data": status},
            ]

        fake = FakeSerial(handler)
        controller = device_control.DeviceController(fake, timeout=0.1)
        self.assertEqual(controller.status(), status)
        self.assertEqual(fake.flushes, 1)

    def test_button_request_has_version_id_and_hold_duration(self):
        def handler(request):
            self.assertEqual(
                request,
                {
                    "cmd": "device_control",
                    "v": 1,
                    "id": "request-42",
                    "op": "button",
                    "button": "A",
                    "action": "hold",
                    "duration_ms": 875,
                },
            )
            return [
                "unrelated log line",
                {
                    "ack": "device_control",
                    "v": 1,
                    "id": "old-request",
                    "op": "button",
                    "state": "accepted",
                },
                control_reply(request, "accepted"),
            ]

        fake = FakeSerial(handler)
        controller = device_control.DeviceController(
            fake, timeout=0.1, request_id_factory=lambda: "request-42"
        )
        reply = controller.button("a", "hold", duration_ms=875)
        self.assertEqual(reply["state"], "accepted")

    def test_device_button_error_is_reported(self):
        fake = FakeSerial(
            lambda request: [
                control_reply(request, "error", error="button queue is full")
            ]
        )
        controller = device_control.DeviceController(
            fake, timeout=0.1, request_id_factory=lambda: "bad-button"
        )
        with self.assertRaisesRegex(device_control.ProtocolError, "queue is full"):
            controller.button("B", "tap")

    def test_capture_reassembles_chunks_around_logs_and_validates_crc(self):
        pixels = bytes((0xE0, 0x1C, 0x03))
        checksum = f"{zlib.crc32(pixels) & 0xFFFFFFFF:08x}"

        def handler(request):
            self.assertEqual(
                request,
                {
                    "cmd": "device_control",
                    "v": 1,
                    "id": "capture-1",
                    "op": "capture",
                },
            )
            return [
                "[voice] worker idle",
                control_reply(
                    request,
                    "begin",
                    width=3,
                    height=1,
                    format="rgb332",
                    bytes=3,
                    chunk_bytes=2,
                ),
                b"\xffnot utf8",
                control_reply(
                    request,
                    "chunk",
                    seq=0,
                    offset=0,
                    data=base64.b64encode(pixels[:2]).decode("ascii"),
                ),
                {"ack": "status", "ok": True, "data": {}},
                control_reply(
                    request,
                    "chunk",
                    seq=1,
                    offset=2,
                    data=base64.b64encode(pixels[2:]).decode("ascii"),
                ),
                control_reply(
                    request,
                    "end",
                    chunks=2,
                    bytes=3,
                    crc32=checksum.upper(),
                ),
            ]

        fake = FakeSerial(handler)
        controller = device_control.DeviceController(
            fake, timeout=0.1, request_id_factory=lambda: "capture-1"
        )
        capture = controller.capture()
        self.assertEqual((capture.width, capture.height), (3, 1))
        self.assertEqual(capture.pixels, pixels)
        self.assertEqual(capture.crc32, checksum)
        self.assertEqual(capture.chunks, 2)

    def test_capture_rejects_crc_mismatch(self):
        pixels = b"\x00"

        def handler(request):
            return [
                control_reply(
                    request,
                    "begin",
                    width=1,
                    height=1,
                    format="rgb332",
                    bytes=1,
                    chunk_bytes=1,
                ),
                control_reply(
                    request,
                    "chunk",
                    seq=0,
                    offset=0,
                    data=base64.b64encode(pixels).decode("ascii"),
                ),
                control_reply(
                    request,
                    "end",
                    chunks=1,
                    bytes=1,
                    crc32="12345678",
                ),
            ]

        controller = device_control.DeviceController(
            FakeSerial(handler),
            timeout=0.1,
            request_id_factory=lambda: "capture-bad-crc",
        )
        with self.assertRaisesRegex(device_control.ProtocolError, "CRC32 mismatch"):
            controller.capture()

    def test_capture_rejects_gaps(self):
        pixels = b"\x01\x02\x03"

        def handler(request):
            return [
                control_reply(
                    request,
                    "begin",
                    width=3,
                    height=1,
                    format="rgb332",
                    bytes=3,
                    chunk_bytes=2,
                ),
                control_reply(
                    request,
                    "chunk",
                    seq=0,
                    offset=0,
                    data=base64.b64encode(pixels[:1]).decode("ascii"),
                ),
                control_reply(
                    request,
                    "chunk",
                    seq=1,
                    offset=2,
                    data=base64.b64encode(pixels[2:]).decode("ascii"),
                ),
                control_reply(
                    request,
                    "end",
                    chunks=2,
                    bytes=3,
                    crc32=f"{zlib.crc32(pixels) & 0xFFFFFFFF:08x}",
                ),
            ]

        controller = device_control.DeviceController(
            FakeSerial(handler),
            timeout=0.1,
            request_id_factory=lambda: "capture-gap",
        )
        with self.assertRaisesRegex(device_control.ProtocolError, "before every"):
            controller.capture()

    def test_rgb332_and_png_encoding(self):
        rgb = device_control.rgb332_to_rgb888(bytes((0xE0, 0x1C, 0x03, 0x25)))
        self.assertEqual(
            rgb,
            bytes(
                (
                    255,
                    0,
                    0,
                    0,
                    255,
                    0,
                    0,
                    0,
                    255,
                    33,
                    36,
                    90,
                )
            ),
        )

        png = device_control.encode_png_rgb(4, 1, rgb)
        chunks = parse_png(png)
        self.assertEqual([kind for kind, _ in chunks], [b"IHDR", b"IDAT", b"IEND"])
        width, height, depth, color, compression, filtering, interlace = (
            struct.unpack(">IIBBBBB", chunks[0][1])
        )
        self.assertEqual(
            (width, height, depth, color, compression, filtering, interlace),
            (4, 1, 8, 2, 0, 0, 0),
        )
        scanlines = zlib.decompress(chunks[1][1])
        self.assertEqual(scanlines, b"\x00" + rgb)


class ArgumentTests(unittest.TestCase):
    def test_button_is_case_insensitive(self):
        args = device_control.build_parser().parse_args(["tap", "b"])
        self.assertEqual((args.command, args.button), ("tap", "B"))

    def test_screenshot_requires_output(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                device_control.build_parser().parse_args(["screenshot"])

    def test_gallery_and_reboot_delay_defaults(self):
        args = device_control.build_parser().parse_args(["gallery", "captures"])
        self.assertEqual(args.command, "gallery")
        self.assertEqual(args.output_directory, Path("captures"))
        self.assertEqual(args.open_delay, 2.2)


class GalleryTests(unittest.TestCase):
    def test_gallery_navigates_and_writes_five_pngs_in_one_session(self):
        class FakeController:
            def __init__(self):
                self.actions = []
                self.capture_count = 0

            def capture(self):
                self.capture_count += 1
                self.actions.append(("capture", self.capture_count))
                return device_control.Capture(
                    width=1,
                    height=1,
                    pixels=bytes((self.capture_count,)),
                    crc32=f"{zlib.crc32(bytes((self.capture_count,))) & 0xFFFFFFFF:08x}",
                    chunks=1,
                )

            def button(self, button, action, *, duration_ms=None):
                self.actions.append(("button", button, action, duration_ms))
                return {"state": "accepted"}

        controller = FakeController()
        sleeps = []
        with tempfile.TemporaryDirectory() as directory:
            outputs = device_control.capture_gallery(
                controller, Path(directory), sleeper=sleeps.append
            )
            self.assertEqual(
                [path.name for path in outputs],
                [
                    "01-home.png",
                    "02-pet.png",
                    "03-info.png",
                    "04-menu.png",
                    "05-settings.png",
                ],
            )
            for output in outputs:
                self.assertTrue(output.is_file())
                self.assertTrue(output.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))

        self.assertEqual(
            controller.actions,
            [
                ("capture", 1),
                ("button", "A", "tap", None),
                ("capture", 2),
                ("button", "A", "tap", None),
                ("capture", 3),
                ("button", "B", "hold", 800),
                ("capture", 4),
                ("button", "B", "tap", None),
                ("capture", 5),
            ],
        )
        self.assertEqual(sleeps, [0.5, 0.5, 1.0, 0.5])


if __name__ == "__main__":
    unittest.main()
