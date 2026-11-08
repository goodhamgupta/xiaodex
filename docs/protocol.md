# Codex Buddy Wire Protocol

Current firmware uses one UTF-8 JSON object per TCP line for control,
responses and bounded base64 audio frames. Older firmware can still send
binary PCM over UDP, as described below.

## Heartbeat

```json
{
  "total": 1,
  "running": 0,
  "waiting": 1,
  "completed": false,
  "pet_state": "attention",
  "pet": {
    "id": "codex-spark",
    "state": "attention",
    "source": "codex-state",
    "sprite_pack": "codex-spark",
    "sprite_provider": "imagen"
  },
  "msg": "approve: Bash",
  "entries": ["12:34 approval Bash"],
  "tokens": 1200,
  "tokens_today": 400,
  "prompt": {
    "id": "1",
    "tool": "Bash",
    "hint": "git push origin main"
  }
}
```

`pet_state` is the compact firmware field. It can be one of:

- `sleep`: no Codex activity is available.
- `idle`: Codex has threads but no active work.
- `busy`: Codex is actively working.
- `attention`: Codex is waiting for an approval.
- `celebrate`: a turn completed in the last few seconds.
- `dizzy`: local device shake one-shot.
- `heart`: local device approval/pet one-shot.

The nested `pet` object is metadata for richer devices and simulators. The
M5StickC Plus firmware uses `pet_state` first and falls back to
`pet.state`.

### Token counters

Both counters contain Codex **output tokens**, not total input-plus-output
usage, battery energy, API credit, or cost:

- `tokens` is the sum of the latest output-token totals for the tasks/sessions
  currently known to the bridge. It is the bridge's live counter and can rebase
  when the bridge restarts or its known task set changes.
- `tokens_today` is output usage the bridge has attributed to its current local
  calendar day. It rolls to zero at local midnight.

The M5StickC Plus treats increases in `tokens` as pet progress. A lower counter
rebases its bridge baseline without removing accumulated device progress. The
device uses 50,000 tokens per level and a ten-position FED row with one position
per 5,000 tokens. The row reaches nine filled positions; the next increment
levels the pet and resets it immediately. See the
[device guide](device-guide.md#fed-and-levels) for display and persistence
semantics.

## USB Device Control

The M5StickC Plus accepts a versioned diagnostic namespace from USB serial only.
The same frames arriving over Bluetooth or Wi-Fi are ignored by this handler.
Request IDs are 1-32 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, or `-`.

USB provisioning also supports a bridge-only retarget command for a device
that already has a full Wi-Fi profile in NVS:

```json
{"cmd":"bridge_config","host":"192.168.1.20","port":8787,"token":"shared-token-at-least-16-chars"}
{"ack":"bridge_config","ok":true,"n":0}
```

The command validates and writes only `host`, `port`, and `token`; it rejects a
device without an existing runtime Wi-Fi profile and never writes the stored
`ssid` or `password` keys. Frames received over Bluetooth or Wi-Fi are rejected.
Host and port remain effective after reboot. When firmware contains a valid
bridge token compiled from `.env`, that build-time value overrides the NVS
token on boot; persistently rotating the token therefore also requires updating
`.env` and reflashing.
The supported host tool is documented under
[`--bridge-only`](../README.md#flash-the-m5stickc-plus).

Synthetic button input uses:

```json
{"cmd":"device_control","v":1,"id":"req-1","op":"button","button":"A","action":"tap"}
{"cmd":"device_control","v":1,"id":"req-2","op":"button","button":"B","action":"hold","duration_ms":800}
{"cmd":"device_control","v":1,"id":"req-3","op":"button","button":"A","action":"press"}
{"cmd":"device_control","v":1,"id":"req-4","op":"button","button":"A","action":"release"}
```

`tap` lasts 100 ms. `hold` defaults to 750 ms and accepts 50-30,000 ms. A bare
`press` has a 30-second firmware fail-safe in case the host
disconnects before `release`. Remote and physical state are ORed before the UI
calculates press, release, and hold edges. Repeating the most recent request ID
acknowledges the replay without applying the button action again:

```json
{"ack":"device_control","v":1,"id":"req-2","op":"button","state":"accepted","ok":true,"button":"B","action":"hold","replay":false}
```

Framebuffer capture starts with:

```json
{"cmd":"device_control","v":1,"id":"screen-1","op":"capture"}
```

The firmware renders one current portrait frame, freezes further sprite
mutation, and emits one base64 JSON chunk per main-loop iteration:

```json
{"ack":"device_control","v":1,"id":"screen-1","op":"capture","state":"begin","ok":true,"width":135,"height":240,"format":"rgb332","bytes":32400,"chunk_bytes":384,"source":"sprite"}
{"ack":"device_control","v":1,"id":"screen-1","op":"capture","state":"chunk","seq":0,"offset":0,"data":"..."}
{"ack":"device_control","v":1,"id":"screen-1","op":"capture","state":"end","ok":true,"chunks":85,"bytes":32400,"crc32":"1234abcd"}
```

The host must validate ID, sequence, offsets, decoded length, total byte count,
and CRC32 before decoding RGB332 (`RRRGGGBB`). Firmware logs or unrelated JSON
may appear between complete response lines and should be ignored. Streaming in
place avoids a second 32.4 KB framebuffer and continues normal network polling.
Capture is rejected while microphone transport or the voice-start handshake is
active, with an unavailable framebuffer, when the screen is off or face-down,
or for the direct-to-LCD landscape clock. Post-recording transcript and
submission states remain captureable:

```json
{"ack":"device_control","v":1,"id":"screen-1","op":"capture","state":"error","ok":false,"error":"landscape clock uses direct LCD rendering"}
```

## Assistant Response Stream

Assistant text is a dedicated bridge-to-device stream, separate from heartbeat
snapshots and voice transcription acknowledgements. The bridge accumulates
Codex app-server `item/agentMessage/delta` notifications and broadcasts
display-bounded previews:

```json
{"cmd":"assistant","state":"streaming","threadId":"...","turnId":"...","itemId":"...","text":"I checked the implementation and..."}
```

Rapid deltas are coalesced to at most one frame per assistant item every 125 ms.
`text` is the latest accumulated preview, not a delta to append, and retains up
to 640 UTF-8 bytes. The bridge additionally trims the escaped, serialized JSON
line below the device's 1024-byte receive limit. When a response is longer, the
preview starts with `...` and contains the newest tail, so devices should
replace their displayed text on every frame. `threadId`, `turnId`, and `itemId`
identify concurrent streams.

The authoritative `item/completed` agent message produces a terminal frame:

```json
{"cmd":"assistant","state":"completed","phase":"final_answer","threadId":"...","turnId":"...","itemId":"...","text":"The requested work is complete."}
```

`phase` is `commentary` for an intermediate agent update and `final_answer` for
the turn's final response when the app-server provides it. A missing phase is
treated as a final answer for compatibility with providers that predate this
field. If the item event is absent, `turn/completed` closes any remaining stream
with its accumulated text as a final answer. These frames contain
assistant-visible text only, not
reasoning summaries or command output. They are emitted for turns observed by
the bridge's connected app-server; following a Desktop JSONL session log alone
provides final activity entries but not app-server text deltas. A newly
authenticated device receives the current live preview, or the most recent
completed frame while its 30-second reading window is still active.

On the M5StickC Plus, lower-screen display priority is: approval prompt, active
voice recording, voice error, final transcript dwell, assistant response,
other non-recording voice status, then the ordinary activity feed. This keeps
the live transcript and failures visible. An authoritative final `YOU SAID`
card remains above assistant output for at least 2.5 seconds while submission
continues; assistant frames accumulate and take over afterward. A completed
answer remains visible for 30 seconds. A `streaming`
card is also cleared after 60 seconds without a replacement frame, on bridge
disconnect, or on Wi-Fi reconnection, so a lost completion cannot strand the
screen. Button B scrolls backward through the retained assistant rows and
cycles back to the newest tail after the oldest row; each tap renews a completed
answer's reading window. The device transliterates common Unicode punctuation
and uses `?` for glyphs unavailable in its compact built-in font; the Codex
response itself is not modified.

## Permission Response

Device to bridge:

```json
{"cmd":"permission","id":"1","decision":"once"}
{"cmd":"permission","id":"1","decision":"deny"}
```

The bridge maps `once` to Codex `accept` and `deny` to Codex `decline`.

The bridge replies with:

```json
{"ack":"permission","ok":true}
{"ack":"permission","ok":false,"error":"Desktop IPC expected exactly one pending command approval; found 0"}
```

For an approval mirrored from a Desktop session log, the bridge follows the
prompt's exact task UUID through the user-only Codex Desktop follower IPC. It
requires a targeted full snapshot with exactly one command approval for that
task. The snapshot request must match the card's session-log turn ID, approval
reason, and parsed command before the bridge responds using the pending
app-server request ID and owning Desktop client ID. It never clicks a
front-window button. Unexpected protocol versions, wrong-task or wrong-command
data, ambiguous approvals, malformed frames, and timeouts fail closed.
Duplicate frames with the same prompt and decision share one in-flight
operation; a conflicting decision is rejected. Once a decision frame has been
sent, an ambiguous timeout or lost response remains locked until correlated
session-log output arrives.

The firmware re-enables A/B retry when the permission ack is false. A successful
IPC acknowledgement does not clear the card optimistically: the correlated
session-log tool output remains authoritative and clears the prompt.

## Onboard Voice Audio

Button A starts one authenticated Wi-Fi audio session over TCP:

```json
{"cmd":"voice","action":"start","session":"a1b2c3d4","sampleRate":16000,"channels":1,"format":"pcm_s16le","transport":"wifi"}
```

The bridge acknowledges the session before the device releases its pre-roll:

```json
{"ack":"voice","ok":true,"state":"recording","session":"a1b2c3d4"}
```

Current firmware sends one 30 ms / 960-byte PCM block per JSON line. It encodes
only that small block as base64; it does not resample, transcribe or assemble
a recording on the device. The final block may be shorter.

```json
{"cmd":"voice_audio","session":"a1b2c3d4","seq":0,"encoding":"base64","data":"AAECAwQF"}
```

Audio and stop messages share the authenticated, ordered TCP stream. TCP
retransmits lost network packets. Sequence and sample-count checks remain
strict, and a failed partial write closes the connection rather than joining
two JSON frames or submitting truncated audio. A bounded 840 ms device queue
absorbs short stalls; longer stalls still fail the turn explicitly.

The bridge accepts 16 or 24 kHz mono PCM and resamples 16 kHz chunks to the
24 kHz input required by OpenAI Realtime. It uses `gpt-live-transcribe` with a
`languages` hint and `delay: low`. A healthy unused connection survives
navigation taps. Failed idle connections are checked and replaced in the
background without waiting for another button press.

Older firmware can still select `transport: "wifi_udp"`. Those datagrams use
the same numeric port and must match the authenticated TCP session and source
IP. Their header is unchanged:

| Offset | Bytes | Value |
| ---: | ---: | --- |
| 0 | 4 | ASCII magic `XDV1` |
| 4 | 8 | ASCII hexadecimal session ID |
| 12 | 4 | Unsigned sequence number |
| 16 | 2 | PCM payload length, 2–960 and even |
| 18 | variable | Raw `pcm_s16le` payload |

The legacy UDP path has an eight-position reorder window and a 160 ms stop
grace period. It rejects recordings with missing packets; current firmware
uses TCP to avoid making a dropped datagram fatal to the rest of a recording.

OpenAI Realtime transcript deltas are accumulated by the bridge and returned at
most once every 125 ms. `text` is a cumulative replacement preview, not a delta
for the device to append. It retains the newest UTF-8 tail within 320 bytes; the
full final transcript submitted to Codex remains unmodified:

```json
{"ack":"voice","ok":true,"state":"recording","session":"a1b2c3d4","text":"show repository status"}
```

Releasing A sends the final frame count and sample count:

```json
{"cmd":"voice","action":"stop","session":"a1b2c3d4","seq":1,"samples":3}
```

If capture is abandoned before a valid stop, the device sends an idempotent
cancel. A late cancel for an old ID never tears down a newer session:

```json
{"cmd":"voice","action":"cancel","session":"a1b2c3d4"}
```

```json
{"ack":"voice","ok":true,"state":"cancelled","session":"a1b2c3d4"}
```

The bridge reports finalization, the authoritative transcript, and submission:

```json
{"ack":"voice","ok":true,"state":"transcribing","session":"a1b2c3d4","text":"show repository status"}
```

```json
{"ack":"voice","ok":true,"state":"transcribed","session":"a1b2c3d4","text":"show repository status","submitted":false}
```

`transcribed` is queued synchronously after the final Realtime event and before
the bridge initiates `turn/start`. It therefore carries the display-bounded
authoritative transcript while the exact full text is submitted in the
background. `submitted` means the app-server accepted the turn; it does not
mean the assistant response is complete:

```json
{"ack":"voice","ok":true,"state":"submitted","session":"a1b2c3d4","text":"show status","submitted":true,"threadId":"..."}
```

If validation, OpenAI transcription, or Codex submission fails:

```json
{"ack":"voice","ok":false,"state":"error","session":"a1b2c3d4","error":"..."}
```

Recordings are capped at 30 seconds: 960,000 source PCM bytes at 16 kHz, or
1,440,000 bytes for legacy 24 kHz input. Each in-order frame is rate-converted
when needed and forwarded immediately to a pre-connected OpenAI session; the
bridge does not wait for the stop frame or build a whole-recording WAV. It
retains the forwarded 24 kHz PCM only in memory for the active turn so an empty
result can be retried, then clears it. The stop frame manually commits the
OpenAI audio buffer. If a short
completed event is empty, an
already-accumulated non-empty delta transcript is used. The bridge correlates
deltas, completion, and failure events with the `item_id` returned by
`input_audio_buffer.committed`. A matching completion with no text or deltas
after at least 500 ms of audio is retried once in a fresh session with at least
`delay: medium`; the normal session uses `delay: low`. A second empty result,
or a shorter recording, is reported as
`no speech detected - hold A while speaking`. A rejected chunk or invalid final
sequence is fatal to that session. On a Wi-Fi reconnect, a newly
authenticated connection for the same stable device name retires the half-open
connection and cancels its stale voice session. The device cannot select
`threadId`; the bridge owns the Codex target and rejects any device-supplied
task identifier. The OpenAI API key is bridge-only and never appears in this
protocol.

## Connection Hello

Direct Wi-Fi listeners require a 16-96 character `CODEX_BUDDY_TOKEN`. The
device must send a first line with the same token:

```json
{"name":"Codex-ABCD","token":"shared-token-1234"}
```

The bridge replies:

```json
{"ack":"hello","ok":true}
```
