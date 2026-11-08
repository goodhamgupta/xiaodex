#!/usr/bin/env python3
"""Build a silent Doom shareware WAD with original gameplay art for GBADoom."""

from __future__ import annotations

import hashlib
import sys
import tempfile
import urllib.request
from pathlib import Path

from convert_gba_wad import process, read_wad
from trim_shareware import trim_shareware, write_trimmed_wad


OUTPUT_SHA256 = "1f75ddb561dfb71662804e2e649c63cee7f03fbabdc2c914ae6c79b8f02d7f1e"
GBADOOM_URL = (
    "https://raw.githubusercontent.com/doomhack/GbaWadUtil/"
    "4ea9f48e9b13d39c0a9c383fd4d8ae5bda5ebcf6/gbadoom.wad"
)
GBADOOM_SHA256 = "3e67a42b2eb4630bbebe773de309b8404e75bb558e9ce39915d707025195c549"
ORIGINAL_URL = (
    "https://raw.githubusercontent.com/Spritetm/esp32c3-doom-bauble/"
    "b7a005313dc0a1fa20b334efd4237a9fd7780413/"
    "esp32c3-doom/GbaWadUtil/doom1.wad"
)
ORIGINAL_SHA256 = "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def download(url: str, expected_sha256: str, label: str) -> bytes:
    print(f"Downloading {label} from {url}")
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read()
    actual = digest(data)
    if actual != expected_sha256:
        raise RuntimeError(f"{label} SHA-256 mismatch: {actual}")
    return data


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    output = root / "data" / "doom1gba.wad"
    output.parent.mkdir(parents=True, exist_ok=True)

    gbadoom_data = download(GBADOOM_URL, GBADOOM_SHA256, "GBADoom compatibility PWAD")
    original_data = download(ORIGINAL_URL, ORIGINAL_SHA256, "Doom shareware 1.9 IWAD")

    # Work in a temporary sibling directory and replace the flashable output
    # only after every input/output digest passes. An interruption or corrupt
    # download therefore cannot leave a bad WAD at the path used by upload.
    with tempfile.TemporaryDirectory(prefix=".wad-build-", dir=output.parent) as tmp:
        tmpdir = Path(tmp)
        original_path = tmpdir / "doom1.wad"
        gbadoom_path = tmpdir / "gbadoom.wad"
        candidate = tmpdir / "doom1gba.wad"
        original_path.write_bytes(original_data)
        gbadoom_path.write_bytes(gbadoom_data)
        lumps = read_wad(original_path)
        lumps.extend(read_wad(gbadoom_path))
        process(lumps)
        trimmed, stats = trim_shareware(lumps)
        write_trimmed_wad(candidate, trimmed)
        actual = digest(candidate.read_bytes())
        if actual != OUTPUT_SHA256:
            raise RuntimeError(f"converted WAD SHA-256 mismatch: {actual}")
        candidate.replace(output)
    print(
        f"Prepared {output} ({output.stat().st_size:,} bytes, original "
        f"E1M1-E1M9 gameplay maps/assets; removed {stats['removed']} silent lumps, "
        f"stubbed {stats['stubbed']} full-screen patches)"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"prepare_wad: {error}", file=sys.stderr)
        raise SystemExit(1) from error
