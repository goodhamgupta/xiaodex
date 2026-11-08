# Xiaodex M5StickC Plus Device Guide

This guide describes the controls and pet behavior in the current Codex Buddy
firmware. The short version is that **FED is token progress**, **ENERGY is
virtual pet stamina**, and the actual battery level is a separate value on
**Info > Device**.

## Controls

| Context | Button A (large M5/front button) | Button B (right side) |
| --- | --- | --- |
| Normal use | Tap to cycle Home -> Pet -> Info | On Home, scroll activity; on Pet or Info, advance the page |
| Approval prompt | Approve this request once | Deny this request |
| Voice | Hold for about 200 ms, keep holding while speaking, then release | Not used |
| Menu | Move to the next row; holding A repeats | Select the row or change its value |

Hold B for about 650 ms to open the menu. The voice gesture is disabled while
an approval prompt or menu is open: A belongs to the prompt or menu in those
contexts. Recording stops automatically after 30 seconds.

The left-side power button is separate from A and B. Tap it to toggle the
display, or hold it for about six seconds to power the stick off. When the
display is already off, the A or B press that wakes it is deliberately consumed;
release it and press again to perform the intended action.

### USB testing

`firmware/m5stickc-plus/tools/device_control.py` can send synthetic A/B
presses through USB and capture the real portrait framebuffer as a
CRC-validated PNG. Synthetic input is merged with the physical button state,
so it exercises the same wake, navigation, approval, menu, and hold branches.
The read-only `status` and screenshot operations do not make an idle Codex
session appear connected. A physical press begun during screen transfer is
consumed through its release, avoiding a delayed menu or voice action.
The `gallery` subcommand keeps one serial session open while it captures Home,
Pet, Info, Menu, and Settings. The final frame exposes persistent options such
as `sound off`. Keeping one session open matters because opening the serial
adapter resets the ESP32.

Capture pauses UI mutation but continues polling the Wi-Fi transport one chunk
per loop. It uses the existing 32,400-byte RGB332 sprite in place and does not
allocate a second framebuffer. Capture is unavailable while the microphone or
voice-start handshake is active, when the display is off, when the stick is
face-down, or while the landscape charging clock is visible. Post-recording
transcript and submission states remain captureable for device testing. The
landscape clock draws directly to the LCD, whose pixels cannot be
read reliably over this board's one-way display wiring.

## Pet stats

Open the **Pet** screen with A. Its first page contains these stats:

| Stat | Meaning |
| --- | --- |
| **MOOD** | Up to four hearts based mainly on how quickly approval prompts are approved, with a penalty for frequent denials. |
| **FED** | Progress through the current 50,000-output-token level. It is not a hunger/health meter, battery charge, an API quota, or a cost meter. |
| **ENERGY** | Virtual pet stamina. It is not the physical battery level. A completed face-down nap refills it. |
| **Lv** | The pet's token-driven level. Every 50,000 observed output tokens adds one level. |
| **approved / denied** | Approval decisions sent with A and denial decisions sent with B from this stick. |
| **napped** | Total completed face-down nap time, accumulated across reboots. |
| **tokens** | The live bridge output-token total while connected; when disconnected, the saved device accumulator is shown instead. |
| **today** | Output tokens counted by the bridge for its current local calendar day. It is zero while the stick is disconnected. |

### FED and levels

The FED row has ten dots. Each filled dot represents 5,000 output tokens toward
the next level:

```text
10 dots x 5,000 output tokens = 50,000 output tokens per level
```

When live progress crosses a 50,000-token boundary, **Lv** increases, FED starts
again at zero dots, and the pet plays a brief celebration. Catch-up during the
first connection after a reboot can update Lv without the animation. FED does
not drain with time. Approving a request affects MOOD, but it does not directly
add FED or levels.

The display therefore shows zero through nine filled dots, not a lasting 10/10
bar: the next 5,000-token increment completes the level and immediately resets
the row.

The bridge reports output-token totals observed from Codex. The stick converts
increases in that counter into pet progress. A bridge restart or lower counter
does not take progress away; the stick rebases and counts later increases. The
live `tokens` number and FED/Lv can therefore differ temporarily because the
live bridge counter and the device accumulator have different lifetimes.
The `today` counter belongs to the bridge rather than the stick; it rolls over
at the bridge's local midnight and is not persisted as a pet stat.

Token deltas are kept in RAM between significant saves. Approval and denial
actions, completed naps, and level crossings save the full stats record. A
power loss before the next such save can lose the unfinished part of the
current level, but not an already saved level.

### MOOD

The base MOOD uses the median response time from the last eight approvals made
on the stick:

| Median approval time | Base hearts |
| --- | --- |
| 1-14 seconds | 4 |
| 15-29 seconds | 3 |
| 30-59 seconds | 2 |
| 60-119 seconds | 1 |
| 120 seconds or more | 0 |

Before there is usable approval timing data, the pet starts neutral at two
hearts. Response time is stored in whole seconds, and the current firmware also
uses zero as its no-data marker. Consequently, a sub-one-second approval that
records as zero produces the neutral two-heart base instead of four hearts.
Once there have been at least three approve/deny decisions, denials can reduce
the base mood:

- If denials are more than one third of all decisions, subtract one heart.
- If denials outnumber approvals, subtract two hearts instead.
- Mood never falls below zero hearts.

An approval completed in under five seconds also plays a short heart animation.
The animation is a reaction; it is separate from the persistent heart count.

### ENERGY and naps

ENERGY has five bars. It starts at 3/5 after every reboot and is not persisted.
It loses one bar every two hours. Ending a recognized nap refills it to 5/5,
after which it again loses one bar every two hours. Nap duration does not change
the refill amount.

To nap the pet, place the stick face-down on a stable surface. After a short
orientation debounce, the display dims and character animation pauses. This is
a nap, not a power-off, although the normal 30-second battery screen timeout
can subsequently turn the panel off. Turn the stick away from face-down for a
sustained moment to end the nap, add its completed duration to `napped`, and
refill ENERGY.

Nap detection pauses while an approval prompt or voice status is visible. A
nap interrupted by power loss before it ends is not added to the cumulative
nap total.

For actual charge, cycle to **Info**, use B to reach **Device**, and read the
battery percentage and voltage there. The percentage is an estimate derived
from battery voltage, so it should not be treated as laboratory-grade capacity
measurement.

## Screens and pet states

A cycles between three main screens:

1. **Home** shows the character plus the Codex status, activity text, voice
   state, or approval card.
2. **Pet** has a stats page and a short on-device help page; B switches pages.
3. **Info** has About, Buttons, Codex/Link, Device, Bluetooth, and Credits
   pages; B switches pages.

Home streams the latest assistant response as Codex generates it. The bridge
coalesces rapid app-server text deltas and sends bounded replacement previews,
then marks the response complete when the agent message or turn ends. Longer
answers therefore show their newest tail instead of trying to retain an
unbounded transcript on the stick. While the assistant card is visible, tap B
to move backward one wrapped row. After reaching the oldest retained row, tap B
again to return to the newest tail. Each scroll tap refreshes the completed
answer's 30-second reading window.

The lower panel uses this priority: **approval > active voice recording > voice
error > final transcript dwell > assistant response > other non-recording voice
status > activity feed**. Thus an approval remains actionable and an unrelated
response cannot hide a live capture, a dictation failure, or the authoritative
`YOU SAID` transcript during its 2.5-second minimum reading window. Assistant
frames accumulate underneath and take over after that dwell. Completed
answers remain for 30 seconds. A live card with no replacement frame for 60
seconds is cleared, as is a live card left behind by a bridge disconnect or
Wi-Fi reconnection. Reauthentication replays an in-flight response, or the most
recent completion if its reading window has not expired.

The boot, Pet, and Settings screens combine the persisted owner and pet name.
With bridge owner `Shubham` and pet name `Xiaodex`, they show
**Shubham's Xiaodex**. The same two fields remain separately available on
**Info > Device** and in the device status response.

The character follows Codex activity:

| State | Meaning |
| --- | --- |
| `sleep` | No current Codex activity or no recent device data |
| `idle` | Codex tasks are known but none is running |
| `busy` | Codex is working |
| `attention` | Codex is waiting for an approval |
| `celebrate` | Work just completed or the pet level increased |
| `dizzy` | The stick was shaken |
| `heart` | A fast approval or successful voice submission just occurred |

On battery, the display turns off after 30 seconds without an approval or voice
status. USB power disables that automatic screen-off. When USB is connected,
the bridge has synchronized the clock, and Codex has no running or waiting
work, an idle charging clock can replace the Home screen. **Settings > clock
rot** selects automatic, portrait, or landscape clock orientation.

## Approvals

An incoming approval wakes the display, sounds an alert when sound is enabled,
and uses the LED attention pulse when the LED setting is enabled. A approves the
single request (`once`); B denies it. If the bridge rejects the decision, the
firmware enables the buttons again so the request can be retried.

The stick exposes the request selected by the bridge, not arbitrary Codex task
control. Review the tool name and hint on the approval card before accepting.

## Voice input

Voice uses the M5StickC Plus onboard microphone and Wi-Fi connection:

1. Provision Wi-Fi and start an authenticated bridge reachable on the LAN.
2. Keep Codex Desktop running. The bridge uses Desktop's existing app-server
   owner by default; it never silently spawns a second app-server. With no
   selector it follows the latest eligible Desktop task when recording starts.
   Set
   `OPENAI_API_KEY` only on the bridge Mac and select the Codex destination
   with `--voice-thread-id latest` or an exact task UUID. `latest` skips hidden
   subagent and private app-server logs. It selects the eligible sidebar task
   with the most recent user activity across projects when each recording
   starts. Assistant and tool writes do not change that ordering. The recording
   stays bound to the selected task through transcription, submission, approval,
   and response streaming. An exact UUID remains pinned across recordings.
3. Hold A. After the 200 ms hold gesture is recognized, the display says
   `listening`; speak while holding it and release A. Realtime's cumulative
   partial transcript streams into a larger `YOU SAID / LIVE` card as words
   arrive.
4. When Realtime finalizes the text, the card changes to `YOU SAID / SENDING`
   before the bridge starts the Codex turn. The exact full transcript is
   submitted in the background while the display keeps a bounded matching
   preview visible for at least 2.5 seconds. It then changes to `SENT`, or the
   display shows `failed` with the specific error.
5. Once Codex starts answering, its response replaces the voice card and
   updates as app-server text deltas arrive.

The stick streams 16 kHz mono PCM in small base64/TCP frames while A is held.
It does not store a whole recording, resample it or transcribe it. The Mac
bridge converts each chunk to 24 kHz and forwards it to OpenAI Realtime.
It does not use the Mac microphone or transcribe locally.

A dedicated reader captures audio independently of the display. A separate
worker encodes and sends each 30 ms chunk over the authenticated TCP connection.
Audio and stop frames arrive in order, and TCP retransmits lost packets.
The device retains only a bounded 840 ms queue. A longer network stall or a
capture overrun fails the turn rather than silently dropping words.

The microphone starts on the press edge. A short debounce starts the remote
session, and the 200 ms hold confirms dictation. A quick navigation tap cancels
the local turn; the bridge keeps a healthy OpenAI connection if it received no
audio. Failed idle connections are checked and replaced in the background.

The bridge uses `gpt-live-transcribe` with `delay: low`. Partial transcripts
return to the stick at most every 125 ms. On release, the bridge validates the
frame/sample totals, commits the audio, and submits the full final transcript
to the selected Codex chat while the device keeps its preview visible.

For recordings of at least 500 ms with no transcript, the bridge retries once
using the audio held in Mac memory and at least `delay: medium`. It clears that
audio after the turn; shorter or twice-empty recordings show
`no speech detected - hold A while speaking`.

Voice requires Wi-Fi, TCP access to the bridge, and an OpenAI connection.
The bridge also accepts older UDP firmware, which requires UDP on the same
port. An authenticated reconnect retires the previous device session.

If you see `voice network buffer full`, the audio sender stalled longer than
the local queue could absorb. USB logs distinguish a TCP write timeout from an
I2S capture problem. Older UDP firmware also logs packet-stage errors and can
report a stop-sequence mismatch after packet loss.

Assistant streaming comes from the Codex Desktop owner followed by the bridge,
not from OpenAI Realtime transcription. Desktop sends versioned conversation
patches through its local coordination socket; the bridge turns those patches
into bounded assistant previews for Xiaodex.

A task selected through `latest` appears in the Codex Desktop sidebar. The
bridge resolves the eligible task with the most recent user activity across
Codex Desktop when A starts a new recording, then asks that task's Desktop owner
to run the complete voice turn.
The user message and response appear live in the already-open Mac task. Missing
owners, protocol mismatches, and stream revision gaps fail closed. Use an exact
UUID when the bridge must keep selecting the same named sidebar task.

See the [README setup section](../README.md#flash-the-m5stickc-plus) for the bridge command
and [wire protocol](protocol.md#onboard-voice-audio) for the audio message
format and limits.

## Wi-Fi provisioning

The USB provisioning tool stores the network and bridge configuration in NVS.
Its limits are:

- SSID: 32 UTF-8 bytes maximum.
- Password: 64 UTF-8 bytes maximum; an empty password is valid for an open
  network.
- Bridge host: 64 bytes maximum; bridge port: 1-65535.
- Shared token: 16-96 characters using letters, digits, `.`, `_`, `~`, or `-`.

When only the Mac's LAN address or bridge port changes, use the
README's [`--bridge-only` command](../README.md#flash-the-m5stickc-plus). It
requires an existing full NVS profile and updates only those three bridge keys;
it neither prompts for nor rewrites the saved SSID/password. The stick keeps
its Wi-Fi association and reconnects to the new bridge endpoint. The compiled
`.env` token overrides NVS at boot; to rotate that token
persistently, update `.env` and reflash as described in the README.

USB is no longer required after provisioning. Xiaodex can run on battery, but
the Mac bridge must remain running, the Mac and stick must be mutually
reachable over Wi-Fi, and TCP must be allowed on the configured bridge port
(plus UDP for older firmware).

Turning **Settings > wifi** off stops Wi-Fi without deleting those values. Use
the README's [`--forget` command](../README.md#flash-the-m5stickc-plus) to erase
only Wi-Fi/bridge provisioning, or use factory reset to erase it with all other
device data. **Info > Codex/Link** reports `via wifi` once live data is arriving.

The M5StickC Plus has no PSRAM, so the legacy BLE stack, Wi-Fi, and the
full-screen framebuffer cannot run together reliably. When Wi-Fi is enabled
and a bridge is provisioned, Xiaodex starts in **Wi-Fi mode** and defers BLE;
the Settings and Bluetooth info screens say `wifi` / `wifi mode`. In that
Wi-Fi-only boot path, modem sleep is disabled to keep the live PCM stream
stable. To use BLE as a fallback, turn Wi-Fi off and reboot. USB serial remains
available in both modes.

## Menu and settings

Hold B to open the menu. **Voice** displays a reminder to hold A; it does not
start recording by itself. **Demo** toggles an eight-second cycle of fake
states and ignores live Codex state until demo mode is turned off or the stick
reboots.

| Setting | Behavior | Persists after reboot? |
| --- | --- | --- |
| brightness | Cycles 0/4 through 4/4 | No; boot starts at 4/4 |
| sound | Enables alert and feedback beeps | Yes |
| bluetooth | Enables the BLE fallback at boot when Wi-Fi mode is not active | Yes |
| wifi | Enables or disables the configured Wi-Fi bridge connection; disabling it retains credentials | Yes |
| led | Enables the attention-state LED pulse | Yes |
| transcript | Shows or hides the lower Home text/HUD | Yes |
| clock rot | Cycles automatic, portrait, and landscape clock orientation | Yes |
| sprite pack | Cycles installed character packs | Yes |

Bluetooth and Wi-Fi mode selection is applied at boot. After changing either
radio setting, reboot Xiaodex before relying on the new radio state.

Current transcript limitation: turning **transcript off** also hides the
approval card's text. A and B still act on a pending approval, so turn the
setting back on before approving if the request details are not visible.

## Persistence and reset

| Data | Normal reboot | Delete char | Factory reset |
| --- | --- | --- | --- |
| Approvals, denials, mood history, nap total, level, saved token progress | Kept | Kept | Cleared |
| ENERGY | Returns to 3/5 | Returns to 3/5 after reboot | Returns to 3/5 after reboot |
| Sound, Bluetooth preference, Wi-Fi enabled state, LED, transcript, clock rotation | Kept | Kept | Defaults restored |
| Provisioned Wi-Fi/bridge credentials | Kept | Kept | Cleared |
| Owner name and pet name | Kept | Kept | Cleared/defaulted; the bridge can resend its owner name |
| Installed sprite packs | Kept | All packs erased | All packs erased |
| Selected sprite-pack preference | Kept | Kept, but unusable until packs are reinstalled | Cleared/defaulted |
| BLE bonds | Kept | Kept | Cleared |

Reset actions require B twice on the same row within three seconds; moving to
another row cancels the confirmation. **Delete char** erases every installed
character pack and reboots into `no character loaded`. Re-run `uploadfs` or the
character flashing tool to restore packs. **Factory reset** also clears all
pet stats, names, stored settings, Wi-Fi provisioning, character files, and BLE
bonds before rebooting.
