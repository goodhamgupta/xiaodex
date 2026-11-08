# Xiaodex Companion Case — Print Guide

Verified in Blender (2026-08-12, live MCP session) against the pinned official
M5StickC Plus STL: all printed parts watertight, dimensions on spec, **zero
interference in the assembled state** (exact boolean check, 0.0 mm³ overlap
between every part pair and against the 24.00 × 48.00 × 13.50 mm device
envelope).

> **Rev 2 (2026-08-12): screen window corrected.** The first tray's 19.0 × 28.8
> window exposed ~2 mm of the M5's orange shell around the display. The window
> is now 14.2 × 24.2 (official shell opening 14.8 × 24.8 minus a 0.3 mm cover
> margin per side). **If you printed rev 1, reprint only `xiaodex_front_tray.stl`**
> — all other parts are unchanged.

## Verified dimensions

| Check | Result |
| --- | --- |
| Assembled case (incl. lanyard loop) | 27.0 × 16.6 × 72.0 mm (16.0 body + 0.6 raised screen bezel) |
| Front tray | 27.0 × 10.6 × 63.0 mm, watertight |
| Rear cover | 27.0 × 9.1 × 72.0 mm, watertight |
| Device fit | 0 contact with the 24.00 × 48.00 × 13.50 mm pinned reference; 0.30 mm nominal side clearance |
| Shell mating | tray ∩ cover = 0.0 mm³ (loop seat relief included) |
| X button seating | flange ∩ tray = 0.0 mm³ (rests on its pocket, 0.35 mm travel free) |

## What to print (in `blender-stl/`)

| # | File | Filament | Qty | Notes |
| --- | --- | --- | --- | --- |
| 1 | `xiaodex_front_tray.stl` | Charcoal PETG/ASA | 1 | Print front-face down; no supports |
| 2 | `xiaodex_rear_cover.stl` | Charcoal PETG/ASA | 1 | Print back-face down; small bridge under the loop's front half (≈2.5 mm, no supports needed) |
| 3 | `xiaodex_button_x.stl` | Charcoal PETG/ASA | 1 | Face down; drives M5 Button A |
| 4 | `xiaodex_button_b.stl` | **Purple** PETG | 1 | Voice button, right flank (official BtnB side) |
| 5 | `xiaodex_power_cap.stl` | Charcoal PETG/ASA | 1 | Left flank |
| 6 | `xiaodex_grille_mesh.stl` | — (not printed) | 1 | 0.14 mm dark mesh/film — cut from adhesive speaker mesh, stick behind the rear grid |

Suggested settings: 0.16 mm layers, 3 perimeters, 100 % infill on the three
small caps, 25 %+ on the shells.

## Assembly order

1. Drop the X button into the front tray from the inside (flange seats in its pocket).
2. Fit the purple button and power cap into their flank pockets from the inside.
3. Seat the M5StickC Plus in the tray, screen forward, USB-C down.
4. Stick the mesh film behind the rear cover's grid.
5. Press the rear cover on — four Ø2.2 mm pegs into Ø2.5 mm sockets; the loop's
   relieved front edge lands on the tray's top wall.

## Before daily use (physical checks CAD cannot prove)

- Peg friction fit (print the cover at 100 %/102 % XY scale if pegs are loose/tight).
- X button click force and return over repeated presses.
- Lanyard loop pull strength in your chosen material.
