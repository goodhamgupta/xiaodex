# M5StickC Plus Flash and Connection Troubleshooting

Use this guide for the original M5StickC Plus and the normal Xiaodex firmware.
Run commands from the repository root with PlatformIO Core (`pio`) on your
PATH. The separate [Doom firmware](../firmware/m5stickc-plus-doom/README.md)
has its own flash and restore steps.

## Find the USB serial port

Connect the device with a data-capable USB cable. Compare the port list before
and after connecting it:

```bash
pio device list
```

On macOS, inspect USB enumeration and serial interfaces separately:

```bash
system_profiler SPUSBDataType | rg -i -C 8 'M5|FTDI|0403|6001|USB Serial'
ioreg -r -c IOSerialBSDClient -l -w 0
ls -la /dev/cu.*
```

Select the actual `/dev/cu.usbserial-*` device. Bluetooth and debug-console
ports cannot upload this firmware. The original board uses an FTDI USB serial
adapter; its USB visibility and the ESP32 bootloader connection are separate
checks.

If USB enumeration is absent, try another data cable, port, or direct connection
without a hub. If USB is visible but no serial interface appears, check the
USB serial driver and device-access settings. Close other flashers and serial
monitors, reconnect the device, and list ports again.

For firmware uploads on Windows, select the board's actual COM port from
Device Manager; on Linux, inspect `lsusb`, `dmesg`, and the actual `/dev/ttyUSB*`
device permissions. The repository's provisioning and device-control Python
tools currently accept macOS `/dev/cu.usbserial-*` paths only.

## Build and flash

Install the bridge dependency and generate its shared token before building:

```bash
npm ci
npm run configure:bridge-token
```

Replace the example port with the exact port from the previous step:

```bash
DEVICE_PORT=/dev/cu.usbserial-XXXXXXXX
pio run --project-dir firmware/m5stickc-plus
pio run --project-dir firmware/m5stickc-plus -t upload --upload-port "$DEVICE_PORT"
pio run --project-dir firmware/m5stickc-plus -t uploadfs --upload-port "$DEVICE_PORT"
```

`upload` installs firmware; `uploadfs` installs the pet packs staged in
`firmware/m5stickc-plus/data/characters`. The build reads `CODEX_BUDDY_TOKEN`
from the gitignored `.env`. Keep Wi-Fi passwords and API keys out of source
files.

A successful build does not verify USB communication. If upload fails while
connecting to ESP32, confirm the selected port, close other users of it, and
try a different cable. A temporary `upload_speed = 115200` under
`[env:m5stickc-plus]` in `platformio.ini` can help with an unreliable upload.

Use a full erase only when intentionally clearing all flash, including stored
settings. Restore both firmware and filesystem afterward:

```bash
pio run --project-dir firmware/m5stickc-plus -t erase --upload-port "$DEVICE_PORT"
pio run --project-dir firmware/m5stickc-plus -t upload --upload-port "$DEVICE_PORT"
pio run --project-dir firmware/m5stickc-plus -t uploadfs --upload-port "$DEVICE_PORT"
```

A factory reset clears saved settings; it does not replace the installed
firmware image.

## Provision Wi-Fi and connect the bridge

Create a Python environment for the USB tools, then load the shared token:

```bash
python3 -m venv /tmp/xiaodex-tools
/tmp/xiaodex-tools/bin/python -m pip install -r firmware/m5stickc-plus/tools/requirements.txt
set -a
. ./.env
set +a
```

Use the bridge Mac's reachable LAN address for `BRIDGE_HOST`, and the device's
actual USB port for `DEVICE_PORT`. The tool prompts for the Wi-Fi password in
an interactive terminal, or reads `CODEX_BUDDY_WIFI_PASSWORD` if set:

```bash
BRIDGE_HOST=192.168.1.10
/tmp/xiaodex-tools/bin/python firmware/m5stickc-plus/tools/configure_wifi.py \
  --port "$DEVICE_PORT" --ssid "your-wifi" --host "$BRIDGE_HOST"
node --env-file=.env ./bin/codex-buddy.js --host 0.0.0.0 --port 8787
```

If Wi-Fi connects but the bridge does not, check the host address, matching
token, listener, and LAN reachability. Allow both TCP and UDP on the configured
bridge port; a loopback listener cannot accept a connection from the stick.
Check the Mac's listeners with:

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
lsof -nP -iUDP:8787
```

For an already-provisioned stick, retarget the bridge without changing saved
Wi-Fi credentials:

```bash
/tmp/xiaodex-tools/bin/python firmware/m5stickc-plus/tools/configure_wifi.py \
  --port "$DEVICE_PORT" --bridge-only --host "$BRIDGE_HOST" --bridge-port 8787
```

Full provisioning must succeed once before `--bridge-only` can be used. A valid
token compiled from `.env` takes precedence over the NVS token at boot, so
persistent token rotation requires updating `.env` and reflashing. To remove
saved Wi-Fi and bridge settings, use `configure_wifi.py --port "$DEVICE_PORT"
--forget` with the same Python environment.

## Inspect status and capture the screen

Close serial monitors before running these commands. Opening the serial port
can reset the ESP32; the controller includes a startup delay:

```bash
/tmp/xiaodex-tools/bin/python firmware/m5stickc-plus/tools/device_control.py \
  --port "$DEVICE_PORT" status
/tmp/xiaodex-tools/bin/python firmware/m5stickc-plus/tools/device_control.py \
  --port "$DEVICE_PORT" screenshot artifacts/device/home.png
/tmp/xiaodex-tools/bin/python firmware/m5stickc-plus/tools/device_control.py \
  --port "$DEVICE_PORT" gallery artifacts/device/gallery
```

`status` reports device, Wi-Fi, battery, and pet state. `screenshot` saves a
CRC-validated PNG of the portrait framebuffer. `gallery` navigates and captures
Home, Pet, Info, Menu, and Settings in one serial session, preserving navigation
between captures. It sends synthetic button presses, so use it when no approval
or voice interaction is active.

Screen capture is unavailable while the microphone or voice-start handshake is
active, while the panel is off or face-down, and for the landscape charging
clock. Wake the display and return to a portrait screen before retrying.
For raw serial diagnostics, use `pio device monitor --port "$DEVICE_PORT"
--baud 115200`, then exit the monitor before provisioning or capturing again.

See the [device guide](device-guide.md), [USB protocol](protocol.md#usb-device-control),
and [README](../README.md#flash-the-m5stickc-plus) for the complete workflows.
