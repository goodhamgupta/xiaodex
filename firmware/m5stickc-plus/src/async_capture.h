#pragma once
#include <Arduino.h>
#include <esp_heap_caps.h>
#include <mbedtls/base64.h>

// Compressed snapshot in word-addressable IRAM, with bounded allocation.
// UART output is line-framed and incremental so logs cannot corrupt pixels
// and the main loop can keep sampling physical approval/voice buttons.
class AsyncCapture {
 public:
  bool active() const { return phase != 0; }
  bool request(const char* requestId, unsigned w, unsigned h) {
    if (active()) return false;
    count = w * h;
    snprintf(id, sizeof(id), "%s", requestId);
    width = w; height = h; offset = 0; sequence = 0;
    encodedOffset = 0;
    crc = 0xFFFFFFFFu; requestedAt = millis(); phase = 1;
    return true;
  }
  void presented(const uint8_t* pixels) {
    if (phase != 1 || !pixels) return;
    encodedSize = 0;
    for (unsigned pos = 0; pos < count;) {
      unsigned n = 1;
      while (n < 255 && pos + n < count && pixels[pos + n] == pixels[pos]) n++;
      encodedSize += 2;
      pos += n;
    }
    if (capacity < encodedSize) {
      heap_caps_free(words);
      words = static_cast<uint32_t*>(heap_caps_malloc(
          ((encodedSize + 3) / 4) * 4,
          MALLOC_CAP_INTERNAL | MALLOC_CAP_32BIT | MALLOC_CAP_EXEC));
      capacity = words ? encodedSize : 0;
    }
    if (!words) { cancel("snapshot memory unavailable"); return; }
    unsigned encoded = 0;
    for (unsigned pos = 0; pos < count;) {
      uint8_t value = pixels[pos];
      unsigned n = 1;
      while (n < 255 && pos + n < count && pixels[pos + n] == value) n++;
      put(encoded++, n); put(encoded++, value);
      for (unsigned i = 0; i < n; i++) {
        crc ^= value;
        for (unsigned bit = 0; bit < 8; bit++)
          crc = (crc >> 1) ^ (0xEDB88320u & uint32_t(-int(crc & 1)));
      }
      pos += n;
    }
    capturedAt = millis(); phase = 2;
  }
  void cancel(const char* error) {
    if (!active()) return;
    char line[240];
    int len = snprintf(line, sizeof(line),
        "{\"ack\":\"capture_async\",\"id\":\"%s\",\"state\":\"error\",\"error\":\"%s\"}\n", id, error);
    if (len > 0 && len < int(sizeof(line))) Serial.write((uint8_t*)line, len);
    release();
  }
  void poll() {
    if (!active()) {
      if (words && millis() - requestedAt > 10000) dispose();
      return;
    }
    if (millis() - requestedAt > 15000) { cancel("capture timed out"); return; }
    if (phase == 1) return;
    char line[420];
    int len;
    unsigned nextOffset = offset;
    unsigned nextEncodedOffset = encodedOffset;
    if (phase == 2) {
      len = snprintf(line, sizeof(line),
          "{\"ack\":\"capture_async\",\"id\":\"%s\",\"state\":\"begin\",\"width\":%u,\"height\":%u,\"millis\":%u,\"format\":\"rgb332-rle\"}\n",
          id, width, height, capturedAt);
    } else if (phase == 3) {
      uint8_t runs[128];
      unsigned used = 0;
      while (nextEncodedOffset < encodedSize && used < sizeof(runs)) {
        unsigned n = pixel(nextEncodedOffset++);
        uint8_t value = pixel(nextEncodedOffset++);
        runs[used++] = n; runs[used++] = value;
        nextOffset += n;
      }
      char encoded[173]; size_t encodedLen = 0;
      if (mbedtls_base64_encode((uint8_t*)encoded, sizeof(encoded), &encodedLen,
                               runs, used) || encodedLen >= sizeof(encoded)) {
        cancel("capture encode failed"); return;
      }
      encoded[encodedLen] = 0;
      len = snprintf(line, sizeof(line),
          "{\"ack\":\"capture_async\",\"id\":\"%s\",\"state\":\"chunk\",\"seq\":%u,\"offset\":%u,\"data\":\"%s\"}\n",
          id, sequence, offset, encoded);
    } else {
      len = snprintf(line, sizeof(line),
          "{\"ack\":\"capture_async\",\"id\":\"%s\",\"state\":\"end\",\"pixels\":%u,\"chunks\":%u,\"crc32\":\"%08x\"}\n",
          id, count, sequence, unsigned(crc ^ 0xFFFFFFFFu));
    }
    if (len <= 0 || len >= int(sizeof(line))) { cancel("capture line overflow"); return; }
    if (Serial.availableForWrite() < len) return;
    Serial.write((const uint8_t*)line, len);
    if (phase == 2) phase = 3;
    else if (phase == 3) {
      offset = nextOffset; encodedOffset = nextEncodedOffset; sequence++;
      if (offset == count) phase = 4;
    } else release();
  }
  bool dispose() {
    if (active()) return false;
    heap_caps_free(words); words = nullptr; capacity = 0;
    return true;
  }
 private:
  uint8_t pixel(unsigned i) const { return (words[i / 4] >> (8 * (i % 4))) & 255; }
  void put(unsigned i, uint8_t value) {
    if (i % 4 == 0) words[i / 4] = value;
    else words[i / 4] |= uint32_t(value) << (8 * (i % 4));
  }
  void release() { phase = 0; requestedAt = millis(); }
  uint32_t* words = nullptr;
  unsigned width = 0, height = 0, count = 0, capacity = 0, offset = 0, sequence = 0;
  unsigned encodedSize = 0, encodedOffset = 0;
  uint32_t crc = 0, capturedAt = 0, requestedAt = 0;
  uint8_t phase = 0;
  char id[33] = "";
};
