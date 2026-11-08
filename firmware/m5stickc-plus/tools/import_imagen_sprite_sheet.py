#!/usr/bin/env python3
"""
Import an Imagen-generated Codex pet sprite sheet for M5StickC Plus.

The source sheet is expected to be 4 columns x 7 rows. Each row becomes one
animated GIF state in characters/<name>/:

  sleep, idle, busy, attention, celebrate, dizzy, heart

Usage:
  python3 tools/import_imagen_sprite_sheet.py ../../assets/imagen/codex-spark/sprite-sheet.png
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
from collections import deque
from pathlib import Path

from PIL import Image


STATES = ["sleep", "idle", "busy", "attention", "celebrate", "dizzy", "heart"]
DURATIONS = {
    "sleep": 420,
    "idle": 260,
    "busy": 150,
    "attention": 180,
    "celebrate": 160,
    "dizzy": 130,
    "heart": 220,
}
DEFAULT_COLORS = {
    "body": "#2EE6E6",
    "bg": "#000000",
    "text": "#F8F8F8",
    "textDim": "#B6B6B6",
    "ink": "#000000",
}
PACK_BODY_COLORS = {
    "codex-spark": "#D8FF00",
    "codex-cat": "#FFA62B",
    "codex-axolotl": "#FF8FB8",
}
PROJECT = Path(__file__).resolve().parent.parent
REPO_ROOT = PROJECT.parent.parent
CHAR_ROOT = PROJECT / "characters"
DATA_ROOT = PROJECT / "data" / "characters"
CELL = 96
COLS = 4
ROWS = len(STATES)
OUTPUT_MARGIN = 4


class SpriteSheetError(ValueError):
    """Raised when a generated sheet cannot produce safe device sprites."""


def colors_for_pack(name: str) -> dict[str, str]:
    colors = DEFAULT_COLORS.copy()
    colors["body"] = PACK_BODY_COLORS.get(name, colors["body"])
    return colors


def source_path_for_manifest(source: Path) -> str:
    """Return a POSIX path interpreted relative to the repository root."""
    return Path(os.path.relpath(source.resolve(), REPO_ROOT)).as_posix()


def validate_sheet_dimensions(sheet: Image.Image) -> int:
    """Validate an exact 4x7 grid of square cells and return the cell size."""
    width, height = sheet.size
    if width <= 0 or height <= 0:
        raise SpriteSheetError("sprite sheet must have positive dimensions")
    if width % COLS != 0 or height % ROWS != 0:
        raise SpriteSheetError(
            f"sprite sheet must divide exactly into {COLS} columns x {ROWS} rows; "
            f"got {width}x{height}"
        )

    cell_width = width // COLS
    cell_height = height // ROWS
    if cell_width != cell_height:
        raise SpriteSheetError(
            f"sprite sheet cells must be square; got {cell_width}x{cell_height} "
            f"from {width}x{height}"
        )
    return cell_width


def is_generated_background(pixel: tuple[int, int, int, int]) -> bool:
    r, g, b, a = pixel
    if a == 0:
        return True
    # Imagen often renders a visible transparency checkerboard into RGB output.
    # Treat only edge-connected light neutral pixels as background so the white
    # body shell stays intact behind its dark outline.
    return r >= 165 and g >= 165 and b >= 165 and max(r, g, b) - min(r, g, b) <= 38


def strip_edge_background(image: Image.Image) -> Image.Image:
    src = image.convert("RGBA")
    w, h = src.size
    px = src.load()
    clear: set[tuple[int, int]] = set()
    q: deque[tuple[int, int]] = deque()

    for x in range(w):
        q.append((x, 0))
        q.append((x, h - 1))
    for y in range(h):
        q.append((0, y))
        q.append((w - 1, y))

    while q:
        x, y = q.popleft()
        if (x, y) in clear:
            continue
        if not is_generated_background(px[x, y]):
            continue
        clear.add((x, y))
        if x > 0:
            q.append((x - 1, y))
        if x + 1 < w:
            q.append((x + 1, y))
        if y > 0:
            q.append((x, y - 1))
        if y + 1 < h:
            q.append((x, y + 1))

    out = src.copy()
    opx = out.load()
    for x, y in clear:
        r, g, b, _ = opx[x, y]
        opx[x, y] = (r, g, b, 0)
    return out


def union(a: tuple[int, int, int, int] | None, b: tuple[int, int, int, int] | None):
    if a is None:
        return b
    if b is None:
        return a
    return min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])


def padded_bbox(bbox: tuple[int, int, int, int], w: int, h: int, pad: int = 4):
    return (
        max(0, bbox[0] - pad),
        max(0, bbox[1] - pad),
        min(w, bbox[2] + pad),
        min(h, bbox[3] + pad),
    )


def validate_normalized_frame(canvas: Image.Image, margin: int = OUTPUT_MARGIN) -> tuple[int, int, int, int]:
    """Reject empty sprites or sprites that violate the safe output margin."""
    alpha_bbox = canvas.getchannel("A").getbbox()
    if alpha_bbox is None:
        raise SpriteSheetError("normalized frame is empty")

    left, top, right, bottom = alpha_bbox
    if (
        left < margin
        or top < margin
        or right > canvas.width - margin
        or bottom > canvas.height - margin
    ):
        raise SpriteSheetError(
            "normalized frame touches the output edge "
            f"(content {alpha_bbox}, required margin {margin}px)"
        )
    return alpha_bbox


def normalize_frame(
    frame: Image.Image,
    bbox: tuple[int, int, int, int],
    bg_rgb: tuple[int, int, int],
) -> Image.Image:
    cropped = frame.crop(bbox)
    if cropped.getbbox() is None:
        raise SpriteSheetError("normalized frame is empty")

    content_size = CELL - (OUTPUT_MARGIN * 2)
    scale = min(content_size / cropped.width, content_size / cropped.height)
    resized = cropped.resize(
        (max(1, round(cropped.width * scale)), max(1, round(cropped.height * scale))),
        Image.Resampling.NEAREST,
    )
    canvas = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    # Keep animation frames on a common baseline while reserving a safe border.
    position = ((CELL - resized.width) // 2, CELL - OUTPUT_MARGIN - resized.height)
    canvas.alpha_composite(resized, position)
    validate_normalized_frame(canvas)

    flat = Image.new("RGB", (CELL, CELL), bg_rgb)
    flat.paste(canvas, mask=canvas.getchannel("A"))
    return flat.quantize(
        colors=64,
        method=Image.Quantize.MEDIANCUT,
        dither=Image.Dither.NONE,
    )


def split_sheet(sheet: Image.Image) -> dict[str, list[Image.Image]]:
    cell_size = validate_sheet_dimensions(sheet)
    frames: dict[str, list[Image.Image]] = {}
    for row, state in enumerate(STATES):
        state_frames = []
        for col in range(COLS):
            left = col * cell_size
            right = left + cell_size
            top = row * cell_size
            bottom = top + cell_size
            state_frames.append(strip_edge_background(sheet.crop((left, top, right, bottom))))
        frames[state] = state_frames
    return frames


def write_pack(source: Path, out: Path, name: str, stage_data: bool, append_data: bool) -> None:
    source = source.resolve()
    with Image.open(source) as sheet:
        frames = split_sheet(sheet)
        source_cell_size = validate_sheet_dimensions(sheet)

    global_bbox = None
    for state_frames in frames.values():
        for frame in state_frames:
            global_bbox = union(global_bbox, frame.getbbox())
    if global_bbox is None:
        raise SpriteSheetError("no sprite pixels found after background removal")
    global_bbox = padded_bbox(global_bbox, source_cell_size, source_cell_size)

    colors = colors_for_pack(name)
    bg_hex = colors["bg"].lstrip("#")
    bg_rgb = tuple(int(bg_hex[i : i + 2], 16) for i in (0, 2, 4))
    manifest_source = source_path_for_manifest(source)

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    manifest_states = {}
    total = 0
    for state in STATES:
        normalized = []
        for index, frame in enumerate(frames[state]):
            try:
                normalized.append(normalize_frame(frame, global_bbox, bg_rgb))
            except SpriteSheetError as exc:
                raise SpriteSheetError(f"{state} frame {index + 1}: {exc}") from exc
        dst = out / f"{state}.gif"
        normalized[0].save(
            dst,
            save_all=True,
            append_images=normalized[1:],
            duration=DURATIONS[state],
            loop=0,
            optimize=False,
            disposal=1,
        )
        total += dst.stat().st_size
        manifest_states[state] = dst.name

    (out / "manifest.json").write_text(
        json.dumps(
            {
                "name": name,
                "generator": "Codex image generation / Imagen",
                "source": manifest_source,
                "cell": {"width": CELL, "height": CELL},
                "colors": colors,
                "states": manifest_states,
            },
            indent=2,
        )
        + "\n"
    )
    (out / "README.md").write_text(
        f"# {name}\n\n"
        "This character pack was generated from a Codex image generation / Imagen sprite sheet.\n"
        f"Source (from the repository root): `{manifest_source}`\n"
    )

    if stage_data:
        data_dst = DATA_ROOT / name
        if DATA_ROOT.exists() and not append_data:
            shutil.rmtree(DATA_ROOT)
        if data_dst.exists():
            shutil.rmtree(data_dst)
        shutil.copytree(out, data_dst)

    print(f"wrote {name}: {total:,} GIF bytes -> {out}")
    if stage_data:
        print(f"staged LittleFS data -> {DATA_ROOT / name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--name", default="codex-spark")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--no-stage-data", action="store_true")
    parser.add_argument("--append-data", action="store_true")
    args = parser.parse_args()

    out = args.out or (CHAR_ROOT / args.name)
    try:
        write_pack(args.source, out.resolve(), args.name, not args.no_stage_data, args.append_data)
    except SpriteSheetError as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
