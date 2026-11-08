import hashlib
from pathlib import Path

Import("env")

wad = Path(env.subst("$PROJECT_DIR")) / "data" / "doom1gba.wad"
partitions = Path(env.subst("$PROJECT_DIR")) / "partitions.csv"
expected_sha256 = "1f75ddb561dfb71662804e2e649c63cee7f03fbabdc2c914ae6c79b8f02d7f1e"
if not wad.is_file():
    raise RuntimeError(
        "Doom WAD is missing; run `python3 tools/prepare_wad.py` from "
        "firmware/m5stickc-plus-doom first"
    )

actual_sha256 = hashlib.sha256(wad.read_bytes()).hexdigest()
if actual_sha256 != expected_sha256:
    raise RuntimeError(
        f"Doom WAD SHA-256 is {actual_sha256}; rerun `python3 tools/prepare_wad.py`"
    )

wad_offset = None
partition_size = None
for raw_line in partitions.read_text(encoding="utf-8").splitlines():
    line = raw_line.split("#", 1)[0].strip()
    if not line:
        continue
    fields = [field.strip() for field in line.split(",")]
    if fields[0] == "wad":
        wad_offset = int(fields[3], 0)
        partition_size = int(fields[4], 0)
        break
if wad_offset is None or partition_size is None:
    raise RuntimeError("partitions.csv has no explicit wad partition")

if wad.stat().st_size > partition_size:
    raise RuntimeError(
        f"converted WAD is {wad.stat().st_size} bytes; doomwad partition "
        f"only holds {partition_size} bytes"
    )

env.Append(UPLOADERFLAGS=[hex(wad_offset), str(wad)])
