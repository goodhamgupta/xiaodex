#!/usr/bin/env python3
"""Offline tests for the Imagen sprite-sheet importer."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageChops


TOOLS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS_DIR))

import import_imagen_sprite_sheet as importer  # noqa: E402


class SheetGeometryTests(unittest.TestCase):
    def test_accepts_exact_four_by_seven_square_grid(self) -> None:
        sheet = Image.new("RGB", (948, 1659))
        self.assertEqual(importer.validate_sheet_dimensions(sheet), 237)

    def test_rejects_dimensions_that_do_not_divide_exactly(self) -> None:
        with self.assertRaisesRegex(importer.SpriteSheetError, "divide exactly"):
            importer.validate_sheet_dimensions(Image.new("RGB", (949, 1659)))

    def test_rejects_non_square_cells(self) -> None:
        with self.assertRaisesRegex(importer.SpriteSheetError, "must be square"):
            importer.validate_sheet_dimensions(Image.new("RGB", (40, 77)))

    def test_split_uses_exact_equal_cells(self) -> None:
        sheet = Image.new("RGB", (40, 70), (240, 240, 240))
        frames = importer.split_sheet(sheet)
        self.assertEqual(list(frames), importer.STATES)
        self.assertTrue(
            all(frame.size == (10, 10) for state in frames.values() for frame in state)
        )


class PaletteTests(unittest.TestCase):
    def test_known_packs_have_distinct_device_palettes(self) -> None:
        expected_bodies = {
            "codex-spark": "#D8FF00",
            "codex-cat": "#FFA62B",
            "codex-axolotl": "#FF8FB8",
        }
        for name, body in expected_bodies.items():
            with self.subTest(name=name):
                colors = importer.colors_for_pack(name)
                self.assertEqual(colors["body"], body)
                self.assertEqual(colors["bg"], "#000000")
                self.assertEqual(colors["text"], "#F8F8F8")
                self.assertEqual(colors["textDim"], "#B6B6B6")

    def test_palette_results_are_independent_copies(self) -> None:
        first = importer.colors_for_pack("codex-spark")
        first["body"] = "#FFFFFF"
        self.assertEqual(importer.colors_for_pack("codex-spark")["body"], "#D8FF00")


class NormalizationTests(unittest.TestCase):
    def test_resize_is_hard_edged_and_keeps_four_pixel_margin(self) -> None:
        frame = Image.new("RGBA", (4, 4), (0, 0, 0, 0))
        pixels = frame.load()
        for y in range(4):
            for x in range(4):
                pixels[x, y] = (255, 0, 0, 255) if x < 2 else (0, 255, 0, 255)

        normalized = importer.normalize_frame(frame, (0, 0, 4, 4), (0, 0, 0)).convert("RGB")
        foreground = ImageChops.difference(normalized, Image.new("RGB", normalized.size))
        self.assertEqual(foreground.getbbox(), (4, 4, 92, 92))

        # Nearest-neighbour scaling plus disabled dithering must not invent colors.
        self.assertLessEqual(set(normalized.getdata()), {(0, 0, 0), (255, 0, 0), (0, 255, 0)})

    def test_empty_normalized_frame_is_rejected(self) -> None:
        empty = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
        with self.assertRaisesRegex(importer.SpriteSheetError, "empty"):
            importer.normalize_frame(empty, (0, 0, 8, 8), (0, 0, 0))

    def test_edge_touching_normalized_frame_is_rejected(self) -> None:
        canvas = Image.new("RGBA", (importer.CELL, importer.CELL), (0, 0, 0, 0))
        canvas.putpixel((0, 20), (255, 255, 255, 255))
        with self.assertRaisesRegex(importer.SpriteSheetError, "touches the output edge"):
            importer.validate_normalized_frame(canvas)


class PackWritingTests(unittest.TestCase):
    def test_manifest_uses_repo_relative_source_and_pack_palette(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "sprite-sheet.png"
            out = root / "pack"
            sheet = Image.new("RGB", (40, 70), (240, 240, 240))

            # One compact, non-background sprite in every 10x10 cell.
            for row in range(7):
                for col in range(4):
                    for y in range(row * 10 + 3, row * 10 + 7):
                        for x in range(col * 10 + 3, col * 10 + 7):
                            sheet.putpixel((x, y), (255, 0, 0))
            sheet.save(source)

            importer.write_pack(
                source,
                out,
                "codex-cat",
                stage_data=False,
                append_data=False,
            )

            manifest = json.loads((out / "manifest.json").read_text())
            self.assertFalse(Path(manifest["source"]).is_absolute())
            self.assertEqual(manifest["colors"]["body"], "#FFA62B")
            self.assertEqual(manifest["colors"]["text"], "#F8F8F8")
            self.assertEqual(manifest["colors"]["textDim"], "#B6B6B6")
            self.assertTrue(all((out / filename).is_file() for filename in manifest["states"].values()))


if __name__ == "__main__":
    unittest.main()
