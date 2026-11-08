#include <assert.h>
#include <string.h>
#include "../src/voice_tcp_frame.h"

int main() {
  char frame[voice_tcp::FRAME_CAP];
  uint8_t pcm[962] = {0, 1, 2, 3, 4, 5};
  assert(voice_tcp::encode(frame, sizeof(frame), "1234abcd", 0, pcm, 2));
  assert(strstr(frame, "\"data\":\"AAE=\"}"));
  assert(voice_tcp::encode(frame, sizeof(frame), "1234abcd", 1, pcm, 4));
  assert(strstr(frame, "\"data\":\"AAECAw==\"}"));
  assert(voice_tcp::encode(frame, sizeof(frame), "1234abcd", 2, pcm, 6));
  assert(strstr(frame, "\"data\":\"AAECAwQF\"}"));
  const size_t n = voice_tcp::encode(frame, sizeof(frame), "1234abcd", UINT32_MAX, pcm, 960);
  assert(n > 1280 && n < sizeof(frame) && strlen(frame) == n);
  assert(!voice_tcp::encode(frame, n, "1234abcd", UINT32_MAX, pcm, 960));
  assert(!voice_tcp::encode(frame, sizeof(frame), "bad-id", 0, pcm, 2));
  assert(!voice_tcp::encode(frame, sizeof(frame), "1234abcd", 0, pcm, 0));
  assert(!voice_tcp::encode(frame, sizeof(frame), "1234abcd", 0, pcm, 3));
  assert(!voice_tcp::encode(frame, sizeof(frame), "1234abcd", 0, pcm, 962));
}
