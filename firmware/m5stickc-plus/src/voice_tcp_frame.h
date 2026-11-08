#pragma once
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace voice_tcp {
constexpr size_t MAX_PCM_BYTES = 960;
constexpr size_t FRAME_CAP = 1408;

// Serialize one 30 ms PCM chunk. Never allocate or encode a whole recording.
inline size_t encode(char* out, size_t cap, const char* session, uint32_t seq,
                     const uint8_t* pcm, size_t len) {
  if (!out || !pcm || !session || strlen(session) != 8 ||
      len == 0 || len > MAX_PCM_BYTES || (len & 1)) return 0;
  for (unsigned i = 0; i < 8; ++i) {
    const char c = session[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
          (c >= 'A' && c <= 'F'))) return 0;
  }
  const int prefix = snprintf(out, cap,
      "{\"cmd\":\"voice_audio\",\"session\":\"%s\",\"seq\":%lu,"
      "\"encoding\":\"base64\",\"data\":\"", session, (unsigned long)seq);
  const size_t encoded = ((len + 2) / 3) * 4;
  if (prefix < 0 || (size_t)prefix >= cap || cap - prefix < encoded + 3) return 0;
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t pos = (size_t)prefix;
  for (size_t i = 0; i < len; i += 3) {
    uint32_t word = (uint32_t)pcm[i] << 16;
    if (i + 1 < len) word |= (uint32_t)pcm[i + 1] << 8;
    if (i + 2 < len) word |= pcm[i + 2];
    out[pos++] = alphabet[(word >> 18) & 63];
    out[pos++] = alphabet[(word >> 12) & 63];
    out[pos++] = i + 1 < len ? alphabet[(word >> 6) & 63] : '=';
    out[pos++] = i + 2 < len ? alphabet[word & 63] : '=';
  }
  out[pos++] = '"';
  out[pos++] = '}';
  out[pos] = 0;
  return pos;
}
}
