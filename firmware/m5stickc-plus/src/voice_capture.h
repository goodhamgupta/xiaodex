#pragma once

#include <Arduino.h>

enum VoiceCaptureEvent : uint8_t {
  VOICE_CAPTURE_EVENT_NONE = 0,
  VOICE_CAPTURE_EVENT_AUTO_STOP,
  VOICE_CAPTURE_EVENT_ERROR,
};

// Captures the M5StickC Plus SPM1423 PDM microphone as 16 kHz, 16-bit mono
// PCM. TCP carries the authenticated voice lifecycle; after its start ACK,
// every 30 ms PCM chunk is streamed as one raw UDP datagram. A bounded live
// queue is retained, but the complete recording is never buffered on-device.
// Call once during boot to validate the microphone and initialize the worker.
bool voiceCaptureInit();
// Starts a bounded local pre-roll and schedules asynchronous remote-session
// pre-warm after a short debounce. Used on Button A's press edge so a hold
// retains its first syllable without blocking button/UI sampling. A very short
// navigation tap is discarded before any remote session is created.
bool voiceCaptureArm();
// Confirms the A-button hold and begins flushing PCM to the pre-warmed session.
bool voiceCaptureStart();
bool voiceCaptureRetryStart();
bool voiceCaptureConfirmStart();
VoiceCaptureEvent voiceCapturePoll();
bool voiceCaptureStop();
// `force` lets a lost start-ACK timeout replace an already-latched normal stop
// so queued PCM cannot wait forever behind the unopened UDP forwarding gate.
bool voiceCaptureCancel(bool force = false);
void voiceCaptureAbort();

bool voiceCaptureActive();
bool voiceCaptureStreaming();
const char* voiceCaptureError();
const char* voiceCaptureSession();
uint32_t voiceCaptureSamples();
