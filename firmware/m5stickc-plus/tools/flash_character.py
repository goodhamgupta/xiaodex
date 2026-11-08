#!/usr/bin/env python3
"""
Flash a prepped character pack via USB (pio run -t uploadfs).
Faster than the BLE drop target when you're iterating on a character.

Usage:
  python3 tools/flash_character.py characters/codex-spark
  python3 tools/flash_character.py characters/codex-spark characters/another-pack
  python3 tools/flash_character.py --append characters/another-pack
"""
import argparse, json, sys, shutil, subprocess
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
DATA    = PROJECT / "data" / "characters"
CAP     = 1_800_000


def pack_name(src: Path) -> str:
    if not (src / "manifest.json").exists():
        sys.exit(f"no manifest.json in {src} — run tools/prep_character.py first")
    return json.loads((src / "manifest.json").read_text())["name"]


def pack_size(src: Path) -> int:
    return sum(f.stat().st_size for f in src.iterdir() if f.is_file())


def staged_size() -> int:
    if not DATA.exists():
        return 0
    return sum(f.stat().st_size for f in DATA.glob("**/*") if f.is_file())


def flash(sources: list[Path], append: bool) -> None:
    if not sources:
        sys.exit(__doc__)

    packs = [(src, pack_name(src), pack_size(src)) for src in sources]
    incoming = sum(size for _, _, size in packs)
    total = incoming + (staged_size() if append else 0)
    if total > CAP:
        sys.exit(f"{total:,} bytes — over the {CAP:,} LittleFS cap")

    # uploadfs flashes everything under data/. Multiple character directories
    # now become a small on-device roster that Settings > sprite pack cycles.
    if DATA.exists() and not append:
        shutil.rmtree(DATA)
    DATA.mkdir(parents=True, exist_ok=True)

    for src, name, size in packs:
        dst = DATA / name
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        print(f"staged {name}: {size:,} bytes -> {dst}")

    subprocess.run(["pio", "run", "-t", "uploadfs"], cwd=PROJECT, check=True)
    print(f"\nflashed. on the stick: hold A -> settings -> sprite pack")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", nargs="+", type=Path)
    parser.add_argument("--append", action="store_true", help="keep already staged packs under data/characters")
    args = parser.parse_args()
    flash([src.resolve() for src in args.sources], args.append)
