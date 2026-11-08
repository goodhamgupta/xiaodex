import hashlib
import struct
import tempfile
import unittest
from pathlib import Path

from convert_gba_wad import Lump, process, read_wad, write_wad
from trim_shareware import black_patch, trim_shareware


ROOT = Path(__file__).resolve().parents[1]
PREPARED_WAD = ROOT / "data" / "doom1gba.wad"
PARTITIONS = ROOT / "partitions.csv"


def wad_partition_size() -> int:
    for raw_line in PARTITIONS.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        fields = [field.strip() for field in line.split(",")]
        if fields[0] == "wad":
            return int(fields[4], 0)
    raise AssertionError("partitions.csv has no wad partition")


class WadCodecTest(unittest.TestCase):
    def test_round_trip_preserves_names_data_and_alignment(self):
        lumps = [Lump("ONE", b"abc"), Lump("EMPTY", b""), Lump("TWO", b"12345")]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.wad"
            write_wad(path, lumps)
            self.assertEqual(read_wad(path), lumps)
            raw = path.read_bytes()
            _, count, directory_offset = struct.unpack_from("<4sii", raw, 0)
            self.assertEqual((count, directory_offset), (3, 12))
            positions = [
                struct.unpack_from("<i", raw, directory_offset + index * 16)[0]
                for index in range(count)
            ]
            self.assertEqual(positions[0] % 4, 0)
            self.assertEqual(positions[2] % 4, 0)

    def test_processor_uppercases_patch_names(self):
        pnames = struct.pack("<I", 2) + b"lower\0\0\0" + b"MiXeD\0\0\0"
        lumps = [Lump("PNAMES", pnames)]
        process(lumps)
        self.assertEqual(lumps[0].data[4:12], b"LOWER\0\0\0")
        self.assertEqual(lumps[0].data[12:20], b"MIXED\0\0\0")

    def test_shareware_trim_keeps_visuals_and_silences_audio(self):
        lumps = [
            Lump("DSPISTOL", b"sound"),
            Lump("DEMO1", b"demo"),
            Lump("D_E1M1", b"music"),
            Lump("HELP1", b"large art"),
            Lump("PLAYPAL", b"visual"),
        ]
        trimmed, stats = trim_shareware(lumps)
        self.assertEqual([lump.name for lump in trimmed], ["D_E1M1", "HELP1", "PLAYPAL"])
        self.assertEqual(trimmed[0].data, b"")
        self.assertEqual(trimmed[1].data, black_patch())
        self.assertEqual(trimmed[2].data, b"visual")
        self.assertEqual(stats, {"removed": 2, "stubbed": 1})

    @unittest.skipUnless(PREPARED_WAD.is_file(), "run prepare_wad.py first")
    def test_prepared_release_is_full_episode_and_fits_partition(self):
        raw = PREPARED_WAD.read_bytes()
        self.assertEqual(len(raw), 3_472_136)
        self.assertLessEqual(len(raw), wad_partition_size())
        self.assertEqual(
            hashlib.sha256(raw).hexdigest(),
            "1f75ddb561dfb71662804e2e649c63cee7f03fbabdc2c914ae6c79b8f02d7f1e",
        )
        names = {lump.name for lump in read_wad(PREPARED_WAD)}
        self.assertTrue({f"E1M{mission}" for mission in range(1, 10)} <= names)


if __name__ == "__main__":
    unittest.main()
