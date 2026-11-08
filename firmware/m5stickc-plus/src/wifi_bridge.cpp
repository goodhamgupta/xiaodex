#include "wifi_bridge.h"
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <Preferences.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <lwip/sockets.h>
#include <errno.h>
#include <string.h>

#include "voice_udp_policy.h"

#if __has_include("codex_buddy_config.h")
#include "codex_buddy_config.h"
#endif

#ifndef CODEX_BUDDY_WIFI_SSID
#define CODEX_BUDDY_WIFI_SSID ""
#endif
#ifndef CODEX_BUDDY_WIFI_PASSWORD
#define CODEX_BUDDY_WIFI_PASSWORD ""
#endif
#ifndef CODEX_BUDDY_BRIDGE_HOST
#define CODEX_BUDDY_BRIDGE_HOST ""
#endif
#ifndef CODEX_BUDDY_BRIDGE_PORT
#define CODEX_BUDDY_BRIDGE_PORT 8787
#endif
#ifndef CODEX_BUDDY_TOKEN
#define CODEX_BUDDY_TOKEN ""
#endif

static const size_t RX_CAP = 2048;
static uint8_t rxBuf[RX_CAP];
// Includes a 960-byte PCM chunk encoded as base64, its metadata and delimiter.
static const size_t TX_LINE_CAP = 1536;
static uint8_t txLineBuf[TX_LINE_CAP];
static const size_t VOICE_UDP_HEADER_BYTES = 18;
static const uint16_t VOICE_UDP_MAX_PCM_BYTES = 960;
// The 200 ms hold pre-roll is released as a short burst. The ESP32 UDP socket
// can transiently fill before the radio drains that burst. The PCM queue has
// about 600 ms of free headroom after normal pre-roll, so let the same packet
// wait for Wi-Fi TX buffers without dropping a sequence number.
static const uint32_t VOICE_UDP_SEND_TIMEOUT_MS = 400;
static const uint32_t VOICE_UDP_LOCK_TIMEOUT_MS = 400;
static volatile size_t rxHead = 0;
static volatile size_t rxTail = 0;

static WiFiClient client;
static WiFiUDP voiceUdp;
static IPAddress voiceUdpRemote;
static uint16_t voiceUdpPort = 0;
static bool voiceUdpActive = false;
static uint32_t voiceUdpGeneration = 0;
static uint32_t voiceUdpSlowLogAt = 0;
static uint16_t voiceUdpSlowSuppressed = 0;
static char deviceName[32] = "Codex";
static char wifiSsid[33] = "";
static char wifiPassword[65] = "";
static char bridgeHost[65] = "";
static char bridgeToken[97] = "";
static uint16_t bridgePort = CODEX_BUDDY_BRIDGE_PORT;
static bool configLoaded = false;
static uint32_t lastWifiAttempt = 0;
static uint32_t lastBridgeAttempt = 0;
static char status[32] = "wifi disabled";
static bool enabled = false;
static bool lowLatency = false;
static volatile uint32_t connectionGeneration = 0;
static volatile bool clientConnected = false;
static SemaphoreHandle_t clientMutex = nullptr;
static SemaphoreHandle_t voiceUdpMutex = nullptr;
static portMUX_TYPE rxMux = portMUX_INITIALIZER_UNLOCKED;

static void resetInbound(bool bumpGeneration = true) {
  portENTER_CRITICAL(&rxMux);
  rxHead = 0;
  rxTail = 0;
  if (bumpGeneration) connectionGeneration++;
  portEXIT_CRITICAL(&rxMux);
}

static void rxPush(uint8_t b) {
  portENTER_CRITICAL(&rxMux);
  size_t next = (rxHead + 1) % RX_CAP;
  if (next != rxTail) {
    rxBuf[rxHead] = b;
    rxHead = next;
  }
  portEXIT_CRITICAL(&rxMux);
}

static bool rxHasSpace() {
  portENTER_CRITICAL(&rxMux);
  bool available = ((rxHead + 1) % RX_CAP) != rxTail;
  portEXIT_CRITICAL(&rxMux);
  return available;
}

static bool ensureClientMutex() {
  if (clientMutex) return true;
  clientMutex = xSemaphoreCreateMutex();
  return clientMutex != nullptr;
}

static bool lockClient(TickType_t timeout = portMAX_DELAY) {
  return ensureClientMutex() &&
         xSemaphoreTake(clientMutex, timeout) == pdTRUE;
}

static void unlockClient() {
  if (clientMutex) xSemaphoreGive(clientMutex);
}

static bool ensureVoiceUdpMutex() {
  if (voiceUdpMutex) return true;
  voiceUdpMutex = xSemaphoreCreateMutex();
  return voiceUdpMutex != nullptr;
}

static bool lockVoiceUdp(TickType_t timeout = portMAX_DELAY) {
  return ensureVoiceUdpMutex() &&
         xSemaphoreTake(voiceUdpMutex, timeout) == pdTRUE;
}

static void unlockVoiceUdp() {
  if (voiceUdpMutex) xSemaphoreGive(voiceUdpMutex);
}

static bool connectedUnlocked() {
  return enabled && clientConnected && WiFi.status() == WL_CONNECTED &&
         client.fd() >= 0;
}

static void deactivateVoiceUdpLocked() {
  voiceUdpRemote = IPAddress();
  voiceUdpPort = 0;
  voiceUdpActive = false;
  voiceUdpGeneration = 0;
}

static void stopVoiceUdpLocked() {
  deactivateVoiceUdpLocked();
  voiceUdp.stop();
}

static void stopClientUnlocked() {
  // Invalidate the generation before waiting for an in-flight UDP send. The
  // voice worker checks it between retries and cannot keep an old session
  // alive after this TCP connection closes. Lock order is client, then UDP;
  // UDP send code never acquires the client lock.
  clientConnected = false;
  client.stop();
  resetInbound();
  if (lockVoiceUdp()) {
    stopVoiceUdpLocked();
    unlockVoiceUdp();
  }
}

static size_t sendNonblockingUnlocked(const uint8_t* data, size_t len,
                                      uint32_t timeoutMs) {
  if (!connectedUnlocked() || !data || len == 0) return 0;
  const int socketFd = client.fd();
  const uint32_t startedAt = millis();
  size_t written = 0;
  while (written < len) {
    int n = send(socketFd, data + written, len - written, MSG_DONTWAIT);
    if (n > 0) {
      written += (size_t)n;
      continue;
    }
    if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK &&
        errno != EINTR) {
      break;
    }
    if ((uint32_t)(millis() - startedAt) >= timeoutMs) break;
    // Yield to lwIP without entering WiFiClient::write's ten one-second
    // select retries. Voice uses a deadline shorter than the RX DMA cushion.
    vTaskDelay(1);
  }
  return written;
}

static bool looksLikePlaceholderSsid(const char* ssid) {
  return strcmp(ssid, "your-wifi") == 0 || strncmp(ssid, "TODO", 4) == 0;
}

static bool validBridgeToken(const char* token) {
  if (!token) return false;
  size_t len = strlen(token);
  if (len < 16 || len > 96) return false;
  for (size_t i = 0; i < len; i++) {
    char c = token[i];
    bool safe = (c >= 'a' && c <= 'z') ||
                (c >= 'A' && c <= 'Z') ||
                (c >= '0' && c <= '9') ||
                c == '.' || c == '_' || c == '~' || c == '-';
    if (!safe) return false;
  }
  return true;
}

static bool validVoiceSession(const char* session) {
  if (!session || session[8] != 0) return false;
  for (size_t i = 0; i < 8; i++) {
    const char c = session[i];
    if (!((c >= '0' && c <= '9') ||
          (c >= 'a' && c <= 'f') ||
          (c >= 'A' && c <= 'F'))) {
      return false;
    }
  }
  return true;
}

static bool validBridgeEndpoint(const char* host, uint16_t port,
                                const char* token) {
  return host && host[0] && strlen(host) <= 64 && port > 0 &&
         validBridgeToken(token);
}

template<size_t N>
static void copyConfig(char (&out)[N], const char* value) {
  strncpy(out, value ? value : "", N - 1);
  out[N - 1] = 0;
}

static void loadConfig() {
  if (configLoaded) return;
  configLoaded = true;
  copyConfig(wifiSsid, CODEX_BUDDY_WIFI_SSID);
  copyConfig(wifiPassword, CODEX_BUDDY_WIFI_PASSWORD);
  copyConfig(bridgeHost, CODEX_BUDDY_BRIDGE_HOST);
  copyConfig(bridgeToken, CODEX_BUDDY_TOKEN);
  bridgePort = CODEX_BUDDY_BRIDGE_PORT;

  Preferences prefs;
  prefs.begin("buddy_wifi", true);
  if (prefs.getBool("disabled", false)) {
    wifiSsid[0] = wifiPassword[0] = bridgeHost[0] = bridgeToken[0] = 0;
    prefs.end();
    return;
  }
  if (prefs.getBool("configured", false)) {
    prefs.getString("ssid", wifiSsid, sizeof(wifiSsid));
    prefs.getString("password", wifiPassword, sizeof(wifiPassword));
    prefs.getString("host", bridgeHost, sizeof(bridgeHost));
    prefs.getString("token", bridgeToken, sizeof(bridgeToken));
    bridgePort = prefs.getUShort("port", CODEX_BUDDY_BRIDGE_PORT);
  }
  prefs.end();

  // A gitignored .env token injected at build time deliberately overrides the
  // older token in NVS. This permits safe credential rotation without asking
  // for or rewriting the already-provisioned Wi-Fi password.
  if (validBridgeToken(CODEX_BUDDY_TOKEN)) {
    copyConfig(bridgeToken, CODEX_BUDDY_TOKEN);
  }
}

bool wifiBridgeConfigured() {
  loadConfig();
  return strlen(wifiSsid) > 0 &&
         !looksLikePlaceholderSsid(wifiSsid) &&
         strlen(bridgeHost) > 0 &&
         bridgePort > 0 &&
         validBridgeToken(bridgeToken);
}

bool wifiBridgeConfigure(const char* ssid, const char* password,
                         const char* host, uint16_t port, const char* token) {
  if (!ssid || !ssid[0] || strlen(ssid) > 32 || looksLikePlaceholderSsid(ssid) ||
      !password || strlen(password) > 64 ||
      !validBridgeEndpoint(host, port, token)) {
    return false;
  }

  copyConfig(wifiSsid, ssid);
  copyConfig(wifiPassword, password);
  copyConfig(bridgeHost, host);
  copyConfig(bridgeToken, token);
  bridgePort = port;
  configLoaded = true;

  Preferences prefs;
  prefs.begin("buddy_wifi", false);
  prefs.putBool("disabled", false);
  bool ok = prefs.putString("ssid", wifiSsid) > 0;
  ok = prefs.putString("password", wifiPassword) == strlen(wifiPassword) && ok;
  ok = prefs.putString("host", bridgeHost) > 0 && ok;
  ok = prefs.putString("token", bridgeToken) > 0 && ok;
  ok = prefs.putUShort("port", bridgePort) == sizeof(uint16_t) && ok;
  ok = prefs.putBool("configured", true) == sizeof(bool) && ok;
  prefs.end();
  if (!ok) return false;

  if (lockClient()) {
    stopClientUnlocked();
    unlockClient();
  }
  WiFi.disconnect(false);
  enabled = true;
  lastWifiAttempt = 0;
  lastBridgeAttempt = 0;
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(true);
  lowLatency = false;
  strncpy(status, "wifi configured", sizeof(status) - 1);
  status[sizeof(status) - 1] = 0;
  return true;
}

bool wifiBridgeConfigureEndpoint(const char* host, uint16_t port,
                                 const char* token) {
  if (!validBridgeEndpoint(host, port, token)) return false;
  loadConfig();

  // Bridge-only provisioning is deliberately limited to devices that already
  // have a complete runtime profile in NVS. A compile-time SSID is not enough:
  // marking a partial NVS record configured would erase that fallback on the
  // next boot. Reading the SSID here is only a validity check; neither it nor
  // the password key is written below.
  Preferences prefs;
  if (!prefs.begin("buddy_wifi", false)) return false;
  char storedSsid[33] = "";
  prefs.getString("ssid", storedSsid, sizeof(storedSsid));
  bool hasWifiProfile = prefs.getBool("configured", false) &&
                        !prefs.getBool("disabled", false) &&
                        storedSsid[0] &&
                        !looksLikePlaceholderSsid(storedSsid);
  if (!hasWifiProfile) {
    prefs.end();
    return false;
  }

  bool ok = prefs.putString("host", host) == strlen(host);
  ok = prefs.putString("token", token) == strlen(token) && ok;
  ok = prefs.putUShort("port", port) == sizeof(uint16_t) && ok;
  prefs.end();
  if (!ok) return false;

  copyConfig(bridgeHost, host);
  copyConfig(bridgeToken, token);
  bridgePort = port;
  configLoaded = true;

  // Keep the current Wi-Fi association and force only the TCP bridge socket
  // to reconnect to the new endpoint.
  if (lockClient()) {
    stopClientUnlocked();
    unlockClient();
  }
  lastBridgeAttempt = 0;
  strncpy(status, "bridge configured", sizeof(status) - 1);
  status[sizeof(status) - 1] = 0;
  return true;
}

void wifiBridgeClearConfig() {
  Preferences prefs;
  prefs.begin("buddy_wifi", false);
  prefs.clear();
  prefs.putBool("disabled", true);
  prefs.end();
  wifiSsid[0] = wifiPassword[0] = bridgeHost[0] = bridgeToken[0] = 0;
  bridgePort = CODEX_BUDDY_BRIDGE_PORT;
  configLoaded = true;
  enabled = false;
  if (lockClient()) {
    stopClientUnlocked();
    unlockClient();
  }
  WiFi.disconnect(false);
  strncpy(status, "wifi no config", sizeof(status) - 1);
  status[sizeof(status) - 1] = 0;
}

void wifiBridgeInit(const char* name) {
  ensureClientMutex();
  ensureVoiceUdpMutex();
  if (name && name[0]) {
    strncpy(deviceName, name, sizeof(deviceName) - 1);
    deviceName[sizeof(deviceName) - 1] = 0;
  }
  if (!wifiBridgeConfigured()) {
    strncpy(status, "wifi no config", sizeof(status) - 1);
    status[sizeof(status) - 1] = 0;
    return;
  }
  enabled = true;
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  // The ESP32 Arduino stack aborts if WiFi modem sleep is disabled while BLE is active.
  WiFi.setSleep(true);
  lowLatency = false;
  strncpy(status, "wifi starting", sizeof(status) - 1);
  status[sizeof(status) - 1] = 0;
}

void wifiBridgeSetEnabled(bool on) {
  enabled = on;
  if (!enabled) {
    if (lockClient()) {
      stopClientUnlocked();
      unlockClient();
    }
    WiFi.disconnect(false);
    strncpy(status, "wifi off", sizeof(status) - 1);
    status[sizeof(status) - 1] = 0;
  }
}

void wifiBridgeSetLowLatency(bool on) {
  lowLatency = on;
  WiFi.setSleep(!lowLatency);
  Serial.printf("[wifi] modem sleep %s\n", lowLatency ? "disabled" : "enabled");
}

void wifiBridgeResetConnection() {
  if (lockClient()) {
    stopClientUnlocked();
    unlockClient();
  }
  lastBridgeAttempt = 0;
  strncpy(status, "bridge reconnect", sizeof(status) - 1);
  status[sizeof(status) - 1] = 0;
}

void wifiBridgePoll() {
  if (!enabled || !wifiBridgeConfigured()) return;

  uint32_t now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiAttempt > 10000 || lastWifiAttempt == 0) {
      lastWifiAttempt = now;
      if (!lockClient(0)) return;
      stopClientUnlocked();
      unlockClient();
      WiFi.begin(wifiSsid, wifiPassword);
      WiFi.setSleep(!lowLatency);
      strncpy(status, "wifi joining", sizeof(status) - 1);
      status[sizeof(status) - 1] = 0;
      Serial.println("[wifi] joining configured network");
    }
    return;
  }

  // Never stall Button A sampling or UI work behind TCP activity; the next
  // loop will poll RX. Voice UDP uses its own mutex.
  if (!lockClient(0)) return;

  if (!client.connected()) {
    if (clientConnected) stopClientUnlocked();
    if (now - lastBridgeAttempt > 3000 || lastBridgeAttempt == 0) {
      lastBridgeAttempt = now;
      client.stop();
      snprintf(status, sizeof(status), "wifi %s", WiFi.localIP().toString().c_str());
      Serial.printf("[wifi] connecting to %s:%u\n", bridgeHost, bridgePort);
      if (client.connect(bridgeHost, bridgePort, 250)) {
        clientConnected = true;
        client.setNoDelay(true);
        // Bytes from a half-received JSON line on the previous TCP socket must
        // never be combined with frames from this new authenticated socket.
        resetInbound();
        char hello[192];
        int len = snprintf(hello, sizeof(hello),
          "{\"name\":\"%s\",\"token\":\"%s\"}\n",
          deviceName, bridgeToken
        );
        if (len > 0 && len < (int)sizeof(hello) &&
            sendNonblockingUnlocked((const uint8_t*)hello, (size_t)len, 250) !=
                (size_t)len) {
          stopClientUnlocked();
          strncpy(status, "bridge retry", sizeof(status) - 1);
          status[sizeof(status) - 1] = 0;
          unlockClient();
          return;
        }
        strncpy(status, "bridge connected", sizeof(status) - 1);
        status[sizeof(status) - 1] = 0;
        Serial.println("[wifi] bridge connected");
      } else {
        clientConnected = false;
        strncpy(status, "bridge retry", sizeof(status) - 1);
        status[sizeof(status) - 1] = 0;
      }
    }
    unlockClient();
    return;
  }

  // Leave unread TCP bytes in WiFiClient when our ring is full. Reading and
  // silently dropping them corrupts JSON frames and can desynchronise a voice
  // session. dataPoll() drains the ring before the next pass.
  while (client.available() && rxHasSpace()) {
    int c = client.read();
    if (c < 0) break;
    rxPush((uint8_t)c);
  }
  unlockClient();
}

bool wifiBridgeConnected() {
  if (!enabled || !wifiBridgeConfigured() || WiFi.status() != WL_CONNECTED) {
    return false;
  }
  // A TCP frame may own this lock for a few milliseconds. The cached state is
  // authoritative during that window; reporting false would abort a healthy
  // capture.
  if (!lockClient(0)) return clientConnected;
  bool connected = client.connected();
  if (!connected && clientConnected) {
    stopClientUnlocked();
  } else {
    clientConnected = connected;
  }
  unlockClient();
  return connected;
}

const char* wifiBridgeStatus() {
  return status;
}

size_t wifiBridgeAvailable() {
  portENTER_CRITICAL(&rxMux);
  size_t available = (rxHead + RX_CAP - rxTail) % RX_CAP;
  portEXIT_CRITICAL(&rxMux);
  return available;
}

int wifiBridgeRead() {
  portENTER_CRITICAL(&rxMux);
  int b = -1;
  if (rxHead != rxTail) {
    b = rxBuf[rxTail];
    rxTail = (rxTail + 1) % RX_CAP;
  }
  portEXIT_CRITICAL(&rxMux);
  return b;
}

size_t wifiBridgeWrite(const uint8_t* data, size_t len) {
  if (!data || len == 0 || !lockClient()) return 0;
  size_t written = sendNonblockingUnlocked(data, len, 250);
  if (written != len) stopClientUnlocked();
  unlockClient();
  return written;
}

bool wifiBridgeWriteLine(const char* data, size_t len, uint32_t timeoutMs) {
  if (!data || len == 0 || len + 1 > sizeof(txLineBuf)) return false;
  const uint32_t startedAt = millis();
  TickType_t lockTicks = pdMS_TO_TICKS(timeoutMs);
  if (timeoutMs > 0 && lockTicks == 0) lockTicks = 1;
  if (!lockClient(lockTicks)) return false;
  if (!connectedUnlocked()) {
    unlockClient();
    return false;
  }

  // The socket mutex also protects this shared staging buffer. Send each
  // control body and delimiter as one logical TCP write.
  memcpy(txLineBuf, data, len);
  txLineBuf[len] = '\n';

  const uint32_t lockElapsed = millis() - startedAt;
  if (lockElapsed >= timeoutMs) {
    unlockClient();
    return false;
  }
  const uint32_t bodyBudget = timeoutMs - lockElapsed;
  size_t written = sendNonblockingUnlocked(txLineBuf, len + 1, bodyBudget);
  bool ok = written == len + 1;
  if (!ok) {
    Serial.printf(
      "[wifi] frame body stalled: %u/%u bytes in %lums errno=%d\n",
      (unsigned)written,
      (unsigned)(len + 1),
      (unsigned long)(millis() - startedAt),
      errno
    );
  } else {
    const uint32_t elapsed = millis() - startedAt;
    if (elapsed >= 20) {
      Serial.printf("[wifi] frame sent: %u bytes in %lums\n",
                    (unsigned)(len + 1), (unsigned long)elapsed);
    }
  }
  if (!ok) {
    // A failed body/newline pair leaves framing ambiguous. Reconnect before
    // accepting another frame so the bridge never sees concatenated JSON.
    stopClientUnlocked();
    lastBridgeAttempt = 0;
    strncpy(status, "bridge reconnect", sizeof(status) - 1);
    status[sizeof(status) - 1] = 0;
  }
  unlockClient();
  return ok;
}

bool wifiBridgeVoiceUdpBegin() {
  if (!lockClient(pdMS_TO_TICKS(VOICE_UDP_LOCK_TIMEOUT_MS))) {
    Serial.println("[wifi] UDP begin failed: TCP lock timeout");
    return false;
  }
  // Keep one socket and its 1,460-byte staging buffer across voice turns. This
  // avoids heap churn and, critically, does not discard datagrams that lwIP
  // has already accepted from the preceding turn.
  if (!connectedUnlocked()) {
    unlockClient();
    Serial.println("[wifi] UDP begin failed: bridge disconnected");
    return false;
  }
  if (!lockVoiceUdp(pdMS_TO_TICKS(VOICE_UDP_LOCK_TIMEOUT_MS))) {
    unlockClient();
    Serial.println("[wifi] UDP begin failed: socket lock timeout");
    return false;
  }

  // Reuse the address already resolved by the authenticated TCP connection.
  // WiFiUDP::beginPacket() opens its ephemeral socket lazily on the first PCM
  // datagram, avoiding DNS and an unnecessary local begin()/bind cycle.
  const uint32_t generation = connectionGeneration;
  if (voiceUdpGeneration != 0 && voiceUdpGeneration != generation) {
    voiceUdp.stop();
  }
  deactivateVoiceUdpLocked();
  voiceUdpRemote = client.remoteIP();
  voiceUdpPort = bridgePort;
  voiceUdpActive = (uint32_t)voiceUdpRemote != 0 && voiceUdpPort != 0;
  voiceUdpGeneration = voiceUdpActive ? generation : 0;
  voiceUdpSlowLogAt = 0;
  voiceUdpSlowSuppressed = 0;
  const bool ready = voiceUdpActive;
  if (ready) {
    Serial.printf(
        "[wifi] UDP ready gen=%lu rssi=%ld heap=%u largest=%u\n",
        (unsigned long)voiceUdpGeneration, (long)WiFi.RSSI(),
        (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap());
  }
  unlockVoiceUdp();
  unlockClient();
  if (!ready) Serial.println("[wifi] UDP begin failed: invalid bridge endpoint");
  return ready;
}

static const char* voiceUdpStageName(voice_udp_policy::Stage stage) {
  switch (stage) {
    case voice_udp_policy::Stage::State: return "state";
    case voice_udp_policy::Stage::Begin: return "begin";
    case voice_udp_policy::Stage::Header: return "header";
    case voice_udp_policy::Stage::Payload: return "payload";
    case voice_udp_policy::Stage::End: return "end";
  }
  return "send";
}

static void logVoiceUdpFailure(voice_udp_policy::Stage stage,
                               uint32_t sequence,
                               int error, uint32_t elapsed) {
  const int wifiState = (int)WiFi.status();
  const long rssi = wifiState == WL_CONNECTED ? WiFi.RSSI() : 0;
  Serial.printf(
      "[wifi] UDP %s failed seq=%lu after=%lums errno=%d wifi=%d "
      "rssi=%ld tcp=%u gen=%lu/%lu heap=%u largest=%u\n",
      voiceUdpStageName(stage), (unsigned long)sequence,
      (unsigned long)elapsed, error, wifiState, rssi,
      clientConnected ? 1U : 0U, (unsigned long)voiceUdpGeneration,
      (unsigned long)connectionGeneration, (unsigned)ESP.getFreeHeap(),
      (unsigned)ESP.getMaxAllocHeap());
}

bool wifiBridgeVoiceUdpWrite(const char* session, uint32_t sequence,
                             const uint8_t* pcm, uint16_t len) {
  if (!validVoiceSession(session) || !pcm || len == 0 ||
      len > VOICE_UDP_MAX_PCM_BYTES || (len & 1) != 0) {
    Serial.printf("[wifi] UDP input rejected seq=%lu len=%u\n",
                  (unsigned long)sequence, (unsigned)len);
    return false;
  }
  if (!lockVoiceUdp(pdMS_TO_TICKS(VOICE_UDP_LOCK_TIMEOUT_MS))) {
    Serial.printf(
        "[wifi] UDP socket lock timeout seq=%lu wifi=%d tcp=%u gen=%lu "
        "heap=%u\n",
        (unsigned long)sequence, (int)WiFi.status(),
        clientConnected ? 1U : 0U, (unsigned long)connectionGeneration,
        (unsigned)ESP.getFreeHeap());
    return false;
  }

  const uint32_t startedAt = millis();
  if (!voiceUdpActive || voiceUdpGeneration == 0 ||
      voiceUdpGeneration != connectionGeneration || !clientConnected ||
      WiFi.status() != WL_CONNECTED) {
    logVoiceUdpFailure(voice_udp_policy::Stage::State, sequence, ENOTCONN,
                       millis() - startedAt);
    stopVoiceUdpLocked();
    unlockVoiceUdp();
    return false;
  }

  uint8_t header[VOICE_UDP_HEADER_BYTES] = {'X', 'D', 'V', '1'};
  memcpy(header + 4, session, 8);
  header[12] = (uint8_t)(sequence >> 24);
  header[13] = (uint8_t)(sequence >> 16);
  header[14] = (uint8_t)(sequence >> 8);
  header[15] = (uint8_t)sequence;
  header[16] = (uint8_t)(len >> 8);
  header[17] = (uint8_t)len;

  bool ok = false;
  bool reopened = false;
  bool packetStaged = false;
  uint16_t attempts = 0;
  int sendError = 0;
  voice_udp_policy::Stage failureStage = voice_udp_policy::Stage::Begin;
  do {
    attempts++;
    if (!voiceUdpActive || voiceUdpGeneration != connectionGeneration ||
        !clientConnected || WiFi.status() != WL_CONNECTED) {
      sendError = ENOTCONN;
      failureStage = voice_udp_policy::Stage::State;
      break;
    }

    errno = 0;
    if (!packetStaged) {
      if (voiceUdp.beginPacket(voiceUdpRemote, voiceUdpPort) != 1) {
        sendError = errno ? errno : ENOMEM;
        failureStage = voice_udp_policy::Stage::Begin;
      } else if (voiceUdp.write(header, sizeof(header)) != sizeof(header)) {
        sendError = errno ? errno : EIO;
        failureStage = voice_udp_policy::Stage::Header;
      } else if (voiceUdp.write(pcm, len) != len) {
        sendError = errno ? errno : EIO;
        failureStage = voice_udp_policy::Stage::Payload;
      } else {
        packetStaged = true;
      }
    }
    if (packetStaged && voiceUdp.endPacket() != 1) {
      sendError = errno ? errno : EIO;
      failureStage = voice_udp_policy::Stage::End;
    } else if (packetStaged) {
      ok = true;
      break;
    }

    const uint32_t elapsed = millis() - startedAt;
    const voice_udp_policy::Action action = voice_udp_policy::decide(
        failureStage, sendError, reopened, elapsed,
        VOICE_UDP_SEND_TIMEOUT_MS);
    if (action == voice_udp_policy::Action::Reopen) {
      Serial.printf("[wifi] UDP socket reopen seq=%lu stage=%s errno=%d\n",
                    (unsigned long)sequence,
                    voiceUdpStageName(failureStage), sendError);
      voiceUdp.stop();
      reopened = true;
      packetStaged = false;
      vTaskDelay(1);
      continue;
    }
    if (action != voice_udp_policy::Action::Retry) break;
    vTaskDelay(1);
  } while (true);

  const uint32_t elapsed = millis() - startedAt;
  if (ok && elapsed >= 10) {
    const uint32_t now = millis();
    if (voiceUdpSlowLogAt == 0 ||
        (uint32_t)(now - voiceUdpSlowLogAt) >= 1000) {
      Serial.printf(
          "[wifi] UDP pressure recovered seq=%lu after=%lums attempts=%u "
          "errno=%d reopen=%u rssi=%ld heap=%u suppressed=%u\n",
          (unsigned long)sequence, (unsigned long)elapsed, (unsigned)attempts,
          sendError, reopened ? 1U : 0U, (long)WiFi.RSSI(),
          (unsigned)ESP.getFreeHeap(), (unsigned)voiceUdpSlowSuppressed);
      voiceUdpSlowLogAt = now;
      voiceUdpSlowSuppressed = 0;
    } else if (voiceUdpSlowSuppressed < UINT16_MAX) {
      voiceUdpSlowSuppressed++;
    }
  } else if (!ok) {
    logVoiceUdpFailure(failureStage, sequence, sendError, elapsed);
  }
  // A terminal send failure can leave the socket itself unusable. This turn
  // is already failing, so close it fully; successful turns keep the socket
  // open to let accepted trailing datagrams drain and to avoid heap churn.
  if (!ok) stopVoiceUdpLocked();
  unlockVoiceUdp();
  return ok;
}

void wifiBridgeVoiceUdpEnd() {
  // Deactivate the destination at the lifecycle boundary, but keep the socket
  // open so close() cannot discard trailing datagrams already accepted by
  // lwIP. TCP/Wi-Fi disconnect paths still close it completely.
  if (!lockVoiceUdp()) return;
  deactivateVoiceUdpLocked();
  unlockVoiceUdp();
}

uint32_t wifiBridgeConnectionGeneration() {
  return connectionGeneration;
}
