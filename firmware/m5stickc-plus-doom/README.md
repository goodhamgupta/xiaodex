# Xiaodex Doom

This is a standalone, native Doom firmware for the **original M5StickC Plus**
(ESP32-PICO-D4, 4 MB flash, no PSRAM). It runs GBADoom/PrBoom locally on the
stick; it is not a video, network stream, ray-casting imitation, or Mac-hosted
game.

The firmware boots directly into E1M1 with the original Doom shareware 1.9
Episode 1 maps, collision geometry, textures, flats, sprites, and title art.
To fit all nine levels in 4 MB, the preparation step removes audio, music
payloads, and demos, and replaces four non-gameplay 320x200 help/credit/map
background patches with compact black placeholders. Gameplay art is not mixed
with substitute maps or textures. Sound and music are disabled because this
Stick has only a passive buzzer and the requested test configuration is silent.

## Controls

- Tilt the top edge away/toward you: move forward/backward.
- Roll left/right: turn left/right.
- Hold A: fire.
- Tap and release B in under 650 ms: use/open/confirm (Doom's Spacebar action).
- Hold B for about 650 ms: open or close the Doom menu.
- After dying, press A or quickly tap B to restart the current level.

If the Doom menu is open, hold B to close it first; menu input intentionally
consumes A/B instead of forwarding them to the dead player.

Hold the separate left-side power button for about two seconds to request a
true AXP192 shutdown. If software is unresponsive, keep holding for six
seconds for the PMIC's hardware cutoff. Disconnect USB-C first when testing a
fully off state; the USB bridge and charging path have their own VBUS supply.
Press the same side button for about two seconds to power on again.

The MPU6886 is calibrated at boot, so hold the Stick in a comfortable neutral
landscape pose for the first fraction of a second. Movement uses a 0.20 g
activation threshold, a 0.12 g release threshold, low-pass filtering, and
hysteresis to avoid drift.

USB serial at 115200 baud remains a fallback: `w/a/s/d` moves and turns,
`q/e` strafes, `f` fires, Space uses, `m` opens the menu, and `t` toggles the
automap.

## Prepare, build, and flash

The modified shareware WAD is deliberately not committed. The preparation
script downloads a hash-pinned Doom shareware 1.9 IWAD and GBADoom
compatibility PWAD, then builds and flashes firmware and WAD in one PlatformIO
upload:

```bash
cd firmware/m5stickc-plus-doom
python3 tools/prepare_wad.py
pio run -e m5stickc-plus-doom
pio run -e m5stickc-plus-doom -t upload \
  --upload-port /dev/cu.usbserial-XXXXXXXX
```

`prepare_wad.py` verifies both downloads and the final converted WAD with
SHA-256 hashes. The expected output is 3,472,136 bytes with SHA-256
`1f75ddb561dfb71662804e2e649c63cee7f03fbabdc2c914ae6c79b8f02d7f1e`.
It atomically replaces `data/doom1gba.wad`, which is gitignored. The upload hook
rejects a missing, modified, or oversized WAD and derives its offset and size
from the partition table.

Current measured budgets:

| Item | Measured | Available |
|---|---:|---:|
| Firmware binary | 580,992 bytes | 622,592 bytes |
| Converted original-gameplay Episode 1 WAD | 3,472,136 bytes | 3,489,792 bytes |
| Save journal | 4 × 4,096-byte records | 16,384 bytes |
| Static RAM | 97,408 bytes | 327,680 bytes |

On the original Xiaodex connected on 2026-08-25/26, the flashed build rendered
E1M1, fired with physical A, moved from live MPU6886 tilt, opened the menu with
long-B, and progressed normally through the E1M1 intermission into E1M2. A
USB-only stress test loaded and returned from original E1M1 through E1M9 in one
process. This is map-load coverage, not a claim of a complete human
playthrough. The final build reports a stable 35 FPS outside USB transfers, at
least 5,488 bytes of unused task stack, zero drawseg/opening/sprite overflows,
and a 186,116-byte five-region Doom zone. E1M6, the peak-memory map, loads with
4,588 zone bytes free. A 45-second move/turn/fire/use soak plus save, full-map
pass, and E1M6 reload completed with more than 3 KB of zone memory free. A
flash readback then validated the journal CRC and confirmed that slot seven
contained the E1M6 save.

The final AXP192 shutdown test acknowledged the power-off request and then
produced no ESP32 status, heartbeat, or reboot for ten seconds while the
USB-UART adapter remained connected and enumerated.

## USB verification

The Doom build implements the existing Xiaodex USB status, synthetic-button,
and RGB332 screenshot protocol. Opening serial resets this ESP32, so use one
session when an action must affect a later capture:

```bash
python3 ../m5stickc-plus/tools/device_control.py \
  --port /dev/cu.usbserial-XXXXXXXX --open-delay 4 status

python3 ../m5stickc-plus/tools/device_control.py \
  --port /dev/cu.usbserial-XXXXXXXX --open-delay 4 \
  screenshot /tmp/xiaodex-doom.png

python3 ../m5stickc-plus/tools/device_control.py \
  --port /dev/cu.usbserial-XXXXXXXX --open-delay 4 \
  gallery /tmp/xiaodex-doom-gallery
```

In Doom mode, the generic `gallery` sequence is useful as a smoke test: its A
tap consumes one bullet, its long-B opens the menu, and every image is checked
with CRC32.

For a destructive-to-the-current-run (but flash-safe) map progression check,
`tools/verify_progression.py --port /dev/cu.usbserial-XXXXXXXX` enters the
engine's eight-button Exit Level cheat, advances the intermission, and requires
the live status to change from E1M1 to E1M2.

`tools/verify_all_maps.py --port /dev/cu.usbserial-XXXXXXXX` uses a USB-only
deferred-warp diagnostic to load E1M1 through E1M9 in one session. Every map
must return to the live game loop with zero wall/opening/sprite overflows and
minimum zone, stack, and byte-addressable-heap headroom. `--screenshot PATH`
also captures E1M9. Add `--soak-seconds 45 --soak-map 6` to exercise movement,
turning, fire, and use on the peak-memory level; `--save-slot 7` also
overwrites save slot seven during that soak.

`tools/verify_physical_controls.py --port /dev/cu.usbserial-XXXXXXXX` waits for
one real tilt above 0.18 g and one physical A press. Synthetic USB buttons do
not satisfy that check. While active, Doom's HUD displays `TILT + PRESS A` and
the red LED blinks.

`tools/verify_death_restart.py --port /dev/cu.usbserial-XXXXXXXX` uses the
USB-only kill diagnostic to capture a real death state, then requires both A
and short-B to restart the level. It never runs over Wi-Fi or Bluetooth.

## Restore normal Xiaodex

The original Stick cannot hold the full Codex firmware, Doom firmware, and
nine-map WAD simultaneously in 4 MB. Flashing Doom therefore replaces the
normal app and character filesystem. NVS is not erased, so saved Wi-Fi settings
normally survive.

From the repository root, restore the Codex firmware and its LittleFS packs:

```bash
pio run --project-dir firmware/m5stickc-plus -t upload \
  --upload-port /dev/cu.usbserial-XXXXXXXX
pio run --project-dir firmware/m5stickc-plus -t uploadfs \
  --upload-port /dev/cu.usbserial-XXXXXXXX
```

Rebuild with the same `.env` bridge token used by the Mac bridge. Reprovision
Wi-Fi only if the preserved NVS values no longer match the desired network.

## Architecture

- GBADoom renders a single, statically reserved 240×160 indexed framebuffer.
- The ST7789 backend preserves the source 3:2 aspect ratio in a centered
  203×135 image, clears the sidebars, converts through the current Doom
  palette, and sends five-row DMA chunks. Its programmed LCD window width is
  identical to every transmitted row width, preventing diagonal row wrapping.
- USB captures use RGB332 while the panel uses RGB565. Very dark gray ceilings
  can therefore look flatter or olive in a captured PNG than on the LCD.
- The WAD stays in a read-only memory-mapped flash partition; it is never
  copied into RAM.
- Classic ESP32 DRAM is split into non-contiguous regions. The Doom allocator
  carves a protected 64 KB large-map arena out of the largest block and joins
  four general regions (about 45, 40, 24, and 10 KB). It frees level tags in
  every region and reports total/largest headroom over USB. This is native
  internal RAM, not PSRAM or flash-backed gameplay memory.
- Wi-Fi, Bluetooth, voice capture, and audio are not initialized in this
  standalone image.
- Save slots/settings use a 3 KB RAM shadow and a CRC-protected four-sector
  flash journal. Payload-first/header-last writes preserve the previous valid
  record if power is lost mid-save.
- The final partition/WAD migration intentionally resets saves made by earlier
  Doom development builds; their previous raw save location is overwritten by
  the expanded original-gameplay WAD.

## Sources and license

This subproject and its linked firmware are GPL-2.0-or-later. The unrelated Xiaodex
bridge and normal firmware retain their existing licenses.

- Engine and ESP32 memory strategy: [HenrysCat/cyd-doom](https://github.com/HenrysCat/cyd-doom/tree/1c58bf47a7cf2a39564bb60b68c3b097822790b1),
  itself based on GBADoom and PrBoom.
- Full-map progression fixes and low-memory reference:
  [Action_104_Games_and_Pacman_DOOM](https://github.com/atc1441/Action_104_Games_and_Pacman_DOOM/tree/7c4d5a95364888753fba4409065816408015d537).
- Original low-memory ESP32 adaptation and GbaWadUtil changes:
  [Sprite_tm's ESP32-C3 Doom bauble](https://github.com/Spritetm/esp32c3-doom-bauble/tree/b7a005313dc0a1fa20b334efd4237a9fd7780413).
- Original shareware 1.9 game data is downloaded from the hash-pinned copy in
  [Sprite_tm's port](https://github.com/Spritetm/esp32c3-doom-bauble/tree/b7a005313dc0a1fa20b334efd4237a9fd7780413/esp32c3-doom/GbaWadUtil).
- Doom engine: id Software; PrBoom and GBADoom contributors.

See [LICENSE](LICENSE) and [PROVENANCE.md](PROVENANCE.md). Game data is not GPL;
both required WAD inputs are downloaded by hash and the generated WAD remains
gitignored rather than being stored in this repo. Doom shareware remains
copyrighted by its rights holders; do not commit or redistribute the downloaded
or generated IWAD, and obtain/use it only where permitted.
