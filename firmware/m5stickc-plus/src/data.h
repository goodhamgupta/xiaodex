#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include "ble_bridge.h"
#include "wifi_bridge.h"
#include "device_control.h"
#include "xfer.h"

struct TamaState {
  uint8_t  sessionsTotal;
  uint8_t  sessionsRunning;
  uint8_t  sessionsWaiting;
  uint8_t  petState;
  bool     petStateValid;
  bool     recentlyCompleted;
  uint32_t tokensTotal;
  uint32_t tokensToday;
  uint32_t lastUpdated;
  char     msg[24];
  bool     connected;
  char     lines[8][92];
  uint8_t  nLines;
  uint16_t lineGen;          // bumps when lines change — lets UI reset scroll
  char     promptId[40];     // pending permission request ID; empty = no prompt
  char     promptTool[20];
  char     promptHint[44];
  uint16_t permissionAckSeq;
  bool     permissionAckOk;
  uint16_t voiceAckSeq;
  bool     voiceAckOk;
  uint8_t  voiceAckSeconds;
  char     voiceAckSession[16];
  char     voiceAckState[16];
  bool     voiceAckHasText;
  char     voiceAckDetail[384];
  uint16_t assistantSeq;
  bool     assistantActive;
  bool     assistantStreaming;
  bool     assistantFinal;
  char     assistantThreadId[48];
  char     assistantTurnId[48];
  char     assistantItemId[48];
  // The bridge retains a bounded 640-byte answer tail. Leave room for the
  // terminator and future wire headroom so Button B can scroll several views.
  char     assistantText[768];
};

enum PetWireState {
  PET_WIRE_SLEEP = 0,
  PET_WIRE_IDLE = 1,
  PET_WIRE_BUSY = 2,
  PET_WIRE_ATTENTION = 3,
  PET_WIRE_CELEBRATE = 4,
  PET_WIRE_DIZZY = 5,
  PET_WIRE_HEART = 6,
};

// ---------------------------------------------------------------------------
// Three modes, checked in priority order:
//   demo   → auto-cycle fake scenarios every 8s, ignore live data
//   live   → JSON arrived in the last 10s over USB, BT, or WiFi
//   asleep → no data, all zeros, "No Codex connected"
// ---------------------------------------------------------------------------

static uint32_t _lastLiveMs = 0;
static uint32_t _lastBtByteMs = 0;   // hasClient() lies; track actual BT traffic
static uint32_t _lastWifiByteMs = 0;
static uint32_t _wifiConnectionGen = 0;
static bool     _demoMode   = false;
static uint8_t  _demoIdx    = 0;
static uint32_t _demoNext   = 0;

struct _Fake { const char* n; uint8_t t,r,w; bool c; uint32_t tok; };
static const _Fake _FAKES[] = {
  {"asleep",0,0,0,false,0}, {"one idle",1,0,0,false,12000},
  {"busy",4,3,0,false,89000}, {"attention",2,1,1,false,45000},
  {"completed",1,0,0,true,142000},
};

inline void dataSetDemo(bool on) {
  _demoMode = on;
  if (on) { _demoIdx = 0; _demoNext = millis(); }
}
inline bool dataDemo() { return _demoMode; }

inline bool dataConnected() {
  return _lastLiveMs != 0 && (millis() - _lastLiveMs) <= 30000;
}

inline bool dataBtActive() {
  // Desktop's idle keepalive is ~10s; give it 1.5x headroom.
  return _lastBtByteMs != 0 && (millis() - _lastBtByteMs) <= 15000;
}

inline bool dataWifiActive() {
  return _lastWifiByteMs != 0 && (millis() - _lastWifiByteMs) <= 15000;
}

inline const char* dataScenarioName() {
  if (_demoMode) return _FAKES[_demoIdx].n;
  if (dataConnected()) {
    if (dataWifiActive()) return "wifi";
    if (dataBtActive()) return "bt";
    return "usb";
  }
  return "none";
}

// Set true once the bridge sends a time sync — until then the RTC may
// hold whatever was on the coin cell (or 2000-01-01 if it lost power).
static bool _rtcValid = false;
inline bool dataRtcValid() { return _rtcValid; }

static int8_t _petStateFromName(const char* s) {
  if (!s) return -1;
  if (strcmp(s, "sleep") == 0) return PET_WIRE_SLEEP;
  if (strcmp(s, "idle") == 0) return PET_WIRE_IDLE;
  if (strcmp(s, "busy") == 0) return PET_WIRE_BUSY;
  if (strcmp(s, "attention") == 0) return PET_WIRE_ATTENTION;
  if (strcmp(s, "celebrate") == 0) return PET_WIRE_CELEBRATE;
  if (strcmp(s, "dizzy") == 0) return PET_WIRE_DIZZY;
  if (strcmp(s, "heart") == 0) return PET_WIRE_HEART;
  return -1;
}

static void _copyAssistantField(char* dst, size_t size, const char* src) {
  if (size == 0) return;
  strncpy(dst, src ? src : "", size - 1);
  dst[size - 1] = 0;
}

// The bridge sends cumulative previews. Keep the newest end when a response is
// longer than the fixed device buffer, and do not start on a UTF-8 continuation
// byte. The HUD likewise renders the newest wrapped rows.
static void _copyAssistantTextTail(char* dst, size_t size, const char* src) {
  if (size == 0) return;
  if (!src) {
    dst[0] = 0;
    return;
  }
  size_t len = strlen(src);
  const char* start = src;
  if (len >= size) {
    start += len - (size - 1);
    while (*start && ((uint8_t)*start & 0xC0) == 0x80) start++;
  }
  strncpy(dst, start, size - 1);
  dst[size - 1] = 0;
}

static void _applyJson(const char* line, TamaState* out, bool usbSource = false) {
  JsonDocument doc;
  if (deserializeJson(doc, line)) return;

  // `xferCommand` intentionally consumes unknown command frames while idle,
  // so assistant response frames must be handled before transfer dispatch.
  // They are control/UI traffic, never snapshots (and therefore must not
  // accidentally clear a pending approval).
  const char* cmd = doc["cmd"];
  if (usbSource && deviceControlCommand(doc)) {
    return;
  }

  if (cmd && strcmp(cmd, "assistant") == 0) {
    const char* state = doc["state"];
    bool streaming = state && strcmp(state, "streaming") == 0;
    bool completed = state && strcmp(state, "completed") == 0;
    if (streaming || completed) {
      out->assistantActive = true;
      out->assistantStreaming = streaming;
      const char* phase = doc["phase"];
      // Phase is nullable for legacy providers. Before phase existed,
      // item/completed represented the final visible answer, so preserve that
      // compatibility behavior unless the server explicitly says commentary.
      out->assistantFinal = completed &&
                            (!phase || !phase[0] ||
                             strcmp(phase, "final_answer") == 0);
      _copyAssistantField(out->assistantThreadId, sizeof(out->assistantThreadId),
                          doc["threadId"].as<const char*>());
      _copyAssistantField(out->assistantTurnId, sizeof(out->assistantTurnId),
                          doc["turnId"].as<const char*>());
      _copyAssistantField(out->assistantItemId, sizeof(out->assistantItemId),
                          doc["itemId"].as<const char*>());
      _copyAssistantTextTail(out->assistantText, sizeof(out->assistantText),
                             doc["text"].as<const char*>());
      out->assistantSeq++;
    }
    _lastLiveMs = millis();
    return;
  }

  // A USB `status` query is observational: unlike bridge snapshots and
  // transfer mutations, it must not make an idle device look connected.
  bool readOnlyStatus = cmd && strcmp(cmd, "status") == 0;
  if (xferCommand(doc, usbSource)) {
    if (!readOnlyStatus) _lastLiveMs = millis();
    return;
  }

  // Bridge sends {"time":[epoch_sec, tz_offset_sec]}; gmtime_r on the
  // adjusted epoch yields local components including weekday.
  JsonArray t = doc["time"];
  if (!t.isNull() && t.size() == 2) {
    time_t local = (time_t)t[0].as<uint32_t>() + (int32_t)t[1];
    struct tm lt; gmtime_r(&local, &lt);
    RTC_TimeTypeDef tm = { (uint8_t)lt.tm_hour, (uint8_t)lt.tm_min, (uint8_t)lt.tm_sec };
    RTC_DateTypeDef dt = { (uint8_t)lt.tm_wday, (uint8_t)(lt.tm_mon + 1),
                           (uint8_t)lt.tm_mday, (uint16_t)(lt.tm_year + 1900) };
    M5.Rtc.SetTime(&tm);
    M5.Rtc.SetDate(&dt);
    extern uint32_t _clkLastRead;
    _clkLastRead = 0;   // force re-read so _clkDt and _rtcValid agree
    _rtcValid = true;
    _lastLiveMs = millis();
    return;
  }

  const char* ack = doc["ack"];
  if (ack && strcmp(ack, "permission") == 0) {
    out->permissionAckOk = doc["ok"] | false;
    out->permissionAckSeq++;
    _lastLiveMs = millis();
    return;
  }

  if (ack && strcmp(ack, "voice") == 0) {
    out->voiceAckOk = doc["ok"] | false;
    out->voiceAckSeconds = doc["seconds"] | 0;

    const char* session = doc["session"];
    strncpy(out->voiceAckSession, session ? session : "", sizeof(out->voiceAckSession) - 1);
    out->voiceAckSession[sizeof(out->voiceAckSession) - 1] = 0;

    const char* state = doc["state"];
    if (!state || !state[0]) state = out->voiceAckOk ? "submitted" : "error";
    strncpy(out->voiceAckState, state, sizeof(out->voiceAckState) - 1);
    out->voiceAckState[sizeof(out->voiceAckState) - 1] = 0;

    const char* detail = doc["text"];
    out->voiceAckHasText = detail && detail[0];
    if (!detail || !detail[0]) detail = doc["error"];
    strncpy(out->voiceAckDetail, detail ? detail : "", sizeof(out->voiceAckDetail) - 1);
    out->voiceAckDetail[sizeof(out->voiceAckDetail) - 1] = 0;

    out->voiceAckSeq++;
    _lastLiveMs = millis();
    return;
  }

  // Successful per-chunk acks are intentionally quiet. A rejected chunk,
  // however, invalidates the ordered PCM stream and must stop recording.
  if (ack && strcmp(ack, "voice_audio") == 0) {
    bool ok = doc["ok"] | false;
    if (!ok) {
      out->voiceAckOk = false;
      out->voiceAckSeconds = 0;
      const char* session = doc["session"];
      strncpy(out->voiceAckSession, session ? session : "", sizeof(out->voiceAckSession) - 1);
      out->voiceAckSession[sizeof(out->voiceAckSession) - 1] = 0;
      strncpy(out->voiceAckState, "error", sizeof(out->voiceAckState) - 1);
      out->voiceAckState[sizeof(out->voiceAckState) - 1] = 0;
      out->voiceAckHasText = false;
      const char* error = doc["error"];
      strncpy(out->voiceAckDetail, error ? error : "audio chunk rejected",
              sizeof(out->voiceAckDetail) - 1);
      out->voiceAckDetail[sizeof(out->voiceAckDetail) - 1] = 0;
      out->voiceAckSeq++;
    }
    _lastLiveMs = millis();
    return;
  }

  // Authentication, status, and future command acknowledgements are control
  // traffic, not snapshots. Letting them fall through would treat their
  // missing `prompt` field as "clear the pending approval".
  if (ack) {
    _lastLiveMs = millis();
    return;
  }

  out->sessionsTotal     = doc["total"]     | out->sessionsTotal;
  out->sessionsRunning   = doc["running"]   | out->sessionsRunning;
  out->sessionsWaiting   = doc["waiting"]   | out->sessionsWaiting;
  out->recentlyCompleted = doc["completed"] | false;
  const char* petState = doc["pet_state"];
  if (!petState) {
    JsonObject pet = doc["pet"];
    petState = pet["state"];
  }
  int8_t ps = _petStateFromName(petState);
  if (ps >= 0) {
    out->petState = (uint8_t)ps;
    out->petStateValid = true;
  } else {
    out->petStateValid = false;
  }
  uint32_t bridgeTokens = doc["tokens"] | 0;
  if (doc["tokens"].is<uint32_t>()) {
    out->tokensTotal = bridgeTokens;
    statsOnBridgeTokens(bridgeTokens);
  }
  out->tokensToday = doc["tokens_today"] | out->tokensToday;
  const char* m = doc["msg"];
  if (m) { strncpy(out->msg, m, sizeof(out->msg)-1); out->msg[sizeof(out->msg)-1]=0; }
  JsonArray la = doc["entries"];
  if (!la.isNull()) {
    bool changed = false;
    uint8_t oldN = out->nLines;
    uint8_t n = 0;
    for (JsonVariant v : la) {
      if (n >= 8) break;
      const char* s = v.as<const char*>();
      if (n >= oldN || strcmp(out->lines[n], s ? s : "") != 0) changed = true;
      strncpy(out->lines[n], s ? s : "", 91); out->lines[n][91]=0;
      n++;
    }
    if (n != oldN) changed = true;
    if (changed) out->lineGen++;
    out->nLines = n;
  }
  JsonObject pr = doc["prompt"];
  if (!pr.isNull()) {
    const char* pid = pr["id"]; const char* pt = pr["tool"]; const char* ph = pr["hint"];
    strncpy(out->promptId,   pid ? pid : "", sizeof(out->promptId)-1);   out->promptId[sizeof(out->promptId)-1]=0;
    strncpy(out->promptTool, pt  ? pt  : "", sizeof(out->promptTool)-1); out->promptTool[sizeof(out->promptTool)-1]=0;
    strncpy(out->promptHint, ph  ? ph  : "", sizeof(out->promptHint)-1); out->promptHint[sizeof(out->promptHint)-1]=0;
  } else {
    out->promptId[0] = 0; out->promptTool[0] = 0; out->promptHint[0] = 0;
  }
  out->lastUpdated = millis();
  _lastLiveMs = millis();
}

template<size_t N>
struct _LineBuf {
  char buf[N];
  uint16_t len = 0;
  void feed(Stream& s, TamaState* out, bool usbSource = false) {
    while (s.available()) {
      char c = s.read();
      if (c == '\n' || c == '\r') {
        if (len > 0) {
          buf[len] = 0;
          if (buf[0] == '{') _applyJson(buf, out, usbSource);
          len = 0;
        }
      } else if (len < N-1) {
        buf[len++] = c;
      }
    }
  }
};

static _LineBuf<1024> _usbLine, _btLine, _wifiLine;

inline void dataPoll(TamaState* out) {
  uint32_t now = millis();

  if (_demoMode) {
    if (now >= _demoNext) { _demoIdx = (_demoIdx + 1) % 5; _demoNext = now + 8000; }
    const _Fake& s = _FAKES[_demoIdx];
    out->sessionsTotal=s.t; out->sessionsRunning=s.r; out->sessionsWaiting=s.w;
    out->recentlyCompleted=s.c; out->tokensTotal=s.tok; out->tokensToday=s.tok; out->lastUpdated=now;
    out->petState = s.w ? PET_WIRE_ATTENTION :
                    s.c ? PET_WIRE_CELEBRATE :
                    s.r ? PET_WIRE_BUSY :
                    s.t ? PET_WIRE_IDLE : PET_WIRE_SLEEP;
    out->petStateValid = true;
    out->connected = true;
    snprintf(out->msg, sizeof(out->msg), "demo: %s", s.n);
    return;
  }

  _usbLine.feed(Serial, out, true);
  wifiBridgePoll();
  uint32_t wifiConnectionGen = wifiBridgeConnectionGeneration();
  if (wifiConnectionGen != _wifiConnectionGen) {
    _wifiConnectionGen = wifiConnectionGen;
    _wifiLine.len = 0;
    _lastWifiByteMs = 0;
  }
  // BLE ring buffer is drained manually since it's not a Stream.
  while (bleAvailable()) {
    int c = bleRead();
    if (c < 0) break;
    _lastBtByteMs = millis();
    if (c == '\n' || c == '\r') {
      if (_btLine.len > 0) {
        _btLine.buf[_btLine.len] = 0;
        if (_btLine.buf[0] == '{') _applyJson(_btLine.buf, out);
        _btLine.len = 0;
      }
    } else if (_btLine.len < sizeof(_btLine.buf) - 1) {
      _btLine.buf[_btLine.len++] = (char)c;
    }
  }
  while (wifiBridgeAvailable()) {
    int c = wifiBridgeRead();
    if (c < 0) break;
    _lastWifiByteMs = millis();
    if (c == '\n' || c == '\r') {
      if (_wifiLine.len > 0) {
        _wifiLine.buf[_wifiLine.len] = 0;
        if (_wifiLine.buf[0] == '{') _applyJson(_wifiLine.buf, out);
        _wifiLine.len = 0;
      }
    } else if (_wifiLine.len < sizeof(_wifiLine.buf) - 1) {
      _wifiLine.buf[_wifiLine.len++] = (char)c;
    }
  }

  out->connected = dataConnected();
  if (!out->connected) {
    out->sessionsTotal=0; out->sessionsRunning=0; out->sessionsWaiting=0;
    out->petState=PET_WIRE_SLEEP; out->petStateValid=true;
    out->recentlyCompleted=false; out->lastUpdated=now;
    out->tokensTotal=stats().tokens; out->tokensToday=0;
    strncpy(out->msg, "No Codex connected", sizeof(out->msg)-1);
    out->msg[sizeof(out->msg)-1]=0;
  }
}
