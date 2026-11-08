#!/usr/bin/env python3
"""Trim converted Doom shareware without changing gameplay art."""

from __future__ import annotations

import struct
from pathlib import Path

from convert_gba_wad import Lump


STUB_BLACK = frozenset(("HELP1", "HELP2", "CREDIT", "WIMAP0"))


def black_patch() -> bytes:
    """Return a compact 320x200 solid-black Doom patch."""

    column_offset = 8 + 320 * 4
    header = struct.pack("<hhhh", 320, 200, 0, 0)
    offsets = struct.pack("<I", column_offset) * 320
    shared_column = b"\0" + bytes((200, 0)) + bytes(200) + b"\0\xff"
    return header + offsets + shared_column


def trim_shareware(lumps: list[Lump]) -> tuple[list[Lump], dict[str, int]]:
    """Remove unused audio/demos while preserving all original game visuals."""

    trimmed: list[Lump] = []
    removed = 0
    stubbed = 0
    placeholder = black_patch()
    for lump in lumps:
        name = lump.name.upper()
        if name.startswith(("DS", "DP", "DEMO")) or name in ("GENMIDI", "DMXGUS"):
            removed += 1
            continue
        if name.startswith("D_"):
            trimmed.append(Lump(lump.name, b""))
            continue
        if name in STUB_BLACK:
            trimmed.append(Lump(lump.name, placeholder))
            stubbed += 1
            continue
        trimmed.append(lump)
    return trimmed, {"removed": removed, "stubbed": stubbed}


def write_trimmed_wad(path: Path, lumps: list[Lump]) -> None:
    """Write an aligned payload-first IWAD matching the validated trim format."""

    payload_size = sum((len(lump.data) + 3) & ~3 for lump in lumps)
    directory_offset = 12 + payload_size
    payload = bytearray()
    directory = bytearray()
    position = 12
    for lump in lumps:
        name = lump.name.upper().encode("latin1")[:8].ljust(8, b"\0")
        directory += struct.pack("<II8s", position, len(lump.data), name)
        payload += lump.data
        padding = (-len(lump.data)) & 3
        payload += b"\0" * padding
        position += len(lump.data) + padding
    path.write_bytes(
        struct.pack("<4sII", b"IWAD", len(lumps), directory_offset)
        + payload
        + directory
    )
