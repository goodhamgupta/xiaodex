#pragma once

#include <ArduinoJson.h>

// Handle the USB-only host control protocol. The caller is responsible for
// invoking this before xferCommand(), whose idle fallback consumes unknown
// command frames.
bool deviceControlCommand(JsonDocument& doc);

// A capture is deliberately streamed over several loop iterations so network
// polling and the watchdog remain healthy. While true, callers must not mutate
// the sprite framebuffer.
bool deviceControlCaptureActive();
void deviceControlCapturePoll();
void deviceControlFramePresented();
