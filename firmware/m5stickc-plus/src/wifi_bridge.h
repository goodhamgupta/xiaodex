#pragma once
#include <stdint.h>
#include <stddef.h>

void wifiBridgeInit(const char* deviceName);
void wifiBridgeSetEnabled(bool on);
// Only enable low latency when BLE has not been initialized. The legacy ESP32
// radio stack cannot safely disable Wi-Fi modem sleep while BLE is active.
void wifiBridgeSetLowLatency(bool on);
void wifiBridgeResetConnection();
void wifiBridgePoll();
bool wifiBridgeConfigured();
bool wifiBridgeConfigure(const char* ssid, const char* password,
                         const char* host, uint16_t port, const char* token);
// Retarget an already-provisioned device without reading or rewriting its
// saved Wi-Fi SSID/password. Returns false when no complete runtime Wi-Fi
// profile exists in NVS.
bool wifiBridgeConfigureEndpoint(const char* host, uint16_t port,
                                 const char* token);
void wifiBridgeClearConfig();
bool wifiBridgeConnected();
const char* wifiBridgeStatus();
size_t wifiBridgeAvailable();
int wifiBridgeRead();
size_t wifiBridgeWrite(const uint8_t* data, size_t len);
// Stages and writes one complete newline-delimited frame while holding the
// socket lock. Body and delimiter share one lwIP enqueue, and another core
// cannot splice bytes into a control frame.
bool wifiBridgeWriteLine(const char* data, size_t len,
                         uint32_t timeoutMs = 250);
// Opens a session-scoped UDP sender to the same resolved host and port as the
// authenticated TCP bridge. Each write emits one complete XDV1 PCM datagram.
bool wifiBridgeVoiceUdpBegin();
bool wifiBridgeVoiceUdpWrite(const char* session, uint32_t sequence,
                             const uint8_t* pcm, uint16_t len);
void wifiBridgeVoiceUdpEnd();
uint32_t wifiBridgeConnectionGeneration();
