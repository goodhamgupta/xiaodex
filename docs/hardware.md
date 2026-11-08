# Hardware Notes

Target board: M5StickC Plus.

The M5StickC Plus already has the needed parts: ESP32, 135x240 display, buttons,
SPM1423 PDM microphone, small battery, buzzer, LED, USB-C, and case. The voice
path uses I2S0 with microphone clock on GPIO 0 and data on GPIO 34. Button A is
the large M5/front-face control on GPIO 37; Button B is on the right side on
GPIO 39. A custom 3D printed cover must keep the microphone opening, screen,
buttons, USB-C, ventilation, and antenna clear.

See the [device guide](device-guide.md) for tap/hold behavior. The on-screen
ENERGY bars are a virtual pet stat and are unrelated to the physical LiPo
charge shown under **Info > Device**.

For a bare ESP32 build, buy:

- 1.14 inch ST7789 SPI TFT, 135x240 or 240x135.
- Two momentary buttons.
- 1S LiPo battery, 500-1000 mAh for useful runtime.
- LiPo charger/protection board unless the ESP32 board already has charging.
- Slide power switch.
- Passive buzzer or piezo.
- Optional status LED or RGB LED.
- JST battery lead, wire, headers, heat shrink, M2 screws/standoffs.
- Clear acrylic or polycarbonate screen window.

For a logo cover, use embossed, engraved, or inlaid plastic. Avoid metal-filled
filament around the ESP32 antenna and avoid squeezing the LiPo cell.

## CAD assets

The [Xiaodex companion case](../cad/m5stickc-plus-xiaodex/README.md) is a
27.0 × 16.0 × 72.0 mm enclosure, including its integrated lanyard loop, for the
legacy M5StickC Plus. The charcoal front tray and rear cover surround a
24.0 × 48.0 × 13.5 mm device envelope with 0.30 mm nominal clearance per side.
A 14.2 × 24.2 mm screen window hides the stock shell around the display.

An X button operates front Button A, a purple cap operates right-side Button B,
and a low-profile cap operates the left-side power control. The case includes
a USB-C opening, rear grille, and four alignment pegs. See the
[printing guide](../cad/m5stickc-plus-xiaodex/PRINTING.md) for the part manifest
and assembly steps, including the thin mesh/film grille insert.

A real-device print test is mandatory before producing multiple units because
published CAD does not capture printer shrinkage or manufacturing variation.
