#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Original dependency-free Xiaodex implementation of the documented GBADoom
# map-lump transformations. No GbaWadUtil source or binary is vendored; see
# PROVENANCE.md for format references and compatibility validation.
import argparse
import struct
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Lump:
    name: str
    data: bytes


def read_wad(path: Path) -> list[Lump]:
    raw = path.read_bytes()
    ident, count, directory = struct.unpack_from("<4sii", raw, 0)
    if ident not in (b"IWAD", b"PWAD"):
        raise ValueError(f"{path}: not a WAD")
    lumps = []
    for i in range(count):
        pos, size, name = struct.unpack_from("<ii8s", raw, directory + i * 16)
        lumps.append(Lump(name.rstrip(b"\0").decode("latin1"), raw[pos:pos + size]))
    return lumps


def find(lumps: list[Lump], name: str) -> int:
    wanted = name.upper()
    for i in range(len(lumps) - 1, -1, -1):
        if lumps[i].name.upper() == wanted:
            return i
    return -1


def texture_names(blob: bytes) -> list[str]:
    if not blob:
        return []
    count = struct.unpack_from("<i", blob, 0)[0]
    offsets = struct.unpack_from(f"<{count}i", blob, 4)
    return [blob[o:o + 8].rstrip(b"\0").decode("latin1").upper() for o in offsets]


def process(lumps: list[Lump]) -> None:
    textures = []
    for lump_name in ("TEXTURE1", "TEXTURE2"):
        idx = find(lumps, lump_name)
        if idx >= 0:
            textures.extend(texture_names(lumps[idx].data))
    texture_to_num = {name: i for i, name in enumerate(textures)}

    for episode in range(1, 5):
        for mission in range(1, 10):
            marker = find(lumps, f"E{episode}M{mission}")
            if marker < 0:
                continue
            # Doom map lump order: marker, THINGS, LINEDEFS, SIDEDEFS,
            # VERTEXES, SEGS, SSECTORS, NODES, SECTORS, REJECT, BLOCKMAP.
            line_i, side_i, vertex_i, seg_i = marker + 2, marker + 3, marker + 4, marker + 5

            raw_vertices = lumps[vertex_i].data
            vertices = [struct.unpack_from("<hh", raw_vertices, o)
                        for o in range(0, len(raw_vertices), 4)]
            fixed_vertices = [(x << 16, y << 16) for x, y in vertices]
            lumps[vertex_i].data = b"".join(struct.pack("<ii", x, y)
                                            for x, y in fixed_vertices)

            raw_lines = lumps[line_i].data
            lines = []
            packed_lines = []
            for lineno, off in enumerate(range(0, len(raw_lines), 14)):
                v1i, v2i, flags, special, tag, side0, side1 = struct.unpack_from(
                    "<HHHhhHH", raw_lines, off)
                v1x, v1y = fixed_vertices[v1i]
                v2x, v2y = fixed_vertices[v2i]
                dx, dy = v2x - v1x, v2y - v1y
                if dx == 0:
                    slope = 1  # ST_VERTICAL
                elif dy == 0:
                    slope = 0  # ST_HORIZONTAL
                elif (dx > 0) == (dy > 0):
                    slope = 2  # ST_POSITIVE
                else:
                    slope = 3  # ST_NEGATIVE
                bbox = (max(v1y, v2y), min(v1y, v2y), min(v1x, v2x), max(v1x, v2x))
                packed_lines.append(struct.pack(
                    "<iiiiIiiHHiiiiHhhH",
                    v1x, v1y, v2x, v2y, lineno, dx, dy, side0, side1,
                    *bbox, flags, special, tag, slope))
                lines.append((side0, side1, flags))
            lumps[line_i].data = b"".join(packed_lines)

            raw_sides = lumps[side_i].data
            raw_side_records = []
            packed_sides = []
            for off in range(0, len(raw_sides), 30):
                tx, row, top, bottom, middle, sector = struct.unpack_from(
                    "<hh8s8s8sh", raw_sides, off)
                names = [n.rstrip(b"\0").decode("latin1").upper()
                         for n in (top, bottom, middle)]
                nums = [texture_to_num.get(n, 0) for n in names]
                packed_sides.append(struct.pack("<hhhhhh", tx, row, *nums, sector))
                raw_side_records.append(sector)

            raw_segs = lumps[seg_i].data
            packed_segs = []
            for off in range(0, len(raw_segs), 12):
                v1i, v2i, angle, linedef_i, side, offset = struct.unpack_from(
                    "<HHhHhh", raw_segs, off)
                v1x, v1y = fixed_vertices[v1i]
                v2x, v2y = fixed_vertices[v2i]
                side0, side1, flags = lines[linedef_i]
                sidenum = (side0, side1)[side]
                front = raw_side_records[sidenum] if sidenum != 0xFFFF else 0xFFFF
                opposite = (side0, side1)[side ^ 1]
                back = (raw_side_records[opposite]
                        if (flags & 4) and opposite != 0xFFFF else 0xFFFF)
                packed_segs.append(struct.pack(
                    "<iiiiiIHHHH", v1x, v1y, v2x, v2y,
                    offset << 16, (angle << 16) & 0xFFFFFFFF,
                    sidenum, linedef_i, front, back))
            lumps[seg_i].data = b"".join(packed_segs)
            lumps[side_i].data = b"".join(packed_sides)

    pnames_i = find(lumps, "PNAMES")
    if pnames_i >= 0:
        data = bytearray(lumps[pnames_i].data)
        count = struct.unpack_from("<I", data, 0)[0]
        for i in range(count):
            start = 4 + i * 8
            data[start:start + 8] = bytes(data[start:start + 8]).upper()
        lumps[pnames_i].data = bytes(data)


def write_wad(path: Path, lumps: list[Lump]) -> None:
    directory_size = 12 + 16 * len(lumps)
    data_start = (directory_size + 3) & ~3
    directory = bytearray()
    payload = bytearray(b"\0" * (data_start - directory_size))
    offset = data_start
    for lump in lumps:
        encoded = lump.name.upper().encode("latin1")[:8].ljust(8, b"\0")
        directory += struct.pack("<ii8s", offset if lump.data else 0, len(lump.data), encoded)
        payload += lump.data
        offset += len(lump.data)
        pad = (-offset) & 3
        payload += b"\0" * pad
        offset += pad
    path.write_bytes(struct.pack("<4sii", b"IWAD", len(lumps), 12) + directory + payload)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("source", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument("--gbadoom", type=Path, required=True)
    args = p.parse_args()
    lumps = read_wad(args.source)
    lumps.extend(read_wad(args.gbadoom))
    process(lumps)
    write_wad(args.output, lumps)
    print(f"{args.output}: {args.output.stat().st_size} bytes, {len(lumps)} lumps")


if __name__ == "__main__":
    main()
