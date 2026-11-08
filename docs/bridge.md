# Mac bridge developer reference

The bridge runs on the Mac and translates Codex activity, approvals, voice
input, and assistant responses for Xiaodex. For setup, see the
[README](../README.md#flash-the-m5stickc-plus). CLI options are listed by
`node ./bin/codex-buddy.js --help` from the repository root.

## Desktop connection and task selection

The default mode uses Codex Desktop's existing app-server owner through its
local owner/follower IPC socket. The socket is normally
`~/.codex/ipc/ipc.sock`, or `$CODEX_HOME/ipc/ipc.sock` when configured. Override
it with `--desktop-ipc-sock PATH`. This is Desktop's coordination socket;
`--codex-sock` selects a different connection mode described below.

The bridge follows a Desktop chat, submits voice turns to its owner, and
receives versioned conversation patches. User messages, assistant output,
and voice-turn approvals appear in the existing Desktop chat. Missing owners,
unsupported protocol versions, and stream revision gaps stop the operation.
This internal protocol may require bridge updates when Desktop changes.

With no explicit log path or voice selector, Desktop mode uses `latest`.
The explicit form is `--voice-thread-id latest`; a chat UUID pins the destination across recordings.
`latest` selects the eligible sidebar chat with the most recent user activity
across projects at the start of each recording. Hidden subagent, guardian, and
headless app-server logs are excluded. Assistant and tool writes do not change
that ordering. Selection reads Desktop's local recency database without
modifying it and fails if that ordering cannot be read. The selected chat
stays fixed through transcription, submission, approvals, and response streaming.

The Desktop CLI enables `--desktop-session-log latest` by default. It watches
user chats across projects, regardless of the folder where the bridge starts.
New logs are read from byte zero, including an approval written before the
first poll. A new chat does not need a voice turn to start sending activity
and approval prompts to the stick. Hidden subagents, guardian chats and private
app-server logs are excluded; old history is not replayed at bridge startup.

Use `--desktop-session-log /path/to/rollout.jsonl` to watch one chat. That path
also selects the voice chat unless you supply a voice selector. Embedded
callers can pass `cwd` to restrict monitoring to one workspace. Proxy/private
CLI modes still require an explicit log option to enable this watcher.
Log following supplies lifecycle and final activity entries, without live
assistant deltas; voice-target selection remains separate.
See [voice behavior](device-guide.md#voice-input).

## Approval matching and retries

Device decisions map `once` to Codex `accept` and `deny` to `decline`. For
approvals received from the connected Desktop owner, the bridge waits for that
owner to acknowledge the decision before clearing the card. Repeated frames
for the same prompt and decision share one in-flight operation; conflicting
decisions are rejected.

For a session-log approval, the bridge follows the exact chat UUID and requires
one matching pending command approval. The live snapshot must match the log's
turn ID, approval reason, and parsed command. The decision uses the pending
app-server request ID and owning Desktop client ID. Ambiguous, stale, or
mismatched requests are rejected.

A failure before dispatch allows a retry. Once a session-log decision was
dispatched, an ambiguous timeout or lost response leaves it locked until
correlated log output resolves the prompt. A successful dispatch acknowledgement
also leaves that card visible until the corresponding log output arrives.
The firmware re-enables A/B on a negative acknowledgement; the bridge still
checks the dispatch lock. See the [permission protocol](protocol.md#permission-response).

## Explicit proxy and headless modes

For an IDE that exposes an app-server control socket, specify its actual path:

```bash
node --env-file=.env ./bin/codex-buddy.js \
  --codex-proxy --codex-sock /path/to/app-server.sock
```

`--codex-sock auto` selects the newest socket under `$TMPDIR/codex-ipc`; with
multiple IDEs running, that socket may belong to another client. A proxy error
is reported without switching to a private server.

For a separate headless app-server, opt in explicitly:

```bash
node --env-file=.env ./bin/codex-buddy.js --private-app-server
```

This process has its own live event stream. Both modes invoke the `codex`
binary; use `--codex-bin PATH` to override it. Proxy and private modes are
mutually exclusive. Add the README's LAN listener options for a physical stick.

## Device transport and output

Current firmware sends control messages and small base64 audio frames over
one authenticated TCP connection on port `8787`. The bridge also accepts
session-bound UDP from older firmware, matched to the authenticated session
and device address. Idle transcription connections recover in the background;
navigation taps reuse a healthy connection when no audio was sent.

The device sends 16 kHz mono PCM; the bridge streams a 24 kHz conversion to
Realtime. Defaults are `gpt-live-transcribe`, language `en`, and delay `low`.
Host overrides are `--voice-model` or `CODEX_BUDDY_VOICE_MODEL`,
`CODEX_BUDDY_VOICE_LANGUAGE`, and `CODEX_BUDDY_VOICE_DELAY`.
See [audio framing and limits](protocol.md#onboard-voice-audio).

Assistant previews replace the previous text, retain at most 640 UTF-8 bytes
from the newest tail, and update at most once per item every 125 ms. Serialized
frames remain below the device's 1024-byte line limit. Completed cards remain
for 30 seconds; a streaming card expires after 60 seconds without a replacement.
Button B scrolls retained rows and renews the completed card's reading window.
See [completion events and display priority](protocol.md#assistant-response-stream).
