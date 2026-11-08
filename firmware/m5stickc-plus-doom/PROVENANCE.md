# Xiaodex Doom provenance and modification record

The linked Doom firmware is distributed under `GPL-2.0-or-later`. Generated
IWAD/PWAD game data is a separate input and is not covered by that program
license.

## Source baseline

| Files | Baseline | Xiaodex changes dated 2026-08-26 |
|---|---|---|
| `src/engine/include/**`, most of `src/engine/source/**` | [`HenrysCat/cyd-doom@1c58bf4`](https://github.com/HenrysCat/cyd-doom/tree/1c58bf47a7cf2a39564bb60b68c3b097822790b1), derived from GBADoom/PrBoom/Doom | Vendored for a separate original-M5StickC Plus firmware target. |
| `src/engine/source/d_main.c`, `g_game.c` | [`atc1441/Action_104_Games_and_Pacman_DOOM@7c4d5a9`](https://github.com/atc1441/Action_104_Games_and_Pacman_DOOM/tree/7c4d5a95364888753fba4409065816408015d537) | Restored nine-map/secret progression, disabled unsupported audio, booted E1M1 directly, and fixed an empty-save load leak. |
| `src/engine/source/z_zone.c` | `cyd-doom@1c58bf4` | Added a protected 64 KiB level arena, four general internal-RAM regions, multi-zone free/tag/check logic, and diagnostics. No PSRAM or flash-backed zone is used. |
| `src/engine/include/r_defs.h`, `src/engine/source/r_hotpath.iwram.c` | `cyd-doom@1c58bf4` | Raised fixed wall/opening capacities and exposed cumulative wall/opening/sprite overflow counters for on-device verification. |
| `src/engine/source/p_setup.c` | `cyd-doom@1c58bf4` | Purges rebuildable WAD cache entries between maps so the protected level arena can coalesce. |
| `src/engine/source/p_user.c` | `cyd-doom@1c58bf4` | Allows either Use or a fresh Fire edge to restart after death, without auto-restarting when Fire was held during the fatal hit. |
| `src/port` equivalents now at `src/main.cpp`, `i_system_esp32.cpp`, `sram.c`, `wad_mmap.c`, `doomport.h` | `cyd-doom@1c58bf4` | Replaced CYD setup/touch hardware, added a static framebuffer, measured task sizing, CRC journaled saves, and USB diagnostics. |
| `src/display.cpp`, `src/input.cpp`, `src/runtime_status.c` | New Xiaodex platform code; pin/control behavior cross-checked against M5Stack's original StickC Plus library and [`Sht0p0r-arts/doom-m5stickc`](https://github.com/Sht0p0r-arts/doom-m5stickc/tree/a191206c46958900c72ee71924fd11e3a24bb296) | AXP192/ST7789V2 display and true power-off, MPU6886 tilt, A/B controls, RGB332 capture, and hardware diagnostics. |

Modified vendored engine files are identified in the table above; files with
larger platform changes also carry a dated notice at the top. Unmodified engine
files retain their original Doom/PrBoom/GBADoom copyright headers.

## Game-data tooling and boundary

`tools/convert_gba_wad.py` is a dependency-free Python reimplementation of the
map-lump transformations documented by GbaWadUtil. No GbaWadUtil source or
binary is vendored. During development it was compared against Sprite_tm's
known GBADoom conversion of the shareware 1.9 IWAD: directory/name ordering,
map-lump transformations, and PNAMES normalization matched; only demo and music
lumps differed because Sprite_tm's private replacement files are not inputs
here.

`tools/prepare_wad.py` downloads and hash-verifies two non-GPL game-data inputs:

- Doom shareware 1.9 IWAD, SHA-256
  `1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771`.
- `doomhack/GbaWadUtil@4ea9f48` compatibility PWAD, SHA-256
  `3e67a42b2eb4630bbebe773de309b8404e75bb558e9ce39915d707025195c549`.

`tools/trim_shareware.py` removes DS/DP sound lumps, demos, MIDI instruments,
and music payloads while retaining the music names as zero-length entries. It
replaces only `HELP1`, `HELP2`, `CREDIT`, and `WIMAP0` with a shared-column
black patch. All E1M1–E1M9 geometry and gameplay textures, flats, sprites, and
animations remain from the original shareware IWAD. Its semantics and output
were cross-checked against `HenrysCat/cyd-doom@1c58bf4`'s `wadtrim.py`; that
script is not vendored.

The final 3,472,136-byte WAD has SHA-256
`1f75ddb561dfb71662804e2e649c63cee7f03fbabdc2c914ae6c79b8f02d7f1e`.
Preparation happens in a temporary directory before atomically replacing the
gitignored `data/doom1gba.wad`. The upload hook independently checks that
digest and reads the flash offset/size from `partitions.csv`. No WAD is
committed to this repository. Hardware verification proves every E1M1–E1M9
map loads and returns to the game loop; it is not a claim that a human
completed every level end-to-end during this development session.

Doom shareware remains copyrighted game data owned by its rights holders. The
preparation script is intended for local use where permitted. Do not commit or
redistribute the downloaded or generated IWAD; users are responsible for
having the right to obtain and use it.
