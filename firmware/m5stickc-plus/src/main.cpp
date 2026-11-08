#include <M5StickCPlus.h>
#include <LittleFS.h>
#include <stdarg.h>
#include <mbedtls/base64.h>
#include "ble_bridge.h"
#include "wifi_bridge.h"
#include "voice_capture.h"
#include "pet_reaction.h"
#include "async_capture.h"
#include "data.h"

TFT_eSprite spr = TFT_eSprite(&M5.Lcd);

// Advertise as "Codex-XXXX" (last two BT MAC bytes) so multiple sticks
// in one room are distinguishable in the desktop picker. Name persists in
// btName for the BLUETOOTH info page.
static char btName[16] = "Codex";
static bool bleRuntimeStarted = false;
static void prepareBtName() {
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_BT);
  snprintf(btName, sizeof(btName), "Codex-%02X%02X", mac[4], mac[5]);
}
static void startBt() {
  prepareBtName();
  bleInit(btName);
  bleRuntimeStarted = true;
}

#include "character.h"
#include "stats.h"
const int W = 135, H = 240;
const int CX = W / 2;
const int CY_BASE = 120;
const int LED_PIN = 10;          // red LED, active-low

// Colors used across multiple UI surfaces
const uint16_t HOT   = 0xFA20;   // red-orange: warnings, impatience, deny
const uint16_t PANEL = 0x2104;   // overlay panel background

enum PersonaState { P_SLEEP, P_IDLE, P_BUSY, P_ATTENTION, P_CELEBRATE, P_DIZZY, P_HEART };
const char* stateNames[] = { "sleep", "idle", "busy", "attention", "celebrate", "dizzy", "heart" };

TamaState    tama;
PersonaState baseState   = P_SLEEP;
PersonaState activeState = P_SLEEP;
uint32_t     oneShotUntil = 0;
uint32_t     lastShakeCheck = 0;
float        accelBaseline = 1.0f;
unsigned long t = 0;

// Menu
bool    menuOpen    = false;
uint8_t menuSel     = 0;
uint8_t brightLevel = 4;           // 0..4 → ScreenBreath 20..100
bool    btnALong    = false;
bool    btnBLong    = false;
bool    btnBPressHandled = false;

enum DisplayMode { DISP_NORMAL, DISP_PET, DISP_INFO, DISP_COUNT };
uint8_t displayMode = DISP_NORMAL;
uint8_t infoPage = 0;
uint8_t petPage = 0;
const uint8_t PET_PAGES = 2;
uint8_t msgScroll = 0;
uint8_t assistantScroll = 0;
uint8_t assistantMaxScroll = 0;
uint16_t lastLineGen = 0;
char     lastPromptId[40] = "";
uint16_t lastPermissionAckSeq = 0;
uint16_t lastVoiceAckSeq = 0;
uint16_t lastAssistantSeq = 0;
char     lastAssistantTurnId[48] = "";
char     lastAssistantItemId[48] = "";
bool     lastAssistantStreaming = false;
uint32_t assistantUiUntil = 0;
uint32_t assistantLastUpdateAt = 0;
uint32_t lastInteractMs = 0;
bool     dimmed = false;
bool     screenOff = false;
bool     swallowBtnA = false;
bool     swallowBtnB = false;
bool     gifAvailable = false;

char     voiceUiState[16] = "";
char     voiceUiDetail[384] = "";
bool     voiceUiOk = true;
bool     voiceUiHasTranscript = false;
bool     voiceStartAckPending = false;
bool     voiceCompletionPending = false;
bool     suppressVoiceCancelledAck = false;
bool     suppressVoiceCleanupError = false;
// Capture begins on the physical press edge so the first word is retained.
// Until the 200 ms hold threshold passes, this remains an ordinary tap
// candidate backed by a bounded PCM queue; remote pre-warm is asynchronous.
bool     voicePressArmed = false;
// Remains set for the full physical press, including after an early arm error,
// so that crossing the hold threshold cannot silently restart mid-utterance.
bool     voicePressAttempted = false;
// Prevents the hold threshold from replacing an asynchronous arm/reconnect
// error that was already presented during this same physical press.
bool     voicePressErrorShown = false;
uint32_t voiceStartAckDeadline = 0;
uint32_t voiceStartRetryAt = 0;
uint32_t voiceCompletionDeadline = 0;
uint32_t voiceUiUntil = 0;
uint32_t voiceTranscriptDwellUntil = 0;
uint32_t voiceBridgeGeneration = 0;

static void cycleSpritePack() {
  uint8_t count = characterPackCount();
  if (count == 0) {
    characterClose();
    gifAvailable = false;
    return;
  }
  if (count > 1) {
    gifAvailable = characterNextPack() && characterLoaded();
  } else if (!characterLoaded()) {
    gifAvailable = characterInitIndex(0);
  } else {
    gifAvailable = true;
  }
  if (gifAvailable) speciesIdxSave(characterPackIndex());
  spr.fillSprite(characterPalette().bg);
  characterInvalidate();
}
uint32_t wakeTransitionUntil = 0;
const uint32_t SCREEN_OFF_MS = 30000;

bool     napping = false;
uint32_t napStartMs = 0;
uint32_t promptArrivedMs = 0;

// Face-down = Z-axis dominant and negative. Debounced so a toss doesn't count.
static bool isFaceDown() {
  float ax, ay, az;
  M5.Imu.getAccelData(&ax, &ay, &az);
  return az < -0.7f && fabsf(ax) < 0.4f && fabsf(ay) < 0.4f;
}

static void applyBrightness() { M5.Axp.ScreenBreath(20 + brightLevel * 20); }

static void wake() {
  lastInteractMs = millis();
  if (screenOff) {
    M5.Axp.SetLDO2(true);
    applyBrightness();
    screenOff = false;
    wakeTransitionUntil = millis() + 12000;
  }
  if (dimmed) { applyBrightness(); dimmed = false; }
}
bool     responseSent = false;

static void beep(uint16_t freq, uint16_t dur) {
  if (settings().sound) M5.Beep.tone(freq, dur);
}

static void sendCmd(const char* json) {
  Serial.println(json);
  size_t n = strlen(json);
  bleWrite((const uint8_t*)json, n);
  bleWrite((const uint8_t*)"\n", 1);
  // Keep the JSON body and delimiter atomic with respect to the voice worker.
  wifiBridgeWriteLine(json, n, 250);
}

static void setVoiceUi(const char* state, const char* detail, bool ok,
                       uint32_t visibleMs, bool hasTranscript = false) {
  strncpy(voiceUiState, state ? state : "", sizeof(voiceUiState) - 1);
  voiceUiState[sizeof(voiceUiState) - 1] = 0;
  strncpy(voiceUiDetail, detail ? detail : "", sizeof(voiceUiDetail) - 1);
  voiceUiDetail[sizeof(voiceUiDetail) - 1] = 0;
  voiceUiOk = ok;
  voiceUiHasTranscript = hasTranscript && voiceUiDetail[0];
  if (!voiceUiHasTranscript) voiceTranscriptDwellUntil = 0;
  voiceUiUntil = millis() + visibleMs;
}

static void dismissVoiceUi() {
  voiceUiState[0] = 0;
  voiceUiDetail[0] = 0;
  voiceUiOk = true;
  voiceUiHasTranscript = false;
  voiceUiUntil = 0;
  voiceTranscriptDwellUntil = 0;
}

static bool voiceUiVisible() {
  return voiceUiState[0] && (int32_t)(millis() - voiceUiUntil) < 0;
}

static bool voiceTranscriptDwellActive() {
  return voiceUiHasTranscript && voiceTranscriptDwellUntil != 0 &&
         (int32_t)(millis() - voiceTranscriptDwellUntil) < 0;
}

static const uint32_t VOICE_TRANSCRIPT_MIN_VISIBLE_MS = 2500;

static const uint32_t ASSISTANT_COMPLETED_VISIBLE_MS = 30000;
static const uint32_t ASSISTANT_STREAM_STALE_MS = 60000;

static bool assistantUiVisible() {
  if (!tama.assistantActive) return false;
  if (tama.assistantStreaming) return true;
  return (int32_t)(millis() - assistantUiUntil) < 0;
}

static void dismissAssistantUi() {
  tama.assistantActive = false;
  tama.assistantStreaming = false;
  tama.assistantFinal = false;
  assistantScroll = 0;
  assistantMaxScroll = 0;
  assistantUiUntil = 0;
  assistantLastUpdateAt = 0;
  lastAssistantTurnId[0] = 0;
  lastAssistantItemId[0] = 0;
  lastAssistantStreaming = false;
}

const uint8_t INFO_PAGES = 6;
const uint8_t INFO_PG_BUTTONS = 1;
const uint8_t INFO_PG_CREDITS = 5;

void applyDisplayMode() {
  bool peek = displayMode != DISP_NORMAL;
  characterSetPeek(peek);
  // Clear the whole sprite on mode switch. drawInfo/drawPet clear their
  // own regions when they run, but when you switch FROM info/pet TO normal,
  // those functions stop running and their stale pixels stay behind. Full
  // clear is cheap and guarantees no leftovers between modes.
  spr.fillSprite(0x0000);
  characterInvalidate();  // redraws character on next tick (text mode path)
}

const char* menuItems[] = { "settings", "voice", "turn off", "help", "about", "demo", "close" };
const uint8_t MENU_N = 7;

bool    settingsOpen = false;
uint8_t settingsSel  = 0;
const char* settingsItems[] = { "brightness", "sound", "bluetooth", "wifi", "led", "transcript", "clock rot", "sprite pack", "reset", "back" };
const uint8_t SETTINGS_N = 10;

bool    resetOpen = false;
uint8_t resetSel  = 0;
const char* resetItems[] = { "delete char", "factory reset", "back" };
const uint8_t RESET_N = 3;
static uint32_t resetConfirmUntil = 0;
static uint8_t  resetConfirmIdx = 0xFF;

const uint32_t BTN_A_VOICE_HOLD_MS = 200;
const uint32_t BTN_B_MENU_HOLD_MS = 650;
const uint32_t BTN_A_REPEAT_START_MS = 260;
const uint32_t BTN_A_REPEAT_MS = 95;
uint32_t nextBtnARepeatMs = 0;

// ---------------------------------------------------------------------------
// USB host controls
//
// Remote button state is merged with the debounced physical state once per
// loop. Every existing UI branch therefore sees the same press/hold/release
// sequence regardless of whether it came from the case or the USB controller.
// ---------------------------------------------------------------------------

struct RemoteButtonState {
  bool down = false;
  bool releaseScheduled = false;
  uint32_t releaseAt = 0;
};

struct MergedButtonState {
  bool down = false;
  bool pressedEdge = false;
  bool releasedEdge = false;
  bool physicalSuppressedUntilRelease = false;
  uint32_t pressedAt = 0;

  bool isPressed() const { return down; }
  bool wasPressed() const { return pressedEdge; }
  bool wasReleased() const { return releasedEdge; }
  bool pressedFor(uint32_t durationMs) const {
    return down && (uint32_t)(millis() - pressedAt) >= durationMs;
  }
};

static RemoteButtonState remoteBtnA;
static RemoteButtonState remoteBtnB;
static MergedButtonState btnAInput;
static MergedButtonState btnBInput;
static char lastButtonRequestId[33] = "";
static char lastButtonRequestName[2] = "";
static char lastButtonRequestAction[8] = "";
static uint32_t lastButtonRequestDurationMs = 0;

static void updateMergedButton(RemoteButtonState& remote,
                               MergedButtonState& merged,
                               bool physicalDown,
                               uint32_t now,
                               bool captureBusy) {
  if (remote.down && remote.releaseScheduled &&
      (int32_t)(now - remote.releaseAt) >= 0) {
    remote.down = false;
    remote.releaseScheduled = false;
  }

  // A physical press that begins while the framebuffer is frozen must never
  // turn into a delayed menu/voice action when the transfer ends. Consume the
  // whole gesture, including a release that arrives after capture completion.
  if (captureBusy && physicalDown) {
    merged.physicalSuppressedUntilRelease = true;
  } else if (merged.physicalSuppressedUntilRelease && !physicalDown) {
    merged.physicalSuppressedUntilRelease = false;
  }

  bool effectivePhysicalDown =
    physicalDown && !merged.physicalSuppressedUntilRelease;
  bool nextDown = effectivePhysicalDown || remote.down;
  merged.pressedEdge = nextDown && !merged.down;
  merged.releasedEdge = !nextDown && merged.down;
  if (merged.pressedEdge) merged.pressedAt = now;
  merged.down = nextDown;
}

static void updateMergedButtons(uint32_t now, bool captureBusy) {
  updateMergedButton(
    remoteBtnA, btnAInput, M5.BtnA.isPressed(), now, captureBusy
  );
  updateMergedButton(
    remoteBtnB, btnBInput, M5.BtnB.isPressed(), now, captureBusy
  );
}

static bool deviceControlViewCaptureable = false;
static const char* deviceControlViewError = "screen not presented";

enum DeviceCapturePhase {
  DEVICE_CAPTURE_IDLE,
  DEVICE_CAPTURE_REQUESTED,
  DEVICE_CAPTURE_BEGIN,
  DEVICE_CAPTURE_CHUNKS,
  DEVICE_CAPTURE_END,
};

static const size_t DEVICE_CAPTURE_BYTES = W * H;
static const size_t DEVICE_CAPTURE_CHUNK_BYTES = 384;
static DeviceCapturePhase deviceCapturePhase = DEVICE_CAPTURE_IDLE;
static AsyncCapture asyncCapture;
static uint8_t* deviceCaptureBuffer = nullptr;
static size_t deviceCaptureOffset = 0;
static uint16_t deviceCaptureSeq = 0;
static uint32_t deviceCaptureCrc = 0xFFFFFFFF;
static uint32_t deviceCaptureRequestedAt = 0;
static char deviceCaptureId[33] = "";

static bool validDeviceControlId(const char* id) {
  if (!id || !id[0]) return false;
  size_t len = strlen(id);
  if (len > 32) return false;
  for (size_t i = 0; i < len; i++) {
    char c = id[i];
    bool safe = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
    if (!safe) return false;
  }
  return true;
}

static void writeDeviceControlError(const char* id, const char* op,
                                    const char* error) {
  char line[240];
  int len = snprintf(
    line, sizeof(line),
    "{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\",\"op\":\"%s\","
    "\"state\":\"error\",\"ok\":false,\"error\":\"%s\"}\n",
    id ? id : "", op ? op : "", error ? error : "invalid request"
  );
  if (len > 0) Serial.write((const uint8_t*)line, (size_t)len);
}

static void scheduleRemoteButton(RemoteButtonState& button,
                                 const char* action,
                                 uint32_t durationMs) {
  if (strcmp(action, "release") == 0) {
    button.down = false;
    button.releaseScheduled = false;
    return;
  }

  button.down = true;
  if (strcmp(action, "press") == 0) {
    // A lost host-side release must not strand the device indefinitely.
    button.releaseScheduled = true;
    button.releaseAt = millis() + 30000;
  } else {
    button.releaseScheduled = true;
    button.releaseAt = millis() + durationMs;
  }
}

bool deviceControlCommand(JsonDocument& doc) {
  const char* cmd = doc["cmd"];
  if (!cmd || strcmp(cmd, "device_control") != 0) return false;

  const char* id = doc["id"] | "";
  const char* op = doc["op"] | "";
  if (!validDeviceControlId(id)) {
    writeDeviceControlError("", op, "invalid id");
    return true;
  }
  if ((doc["v"] | 0) != 1) {
    writeDeviceControlError(id, op, "unsupported version");
    return true;
  }

  if (strcmp(op, "capture_async") == 0) {
    if (deviceCapturePhase != DEVICE_CAPTURE_IDLE || asyncCapture.active()) {
      writeDeviceControlError(id, op, "capture busy");
    } else if (!deviceControlViewCaptureable) {
      writeDeviceControlError(id, op, deviceControlViewError);
    } else if (!asyncCapture.request(id, W, H)) {
      writeDeviceControlError(id, op, "snapshot memory unavailable");
    }
    return true;
  }
  if (strcmp(op, "capture_release") == 0) {
    if (!asyncCapture.dispose()) {
      writeDeviceControlError(id, op, "capture busy");
    } else {
      Serial.printf("{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\",\"op\":\"capture_release\",\"state\":\"complete\"}\n", id);
    }
    return true;
  }

  if (strcmp(op, "button") == 0) {
    if (deviceCapturePhase != DEVICE_CAPTURE_IDLE) {
      writeDeviceControlError(id, op, "capture busy");
      return true;
    }
    const char* name = doc["button"] | "";
    const char* action = doc["action"] | "";
    RemoteButtonState* button = nullptr;
    if (strcmp(name, "A") == 0) button = &remoteBtnA;
    if (strcmp(name, "B") == 0) button = &remoteBtnB;
    if (!button) {
      writeDeviceControlError(id, op, "button must be A or B");
      return true;
    }
    if (strcmp(action, "tap") != 0 && strcmp(action, "hold") != 0 &&
        strcmp(action, "press") != 0 && strcmp(action, "release") != 0) {
      writeDeviceControlError(id, op, "invalid button action");
      return true;
    }

    uint32_t durationMs = doc["duration_ms"] | 0;
    if (strcmp(action, "tap") == 0) durationMs = 100;
    if (strcmp(action, "hold") == 0) durationMs = durationMs ? durationMs : 750;
    if (strcmp(action, "hold") == 0 &&
        (durationMs < 50 || durationMs > 30000)) {
      writeDeviceControlError(id, op, "duration_ms must be 50..30000");
      return true;
    }

    bool replay = strcmp(lastButtonRequestId, id) == 0;
    if (replay &&
        (strcmp(lastButtonRequestName, name) != 0 ||
         strcmp(lastButtonRequestAction, action) != 0 ||
         lastButtonRequestDurationMs != durationMs)) {
      writeDeviceControlError(id, op, "id reused with different button request");
      return true;
    }
    if (!replay) {
      scheduleRemoteButton(*button, action, durationMs);
      snprintf(lastButtonRequestId, sizeof(lastButtonRequestId), "%s", id);
      snprintf(lastButtonRequestName, sizeof(lastButtonRequestName), "%s", name);
      snprintf(lastButtonRequestAction, sizeof(lastButtonRequestAction), "%s", action);
      lastButtonRequestDurationMs = durationMs;
    }

    char line[240];
    int len = snprintf(
      line, sizeof(line),
      "{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\","
      "\"op\":\"button\",\"state\":\"accepted\",\"ok\":true,"
      "\"button\":\"%s\",\"action\":\"%s\",\"replay\":%s}\n",
      id, name, action, replay ? "true" : "false"
    );
    if (len > 0) Serial.write((const uint8_t*)line, (size_t)len);
    return true;
  }

  if (strcmp(op, "capture") == 0) {
    if (deviceCapturePhase != DEVICE_CAPTURE_IDLE || asyncCapture.active()) {
      writeDeviceControlError(id, op, "capture busy");
      return true;
    }
    if (voiceCaptureActive() || voiceStartAckPending) {
      writeDeviceControlError(id, op, "voice session active");
      return true;
    }
    if (remoteBtnA.down || remoteBtnB.down ||
        M5.BtnA.isPressed() || M5.BtnB.isPressed() ||
        btnAInput.isPressed() || btnBInput.isPressed()) {
      writeDeviceControlError(id, op, "button active");
      return true;
    }
    if (!deviceControlViewCaptureable) {
      writeDeviceControlError(id, op, deviceControlViewError);
      return true;
    }
    if (spr.getColorDepth() != 8) {
      writeDeviceControlError(id, op, "framebuffer is not rgb332");
      return true;
    }

    deviceCaptureBuffer = (uint8_t*)spr.frameBuffer(1);
    if (!deviceCaptureBuffer) {
      writeDeviceControlError(id, op, "framebuffer unavailable");
      return true;
    }
    snprintf(deviceCaptureId, sizeof(deviceCaptureId), "%s", id);
    deviceCaptureOffset = 0;
    deviceCaptureSeq = 0;
    deviceCaptureCrc = 0xFFFFFFFF;
    deviceCaptureRequestedAt = millis();
    // Wait for one normal render pass before freezing the buffer. A serial
    // command can be queued while setup is still showing the welcome screen;
    // capturing immediately in the first loop would otherwise return that
    // stale boot frame instead of the current UI.
    deviceCapturePhase = DEVICE_CAPTURE_REQUESTED;
    return true;
  }

  writeDeviceControlError(id, op, "unknown operation");
  return true;
}

bool deviceControlCaptureActive() {
  return deviceCapturePhase >= DEVICE_CAPTURE_BEGIN;
}

void deviceControlFramePresented() {
  if (spr.getColorDepth() == 8 && spr.frameBuffer(1)) {
    asyncCapture.presented((const uint8_t*)spr.frameBuffer(1));
  }
  if (deviceCapturePhase == DEVICE_CAPTURE_REQUESTED) {
    deviceCapturePhase = DEVICE_CAPTURE_BEGIN;
  }
}

static void rejectRequestedCapture(const char* error) {
  if (deviceCapturePhase != DEVICE_CAPTURE_REQUESTED) return;
  writeDeviceControlError(deviceCaptureId, "capture", error);
  deviceCapturePhase = DEVICE_CAPTURE_IDLE;
  deviceCaptureBuffer = nullptr;
}

static uint32_t updateCaptureCrc32(uint32_t crc, const uint8_t* data,
                                   size_t len) {
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; bit++) {
      crc = (crc >> 1) ^ (0xEDB88320UL & (uint32_t)-(int32_t)(crc & 1));
    }
  }
  return crc;
}

void deviceControlCapturePoll() {
  if (deviceCapturePhase == DEVICE_CAPTURE_IDLE ||
      deviceCapturePhase == DEVICE_CAPTURE_REQUESTED) return;

  if (deviceCapturePhase == DEVICE_CAPTURE_BEGIN) {
    char line[280];
    int len = snprintf(
      line, sizeof(line),
      "{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\","
      "\"op\":\"capture\",\"state\":\"begin\",\"ok\":true,"
      "\"width\":%d,\"height\":%d,\"format\":\"rgb332\","
      "\"bytes\":%u,\"chunk_bytes\":%u,\"source\":\"sprite\"}\n",
      deviceCaptureId, W, H, (unsigned)DEVICE_CAPTURE_BYTES,
      (unsigned)DEVICE_CAPTURE_CHUNK_BYTES
    );
    if (len > 0) Serial.write((const uint8_t*)line, (size_t)len);
    deviceCapturePhase = DEVICE_CAPTURE_CHUNKS;
    return;
  }

  if (deviceCapturePhase == DEVICE_CAPTURE_CHUNKS) {
    size_t remaining = DEVICE_CAPTURE_BYTES - deviceCaptureOffset;
    size_t rawLen = remaining < DEVICE_CAPTURE_CHUNK_BYTES
      ? remaining : DEVICE_CAPTURE_CHUNK_BYTES;
    char encoded[DEVICE_CAPTURE_CHUNK_BYTES * 4 / 3 + 1];
    size_t encodedLen = 0;
    int rc = mbedtls_base64_encode(
      (uint8_t*)encoded, sizeof(encoded), &encodedLen,
      deviceCaptureBuffer + deviceCaptureOffset, rawLen
    );
    if (rc != 0 || encodedLen >= sizeof(encoded)) {
      writeDeviceControlError(deviceCaptureId, "capture", "base64 encode failed");
      deviceCapturePhase = DEVICE_CAPTURE_IDLE;
      characterInvalidate();
      return;
    }
    encoded[encodedLen] = 0;
    deviceCaptureCrc = updateCaptureCrc32(
      deviceCaptureCrc, deviceCaptureBuffer + deviceCaptureOffset, rawLen
    );

    char line[760];
    int len = snprintf(
      line, sizeof(line),
      "{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\","
      "\"op\":\"capture\",\"state\":\"chunk\",\"seq\":%u,"
      "\"offset\":%u,\"data\":\"%s\"}\n",
      deviceCaptureId, (unsigned)deviceCaptureSeq,
      (unsigned)deviceCaptureOffset, encoded
    );
    if (len <= 0 || (size_t)len >= sizeof(line)) {
      writeDeviceControlError(deviceCaptureId, "capture", "capture line overflow");
      deviceCapturePhase = DEVICE_CAPTURE_IDLE;
      characterInvalidate();
      return;
    }
    Serial.write((const uint8_t*)line, (size_t)len);
    deviceCaptureOffset += rawLen;
    deviceCaptureSeq++;
    if (deviceCaptureOffset >= DEVICE_CAPTURE_BYTES) {
      deviceCapturePhase = DEVICE_CAPTURE_END;
    }
    return;
  }

  char line[280];
  int len = snprintf(
    line, sizeof(line),
    "{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\","
    "\"op\":\"capture\",\"state\":\"end\",\"ok\":true,"
    "\"chunks\":%u,\"bytes\":%u,\"crc32\":\"%08lx\"}\n",
    deviceCaptureId, (unsigned)deviceCaptureSeq,
    (unsigned)deviceCaptureOffset,
    (unsigned long)(deviceCaptureCrc ^ 0xFFFFFFFFUL)
  );
  if (len > 0) Serial.write((const uint8_t*)line, (size_t)len);
  deviceCapturePhase = DEVICE_CAPTURE_IDLE;
  deviceCaptureBuffer = nullptr;
  characterInvalidate();
}

static bool menuOverlayOpen() {
  return menuOpen || settingsOpen || resetOpen;
}

static void advanceMenuSelection() {
  if (resetOpen) {
    resetSel = (resetSel + 1) % RESET_N;
    resetConfirmIdx = 0xFF;
  } else if (settingsOpen) {
    settingsSel = (settingsSel + 1) % SETTINGS_N;
  } else if (menuOpen) {
    menuSel = (menuSel + 1) % MENU_N;
  }
}

static bool handleBtnAOverlayNav(uint32_t now) {
  if (!menuOverlayOpen()) {
    nextBtnARepeatMs = 0;
    return false;
  }

  if (btnAInput.wasPressed()) {
    advanceMenuSelection();
    nextBtnARepeatMs = now + BTN_A_REPEAT_START_MS;
    return true;
  }

  if (btnAInput.isPressed() && nextBtnARepeatMs &&
      (int32_t)(now - nextBtnARepeatMs) >= 0) {
    advanceMenuSelection();
    nextBtnARepeatMs = now + BTN_A_REPEAT_MS;
    return true;
  }

  if (btnAInput.wasReleased()) nextBtnARepeatMs = 0;
  return false;
}

static void applySetting(uint8_t idx) {
  Settings& s = settings();
  switch (idx) {
    case 0:
      brightLevel = (brightLevel + 1) % 5;
      applyBrightness();
      return;
    case 1: s.sound = !s.sound; break;
    case 2:
      // This preference is applied on boot. In Wi-Fi bridge mode BLE is
      // deferred regardless, because all three of BLE, Wi-Fi, and the display
      // framebuffer do not fit reliably in StickC Plus internal RAM.
      s.bt = !s.bt;
      break;
    case 3:
      s.wifi = !s.wifi;
      if (s.wifi) {
        wifiBridgeInit(btName);
        if (!bleRuntimeStarted) wifiBridgeSetLowLatency(true);
      }
      else wifiBridgeSetEnabled(false);
      break;
    case 4: s.led = !s.led; break;
    case 5: s.hud = !s.hud; break;
    case 6: s.clockRot = (s.clockRot + 1) % 3; break;
    case 7: cycleSpritePack(); return;
    case 8: resetOpen = true; resetSel = 0; resetConfirmIdx = 0xFF; return;
    case 9: settingsOpen = false; characterInvalidate(); return;
  }
  settingsSave();
}

// Tap-twice confirm: first tap arms (label flips to "really?"), second
// within 3s executes. Scrolling away clears the arm.
static void applyReset(uint8_t idx) {
  uint32_t now = millis();
  bool armed = (resetConfirmIdx == idx) && (int32_t)(now - resetConfirmUntil) < 0;

  if (idx == 2) { resetOpen = false; return; }

  if (!armed) {
    resetConfirmIdx = idx;
    resetConfirmUntil = now + 3000;
    beep(1400, 60);
    return;
  }

  beep(800, 200);
  if (idx == 0) {
    // delete char: wipe /characters/, reboot into missing-pack mode
    File d = LittleFS.open("/characters");
    if (d && d.isDirectory()) {
      File e;
      while ((e = d.openNextFile())) {
        char path[80];
        snprintf(path, sizeof(path), "/characters/%s", e.name());
        if (e.isDirectory()) {
          File f;
          while ((f = e.openNextFile())) {
            char fp[128];
            snprintf(fp, sizeof(fp), "%s/%s", path, f.name());
            f.close();
            LittleFS.remove(fp);
          }
          e.close();
          LittleFS.rmdir(path);
        } else {
          e.close();
          LittleFS.remove(path);
        }
      }
      d.close();
    }
  } else {
    // factory reset: NVS namespace wipe + filesystem format + BLE bonds.
    // Clears stats, owner, petname, settings, GIF characters,
    // and any stored LTKs so the next desktop has to re-pair.
    _prefs.begin("buddy", false);
    _prefs.clear();
    _prefs.end();
    wifiBridgeClearConfig();
    LittleFS.format();
    bleClearBonds();
  }
  delay(300);
  ESP.restart();
}

// Footer hint row inside a menu panel: "<downLbl> ↓  <rightLbl> →" with
// pixel triangles. Panels add MENU_HINT_H to height and call this at bottom.
const int MENU_HINT_H = 14;
static void drawMenuHints(const Palette& p, int mx, int mw, int hy,
                          const char* downLbl = "A", const char* rightLbl = "B") {
  spr.drawFastHLine(mx + 6, hy - 4, mw - 12, p.textDim);
  spr.setTextColor(p.textDim, PANEL);
  // 6px/glyph at size 1; triangle goes 4px after the label ends
  int x = mx + 8;
  spr.setCursor(x, hy); spr.print(downLbl);
  x += strlen(downLbl) * 6 + 4;
  spr.fillTriangle(x, hy + 1, x + 6, hy + 1, x + 3, hy + 6, p.textDim);
  x = mx + mw / 2 + 4;
  spr.setCursor(x, hy); spr.print(rightLbl);
  x += strlen(rightLbl) * 6 + 4;
  spr.fillTriangle(x, hy, x, hy + 6, x + 5, hy + 3, p.textDim);
}

static void drawSettings() {
  const Palette& p = characterPalette();
  int mw = 118, mh = 30 + SETTINGS_N * 14 + MENU_HINT_H;
  int mx = (W - mw) / 2, my = (H - mh) / 2;
  spr.fillRect(0, my, W, H - my, p.bg);
  spr.fillRoundRect(mx, my, mw, mh, 4, PANEL);
  spr.drawRoundRect(mx, my, mw, mh, 4, p.textDim);
  spr.setTextSize(1);
  spr.setTextColor(p.body, PANEL);
  spr.setCursor(mx + 8, my + 6);
  if (ownerName()[0]) spr.printf("%s's %s", ownerName(), petName());
  else spr.print(petName());
  spr.drawFastHLine(mx + 6, my + 17, mw - 12, p.textDim);
  Settings& s = settings();
  bool vals[] = { s.sound, s.bt, s.wifi, s.led, s.hud };
  for (int i = 0; i < SETTINGS_N; i++) {
    bool sel = (i == settingsSel);
    spr.setTextColor(sel ? p.text : p.textDim, PANEL);
    spr.setCursor(mx + 6, my + 22 + i * 14);
    spr.print(sel ? "> " : "  ");
    spr.print(settingsItems[i]);
    spr.setCursor(mx + mw - 36, my + 22 + i * 14);
    spr.setTextColor(p.textDim, PANEL);
    if (i == 0) {
      spr.printf("%u/4", brightLevel);
    } else if (i == 2 && s.bt && !bleRuntimeStarted) {
      spr.setTextColor(HOT, PANEL);
      spr.print("wifi");
    } else if (i >= 1 && i <= 5) {
      spr.setTextColor(vals[i-1] ? GREEN : p.textDim, PANEL);
      spr.print(vals[i-1] ? " on" : "off");
    } else if (i == 6) {
      static const char* const RN[] = { "auto", "port", "land" };
      spr.print(RN[s.clockRot]);
    } else if (i == 7) {
      uint8_t count = characterPackCount();
      if (count == 0 || !gifAvailable) {
        spr.print("missing");
      } else {
        uint8_t idx = characterPackIndex();
        if (idx >= count) idx = 0;
        spr.printf("%u/%u", idx + 1, count);
      }
    }
  }
  drawMenuHints(p, mx, mw, my + mh - 12, "Next", "Change");
}

static void drawReset() {
  const Palette& p = characterPalette();
  int mw = 118, mh = 16 + RESET_N * 14 + MENU_HINT_H;
  int mx = (W - mw) / 2, my = (H - mh) / 2;
  spr.fillRect(0, my, W, H - my, p.bg);
  spr.fillRoundRect(mx, my, mw, mh, 4, PANEL);
  spr.drawRoundRect(mx, my, mw, mh, 4, HOT);
  spr.setTextSize(1);
  for (int i = 0; i < RESET_N; i++) {
    bool sel = (i == resetSel);
    spr.setTextColor(sel ? p.text : p.textDim, PANEL);
    spr.setCursor(mx + 6, my + 8 + i * 14);
    spr.print(sel ? "> " : "  ");
    bool armed = (i == resetConfirmIdx) &&
                 (int32_t)(millis() - resetConfirmUntil) < 0;
    if (armed) spr.setTextColor(HOT, PANEL);
    spr.print(armed ? "really?" : resetItems[i]);
  }
  drawMenuHints(p, mx, mw, my + mh - 12);
}

void menuConfirm() {
  switch (menuSel) {
    case 0: settingsOpen = true; menuOpen = false; settingsSel = 0; break;
    case 1:
      menuOpen = false;
      displayMode = DISP_NORMAL;
      applyDisplayMode();
      dismissAssistantUi();
      setVoiceUi("ready", "hold A to record", true, 5000);
      characterInvalidate();
      break;
    case 2: M5.Axp.PowerOff(); break;
    case 3:
    case 4:
      menuOpen = false;
      displayMode = DISP_INFO;
      infoPage = (menuSel == 3) ? INFO_PG_BUTTONS : INFO_PG_CREDITS;
      applyDisplayMode();
      characterInvalidate();
      break;
    case 5: dataSetDemo(!dataDemo()); break;
    case 6: menuOpen = false; characterInvalidate(); break;
  }
}

void drawMenu() {
  const Palette& p = characterPalette();
  int mw = 118, mh = 16 + MENU_N * 14 + MENU_HINT_H;
  int mx = (W - mw) / 2, my = (H - mh) / 2;
  // Clear the full panel band first. Rounded corners otherwise leave narrow
  // strips of the underlying activity text visible along the 8 px margins.
  spr.fillRect(0, my, W, H - my, p.bg);
  spr.fillRoundRect(mx, my, mw, mh, 4, PANEL);
  spr.drawRoundRect(mx, my, mw, mh, 4, p.textDim);
  spr.setTextSize(1);
  for (int i = 0; i < MENU_N; i++) {
    bool sel = (i == menuSel);
    spr.setTextColor(sel ? p.text : p.textDim, PANEL);
    spr.setCursor(mx + 6, my + 8 + i * 14);
    spr.print(sel ? "> " : "  ");
    spr.print(menuItems[i]);
    if (i == 5) spr.print(dataDemo() ? "  on" : "  off");
  }
  drawMenuHints(p, mx, mw, my + mh - 12);
}

// Clock orientation: gravity along the in-plane X axis means the stick is
// on its side. Signed counter for hysteresis on both transitions — same
// pattern as face-down nap.
//   0 = portrait (sprite path, pet sleeps underneath)
//   1 = landscape, BtnA-side down (M5.Lcd rotation 1)
//   3 = landscape, USB-side down (M5.Lcd rotation 3)
static uint8_t clockOrient   = 0;
static int8_t  orientFrames  = 0;
static uint8_t paintedOrient = 0;
// RTC and IMU share an I2C bus. Reading the RTC at 60fps starves the IMU
// reads in clockUpdateOrient — orientation detection gets noisy. Cache the
// time once per second; mood logic and drawClock both read from here.
static RTC_TimeTypeDef _clkTm;
static RTC_DateTypeDef _clkDt;
uint32_t               _clkLastRead = 0;   // zeroed by data.h on time-sync
static bool            _onUsb       = false;
static void clockRefreshRtc() {
  if (millis() - _clkLastRead < 1000) return;
  _clkLastRead = millis();
  _onUsb = M5.Axp.GetVBusVoltage() > 4.0f;
  M5.Rtc.GetTime(&_clkTm);
  M5.Rtc.GetDate(&_clkDt);
}

static void clockUpdateOrient() {
  float ax, ay, az;
  M5.Imu.getAccelData(&ax, &ay, &az);
  uint8_t lock = settings().clockRot;
  if (lock == 1) { clockOrient = 0; return; }
  if (lock == 2) {
    // Locked landscape: never drop to 0, but still pick 1 vs 3 from
    // gravity so the cradle works either way up. Need a strong tilt
    // for the 1↔3 swap so handling jitter doesn't flip it; otherwise
    // hold whatever we last had (or 1 from boot).
    if (clockOrient == 0) clockOrient = (ax >= 0) ? 1 : 3;
    if      (ax >  0.5f && clockOrient != 1) clockOrient = 1;
    else if (ax < -0.5f && clockOrient != 3) clockOrient = 3;
    return;
  }
  // Dual threshold: strict to enter (must be clearly sideways), loose to
  // stay (tolerate ~65° of tilt). With one shared threshold a slight lean
  // while sitting on the long edge puts ax right at the boundary and the
  // counter ratchets down in ~half a second.
  bool side = (clockOrient == 0)
    ? fabsf(ax) > 0.7f && fabsf(ay) < 0.5f && fabsf(az) < 0.5f
    : fabsf(ax) > 0.4f;
  if (side) { if (orientFrames < 20) orientFrames++; }
  else      { if (orientFrames > -10) orientFrames--; }
  if (clockOrient == 0 && orientFrames >= 15) {
    clockOrient = (ax > 0) ? 1 : 3;
  } else if (clockOrient != 0 && orientFrames <= -8) {
    clockOrient = 0;
  } else if (clockOrient != 0 && side) {
    // Direct 1↔3: a fast flip keeps |ax|>0.7 (just changes sign), so
    // `side` never drops and the exit-via-0 path can't fire. Watch for
    // ax sign disagreeing with the stored orientation.
    static int8_t swapFrames = 0;
    uint8_t want = (ax > 0) ? 1 : 3;
    if (want != clockOrient) { if (++swapFrames >= 8) { clockOrient = want; swapFrames = 0; } }
    else swapFrames = 0;
  }
}

// Clock face: shown when charging on USB with nothing else going on.
// Portrait paints the upper ~110px to the sprite; pet renders below.
// Landscape draws direct to LCD with rotation — sprite stays untouched.
static const char* const MON[] = {
  "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"
};
static const char* const DOW[] = {"Sun","Mon","Tue","Wed","Thu","Fri","Sat"};

static uint8_t clockDow() { return _clkDt.WeekDay % 7; }
static void drawClock() {
  const Palette& p = characterPalette();
  char hm[6]; snprintf(hm, sizeof(hm), "%02u:%02u", _clkTm.Hours, _clkTm.Minutes);
  char ss[4]; snprintf(ss, sizeof(ss), ":%02u", _clkTm.Seconds);
  uint8_t mi = (_clkDt.Month >= 1 && _clkDt.Month <= 12) ? _clkDt.Month - 1 : 0;
  char dl[8]; snprintf(dl, sizeof(dl), "%s %02u", MON[mi], _clkDt.Date);

  if (clockOrient == 0) {
    paintedOrient = 0;
    // Bottom half — buddy naturally lives at y=0..82, GIF peeks at top
    // via peek mode. Clearing from 90 leaves both untouched.
    spr.fillRect(0, 90, W, H - 90, p.bg);
    spr.setTextDatum(MC_DATUM);
    spr.setTextSize(4); spr.setTextColor(p.text, p.bg);    spr.drawString(hm, CX, 140);
    spr.setTextSize(2); spr.setTextColor(p.textDim, p.bg); spr.drawString(ss, CX, 175);
    spr.setTextSize(1);                                     spr.drawString(dl, CX, 200);
    spr.setTextDatum(TL_DATUM);
    return;
  }

  // Landscape: 240×135 direct-to-LCD. Full fill only on entry; after that
  // text glyph bg cells repaint themselves and the pet box (small, ~90×50)
  // gets a fillRect each pet tick — small enough not to tear.
  M5.Lcd.setRotation(clockOrient);
  static uint8_t lastSec = 0xFF;
  bool repaint = paintedOrient != clockOrient;
  if (repaint) { M5.Lcd.fillScreen(p.bg); paintedOrient = clockOrient; lastSec = 0xFF; }

  // Seconds tick at 1Hz; redrawing 3 strings at 60fps is 180 SPI ops/sec
  // for nothing. Gate on the second changing (or full repaint).
  if (repaint || _clkTm.Seconds != lastSec) {
    lastSec = _clkTm.Seconds;
    char wdl[12]; snprintf(wdl, sizeof(wdl), "%s %s %02u", DOW[clockDow()], MON[mi], _clkDt.Date);
    char ssl[3]; snprintf(ssl, sizeof(ssl), "%02u", _clkTm.Seconds);
    M5.Lcd.setTextDatum(MC_DATUM);
    M5.Lcd.setTextSize(3); M5.Lcd.setTextColor(p.text, p.bg);    M5.Lcd.drawString(hm, 170, 42);
    M5.Lcd.setTextSize(2); M5.Lcd.setTextColor(p.textDim, p.bg); M5.Lcd.drawString(ssl, 170, 72);
                                                                  M5.Lcd.drawString(wdl, 170, 102);
    M5.Lcd.setTextDatum(TL_DATUM);
    M5.Lcd.setTextSize(1);
  }

  // Pet on left at 5 fps.
  static uint32_t lastPetTick = 0;
  if (millis() - lastPetTick >= 200) {
    lastPetTick = millis();
    if (characterLoaded()) {
      characterSetState(activeState);
      characterRenderTo(&M5.Lcd, 57, 45);
    }
  }
  M5.Lcd.setRotation(0);
}

PersonaState derive(const TamaState& s) {
  if (s.petStateValid && s.petState <= P_HEART) return (PersonaState)s.petState;
  if (!s.connected)            return P_SLEEP;
  if (s.sessionsWaiting > 0)   return P_ATTENTION;
  if (s.recentlyCompleted)     return P_CELEBRATE;
  if (s.sessionsRunning > 0)   return P_BUSY;
  return P_IDLE;   // connected, 0+ sessions, nothing urgent — hang out
}

void triggerOneShot(PersonaState s, uint32_t durMs) {
  activeState = s;
  oneShotUntil = millis() + durMs;
}

bool checkShake() {
  float ax, ay, az;
  M5.Imu.getAccelData(&ax, &ay, &az);
  float mag = sqrtf(ax*ax + ay*ay + az*az);
  float delta = fabsf(mag - accelBaseline);
  accelBaseline = accelBaseline * 0.95f + mag * 0.05f;
  return delta > 0.8f;
}




// Persistent screen-level title row ("INFO  n/3") matching the PET header,
// then a per-page section label below it. The fixed title is the cue that
// B cycles pages here just like it does on PET.
static void _infoHeader(const Palette& p, int& y, const char* section, uint8_t page) {
  spr.setTextColor(p.text, p.bg);
  spr.setCursor(4, y); spr.print("Info");
  spr.setTextColor(p.textDim, p.bg);
  spr.setCursor(W - 28, y); spr.printf("%u/%u", page + 1, INFO_PAGES);
  y += 12;
  spr.setTextColor(p.body, p.bg);
  spr.setCursor(4, y); spr.print(section);
  y += 12;
}

void drawPasskey() {
  const Palette& p = characterPalette();
  spr.fillSprite(p.bg);
  spr.setTextSize(1);
  spr.setTextColor(p.textDim, p.bg);
  spr.setCursor(8, 56);  spr.print("BLUETOOTH PAIRING");
  spr.setCursor(8, 184); spr.print("enter on desktop:");
  spr.setTextSize(3);
  spr.setTextColor(p.text, p.bg);
  char b[8]; snprintf(b, sizeof(b), "%06lu", (unsigned long)blePasskey());
  spr.setCursor((W - 18 * 6) / 2, 110);
  spr.print(b);
}

void drawInfo() {
  const Palette& p = characterPalette();
  const int TOP = 70;
  spr.fillRect(0, TOP, W, H - TOP, p.bg);
  spr.setTextSize(1);
  int y = TOP + 2;
  auto ln = [&](const char* fmt, ...) {
    char b[32]; va_list a; va_start(a, fmt); vsnprintf(b, sizeof(b), fmt, a); va_end(a);
    spr.setCursor(4, y); spr.print(b); y += 8;
  };

  if (infoPage == 0) {
    _infoHeader(p, y, "ABOUT", infoPage);
    spr.setTextColor(p.textDim, p.bg);
    ln("I watch your Codex");
    ln("desktop sessions.");
    y += 6;
    ln("I sleep when nothing's");
    ln("happening, wake when");
    ln("you start working,");
    ln("get impatient when");
    ln("approvals pile up.");
    y += 6;
    spr.setTextColor(p.text, p.bg);
    ln("Press A on a prompt");
    ln("to approve from here.");
    y += 6;
    spr.setTextColor(p.textDim, p.bg);
    ln("Imagen sprite pack.");
    ln("Settings > sprite");
    ln("pack cycles it.");

  } else if (infoPage == 1) {
    _infoHeader(p, y, "BUTTONS", infoPage);
    spr.setTextColor(p.text, p.bg);    ln("A   front");
    spr.setTextColor(p.textDim, p.bg); ln("    next screen");
    ln("    approve prompt"); y += 4;
    spr.setTextColor(p.text, p.bg);    ln("B   right side");
    spr.setTextColor(p.textDim, p.bg); ln("    next page");
    ln("    deny prompt"); y += 4;
    spr.setTextColor(p.text, p.bg);    ln("hold A");
    spr.setTextColor(p.textDim, p.bg); ln("    voice"); y += 4;
    spr.setTextColor(p.text, p.bg);    ln("hold B");
    spr.setTextColor(p.textDim, p.bg); ln("    menu"); y += 4;
    spr.setTextColor(p.text, p.bg);    ln("Power  left side");
    spr.setTextColor(p.textDim, p.bg); ln("    tap = screen off");
    ln("    hold 6s = off");

  } else if (infoPage == 2) {
    _infoHeader(p, y, "CODEX", infoPage);
    spr.setTextColor(p.textDim, p.bg);
    ln("  sessions  %u", tama.sessionsTotal);
    ln("  running   %u", tama.sessionsRunning);
    ln("  waiting   %u", tama.sessionsWaiting);
    y += 8;
    spr.setTextColor(p.text, p.bg);
    ln("LINK");
    spr.setTextColor(p.textDim, p.bg);
    ln("  via       %s", dataScenarioName());
    ln("  ble       %s", !bleConnected() ? "-" : bleSecure() ? "encrypted" : "OPEN");
    uint32_t age = (millis() - tama.lastUpdated) / 1000;
    ln("  last msg  %lus", (unsigned long)age);
    ln("  state     %s", stateNames[activeState]);

  } else if (infoPage == 3) {
    _infoHeader(p, y, "DEVICE", infoPage);

    int vBat_mV = (int)(M5.Axp.GetBatVoltage() * 1000);
    int iBat_mA = (int)M5.Axp.GetBatCurrent();
    int vBus_mV = (int)(M5.Axp.GetVBusVoltage() * 1000);
    int pct = (vBat_mV - 3200) / 10;   // (v-3.2)/(4.2-3.2)*100 = (v-3.2)*100 = (mv-3200)/10
    if (pct < 0) pct = 0; if (pct > 100) pct = 100;
    bool usb = vBus_mV > 4000;
    bool charging = usb && iBat_mA > 1;
    bool full = usb && vBat_mV > 4100 && iBat_mA < 10;

    spr.setTextColor(p.text, p.bg);
    spr.setTextSize(2);
    spr.setCursor(4, y);
    spr.printf("%d%%", pct);
    spr.setTextSize(1);
    spr.setTextColor(full ? GREEN : (charging ? HOT : p.textDim), p.bg);
    spr.setCursor(60, y + 4);
    spr.print(full ? "full" : (charging ? "charging" : (usb ? "usb" : "battery")));
    y += 20;

    spr.setTextColor(p.textDim, p.bg);
    ln("  battery  %d.%02dV", vBat_mV/1000, (vBat_mV%1000)/10);
    ln("  current  %+dmA", iBat_mA);
    if (usb) ln("  usb in   %d.%02dV", vBus_mV/1000, (vBus_mV%1000)/10);
    y += 8;

    spr.setTextColor(p.text, p.bg);
    ln("SYSTEM");
    spr.setTextColor(p.textDim, p.bg);
    if (ownerName()[0]) ln("  owner    %s", ownerName());
    uint32_t up = millis() / 1000;
    ln("  uptime   %luh %02lum", up / 3600, (up / 60) % 60);
    ln("  heap     %uKB", ESP.getFreeHeap() / 1024);
    ln("  bright   %u/4", brightLevel);
    ln("  bt       %s", !settings().bt ? "off" :
       !bleRuntimeStarted ? "wifi mode" :
       dataBtActive() ? "linked" : "on");
    ln("  temp     %dC", (int)M5.Axp.GetTempInAXP192());

  } else if (infoPage == 4) {
    _infoHeader(p, y, "BLUETOOTH", infoPage);
    bool enabled = settings().bt && bleRuntimeStarted;
    bool linked = enabled && dataBtActive();

    spr.setTextColor(linked ? GREEN : (enabled ? HOT : p.textDim), p.bg);
    spr.setTextSize(2);
    spr.setCursor(4, y);
    spr.print(linked ? "linked" : (enabled ? "discover" :
              settings().bt ? "wifi mode" : "off"));
    spr.setTextSize(1);
    y += 20;

    spr.setTextColor(p.textDim, p.bg);
    spr.setTextColor(p.text, p.bg);
    ln("  %s", btName);
    spr.setTextColor(p.textDim, p.bg);
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_BT);
    ln("  %02X:%02X:%02X:%02X:%02X:%02X",
       mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
    y += 8;

    if (linked) {
      uint32_t age = (millis() - tama.lastUpdated) / 1000;
      ln("  last msg  %lus", (unsigned long)age);
    } else if (enabled) {
      spr.setTextColor(p.text, p.bg);
      ln("TO PAIR");
      spr.setTextColor(p.textDim, p.bg);
      ln(" Run codex-buddy");
      ln(" > Developer");
      ln(" > Hardware Buddy");
      y += 4;
      ln(" auto-connects via BLE");
    }

  } else {
    _infoHeader(p, y, "CREDITS", infoPage);
    spr.setTextColor(p.textDim, p.bg);
    ln("made by");
    y += 4;
    spr.setTextColor(p.text, p.bg);
    ln("Shubham Gupta");
    y += 12;
    spr.setTextColor(p.textDim, p.bg);
    ln("source");
    y += 4;
    spr.setTextColor(p.text, p.bg);
    ln("codex_buddy");
    ln("Imagen sprite pack");
    y += 12;
    spr.setTextColor(p.textDim, p.bg);
    ln("hardware");
    y += 4;
    ln("M5StickC Plus");
    ln("ESP32 + AXP192");
  }
}


// Greedy word-wrap into fixed-width rows. Continuation rows get a leading
// space. Returns number of rows written.
static uint8_t wrapInto(const char* in, char out[][24], uint8_t maxRows, uint8_t width) {
  uint8_t row = 0, col = 0;
  const char* p = in;
  while (*p && row < maxRows) {
    while (*p == ' ') p++;                     // skip leading spaces
    // measure next word
    const char* w = p;
    while (*p && *p != ' ') p++;
    uint8_t wlen = p - w;
    if (wlen == 0) break;
    uint8_t need = (col > 0 ? 1 : 0) + wlen;
    if (col + need > width) {
      out[row][col] = 0;
      if (++row >= maxRows) return row;
      out[row][0] = ' '; col = 1;              // continuation indent
    }
    if (col > 1 || (col == 1 && out[row][0] != ' ')) out[row][col++] = ' ';
    else if (col == 1 && row > 0) {}           // already have the indent space
    // hard-break words that still don't fit
    while (wlen > width - col) {
      uint8_t take = width - col;
      memcpy(&out[row][col], w, take); col += take; w += take; wlen -= take;
      out[row][col] = 0;
      if (++row >= maxRows) return row;
      out[row][0] = ' '; col = 1;
    }
    memcpy(&out[row][col], w, wlen); col += wlen;
  }
  if (col > 0 && row < maxRows) { out[row][col] = 0; row++; }
  return row;
}

static uint32_t nextAssistantCodepoint(const char*& text) {
  const uint8_t lead = (uint8_t)*text++;
  if (lead < 0x80) return lead;

  uint8_t needed = 0;
  uint32_t codepoint = 0;
  uint32_t minimum = 0;
  if ((lead & 0xE0) == 0xC0) {
    needed = 1; codepoint = lead & 0x1F; minimum = 0x80;
  } else if ((lead & 0xF0) == 0xE0) {
    needed = 2; codepoint = lead & 0x0F; minimum = 0x800;
  } else if ((lead & 0xF8) == 0xF0) {
    needed = 3; codepoint = lead & 0x07; minimum = 0x10000;
  } else {
    return '?';
  }

  const char* continuation = text;
  for (uint8_t i = 0; i < needed; i++) {
    uint8_t next = (uint8_t)continuation[i];
    if (!next || (next & 0xC0) != 0x80) return '?';
    codepoint = (codepoint << 6) | (next & 0x3F);
  }
  text = continuation + needed;
  if (codepoint < minimum || codepoint > 0x10FFFF ||
      (codepoint >= 0xD800 && codepoint <= 0xDFFF)) return '?';
  return codepoint;
}

static char assistantDisplayGlyph(uint32_t codepoint) {
  if (codepoint == '\n' || codepoint == '\r' || codepoint == '\t') {
    return (char)codepoint;
  }
  if (codepoint >= 0x20 && codepoint <= 0x7E) return (char)codepoint;
  if (codepoint == 0x00A0) return ' ';
  if (codepoint == 0x2018 || codepoint == 0x2019 ||
      codepoint == 0x201A || codepoint == 0x2032) return '\'';
  if (codepoint == 0x201C || codepoint == 0x201D ||
      codepoint == 0x201E || codepoint == 0x2033) return '"';
  if (codepoint == 0x2013 || codepoint == 0x2014 ||
      codepoint == 0x2212) return '-';
  if (codepoint == 0x2026) return '.';
  if (codepoint == 0x2022) return '*';
  if (codepoint == 0x00D7) return 'x';
  if (codepoint == 0x2190) return '<';
  if (codepoint == 0x2192) return '>';
  return '?';
}

static void drawVoiceTranscriptStatus() {
  const Palette& p = characterPalette();
  const uint8_t SHOW = 10;
  const uint8_t WIDTH = 21;
  const int LH = 8;
  const int AREA = 96;
  const int top = H - AREA;
  char rows[SHOW][WIDTH + 1] = {};
  uint8_t current = 0;
  uint8_t count = 1;
  uint8_t col = 0;

  auto nextRow = [&]() {
    rows[current][col] = 0;
    current = (current + 1) % SHOW;
    rows[current][0] = 0;
    col = 0;
    if (count < SHOW) count++;
  };

  const char* text = voiceUiDetail;
  while (*text) {
    char c = assistantDisplayGlyph(nextAssistantCodepoint(text));
    if (c == '\r') continue;
    if (c == '\n') {
      if (col > 0) nextRow();
      continue;
    }
    if (c == ' ' || c == '\t') {
      if (col == 0) continue;
      if (col >= WIDTH) nextRow();
      else rows[current][col++] = ' ';
      continue;
    }
    if (col >= WIDTH) nextRow();
    rows[current][col++] = c;
  }
  rows[current][col] = 0;

  const char* stage = "LIVE";
  if (strcmp(voiceUiState, "transcribing") == 0) stage = "FINAL";
  else if (strcmp(voiceUiState, "transcribed") == 0) stage = "SENDING";
  else if (strcmp(voiceUiState, "submitted") == 0) stage = "SENT";

  spr.fillRect(0, top, W, AREA, p.bg);
  spr.drawFastHLine(0, top, W, p.textDim);
  spr.setTextSize(1);
  spr.setTextColor(
    strcmp(voiceUiState, "submitted") == 0 ? GREEN : p.body,
    p.bg
  );
  spr.setCursor(4, top + 3);
  spr.print("YOU SAID");
  int stageWidth = spr.textWidth(stage);
  spr.setCursor(W - stageWidth - 4, top + 3);
  spr.print(stage);

  uint8_t first = count < SHOW ? 0 : (current + 1) % SHOW;
  spr.setTextColor(p.text, p.bg);
  for (uint8_t i = 0; i < count; i++) {
    uint8_t row = (first + i) % SHOW;
    spr.setCursor(4, top + 14 + i * LH);
    spr.print(rows[row]);
  }
}

static void drawVoiceStatus() {
  if (voiceUiHasTranscript && voiceUiDetail[0]) {
    drawVoiceTranscriptStatus();
    return;
  }

  const Palette& p = characterPalette();
  const int AREA = 64;
  const int top = H - AREA;
  spr.fillRect(0, top, W, AREA, p.bg);
  spr.drawFastHLine(0, top, W, p.textDim);

  const char* label = voiceUiState;
  if (strcmp(voiceUiState, "requesting") == 0) label = "starting";
  else if (strcmp(voiceUiState, "recording") == 0) label = "listening";
  else if (strcmp(voiceUiState, "transcribing") == 0) label = "thinking";
  else if (strcmp(voiceUiState, "transcribed") == 0) label = "sending";
  else if (strcmp(voiceUiState, "submitted") == 0) label = "sent";
  else if (!voiceUiOk || strcmp(voiceUiState, "error") == 0) label = "failed";

  spr.setTextSize(1);
  spr.setTextColor(p.textDim, p.bg);
  spr.setCursor(4, top + 4);
  spr.print("VOICE");

  spr.setTextSize(2);
  spr.setTextColor(!voiceUiOk ? HOT :
                   strcmp(voiceUiState, "submitted") == 0 ? GREEN : p.text,
                   p.bg);
  spr.setCursor(4, top + 14);
  spr.print(label);
  spr.setTextSize(1);

  if (voiceUiDetail[0]) {
    char rows[3][24] = {};
    uint8_t nRows = wrapInto(voiceUiDetail, rows, 3, 21);
    spr.setTextColor(p.textDim, p.bg);
    for (uint8_t i = 0; i < nRows; i++) {
      spr.setCursor(4, top + 38 + i * 8);
      spr.print(rows[i]);
    }
  }
}

// Assistant previews are cumulative, so render the newest tail rather than the
// beginning of a long response. A tiny circular row buffer avoids allocating a
// response-sized second copy on this non-PSRAM device. Decode UTF-8 here and
// map it to the classic font's safe ASCII range; passing a Unicode code point
// above 255 to this TFT library's GLCD font would read beyond its glyph table.
static void drawAssistantStatus() {
  const Palette& p = characterPalette();
  const uint8_t SHOW = 7;
  const uint8_t WIDTH = 21;
  // A 640-byte bridge preview wraps to at most 31 ordinary rows. Keep a few
  // extra rows for explicit newlines while staying tiny on this non-PSRAM ESP.
  const uint8_t MAX_ROWS = 40;
  const int LH = 8;
  const int AREA = 76;
  const int top = H - AREA;
  static char rows[MAX_ROWS][WIDTH + 1];
  memset(rows, 0, sizeof(rows));
  uint8_t current = 0;
  uint8_t count = 1;
  uint8_t col = 0;

  auto nextRow = [&]() {
    rows[current][col] = 0;
    current = (current + 1) % MAX_ROWS;
    rows[current][0] = 0;
    col = 0;
    if (count < MAX_ROWS) count++;
  };

  const char* s = tama.assistantText;
  while (*s) {
    char c = assistantDisplayGlyph(nextAssistantCodepoint(s));
    if (c == '\r') continue;
    if (c == '\n') {
      if (col > 0) nextRow();
      continue;
    }
    if (c == ' ' || c == '\t') {
      if (col == 0) continue;
      if (col >= WIDTH) nextRow();
      else rows[current][col++] = ' ';
      continue;
    }
    if (col >= WIDTH) nextRow();
    rows[current][col++] = (char)c;
  }
  rows[current][col] = 0;

  spr.fillRect(0, top, W, AREA, p.bg);
  spr.drawFastHLine(0, top, W, p.textDim);
  spr.setTextSize(1);
  spr.setTextColor(tama.assistantStreaming ? p.body :
                   tama.assistantFinal ? GREEN : p.text, p.bg);
  spr.setCursor(4, top + 3);
  spr.print(tama.assistantStreaming ? "CODEX  LIVE" :
            tama.assistantFinal ? "CODEX  DONE" : "CODEX  UPDATE");

  if (!tama.assistantText[0]) {
    spr.setTextColor(p.textDim, p.bg);
    spr.setCursor(4, top + 17);
    spr.print(tama.assistantStreaming ? "responding..." : "(empty response)");
    assistantScroll = 0;
    assistantMaxScroll = 0;
    return;
  }

  uint8_t first = count < MAX_ROWS ? 0 : (current + 1) % MAX_ROWS;
  assistantMaxScroll = count > SHOW ? count - SHOW : 0;
  if (assistantScroll > assistantMaxScroll) assistantScroll = assistantMaxScroll;

  if (assistantMaxScroll > 0) {
    spr.setTextColor(p.body, p.bg);
    if (assistantScroll == 0) {
      spr.setCursor(W - 18, top + 3);
      spr.print("B^");
    } else {
      char marker[8];
      snprintf(marker, sizeof(marker), "-%u", assistantScroll);
      spr.setCursor(W - spr.textWidth(marker) - 4, top + 3);
      spr.print(marker);
    }
  }

  int end = (int)count - assistantScroll;
  int start = end - SHOW;
  if (start < 0) start = 0;
  spr.setTextColor(p.text, p.bg);
  for (int logical = start; logical < end; logical++) {
    uint8_t row = (first + logical) % MAX_ROWS;
    spr.setCursor(4, top + 14 + (logical - start) * LH);
    spr.print(rows[row]);
  }
}

static void drawApproval() {
  const Palette& p = characterPalette();
  const int AREA = 78;
  spr.fillRect(0, H - AREA, W, AREA, p.bg);
  spr.drawFastHLine(0, H - AREA, W, p.textDim);

  spr.setTextSize(1);
  spr.setTextColor(p.textDim, p.bg);
  spr.setCursor(4, H - AREA + 4);
  uint32_t waited = (millis() - promptArrivedMs) / 1000;
  if (waited >= 10) spr.setTextColor(HOT, p.bg);
  spr.printf("approve? %lus", (unsigned long)waited);

  // Size 2 only if it fits one line (~10 chars at 12px on 135px screen)
  int toolLen = strlen(tama.promptTool);
  spr.setTextColor(p.text, p.bg);
  spr.setTextSize(toolLen <= 10 ? 2 : 1);
  spr.setCursor(4, H - AREA + (toolLen <= 10 ? 14 : 18));
  spr.print(tama.promptTool);
  spr.setTextSize(1);

  // Hint wraps at ~21 chars to two lines under the tool name
  spr.setTextColor(p.textDim, p.bg);
  int hlen = strlen(tama.promptHint);
  spr.setCursor(4, H - AREA + 34);
  spr.printf("%.21s", tama.promptHint);
  if (hlen > 21) {
    spr.setCursor(4, H - AREA + 42);
    spr.printf("%.21s", tama.promptHint + 21);
  }

  if (responseSent) {
    spr.setTextColor(p.textDim, p.bg);
    spr.setCursor(4, H - 12);
    spr.print("sent...");
  } else {
    spr.setTextColor(GREEN, p.bg);
    spr.setCursor(4, H - 12);
    spr.print("A: approve");
    spr.setTextColor(HOT, p.bg);
    spr.setCursor(W - 48, H - 12);
    spr.print("B: deny");
  }
}

static void tinyHeart(int x, int y, bool filled, uint16_t col) {
  if (filled) {
    spr.fillCircle(x - 2, y, 2, col);
    spr.fillCircle(x + 2, y, 2, col);
    spr.fillTriangle(x - 4, y + 1, x + 4, y + 1, x, y + 5, col);
  } else {
    spr.drawCircle(x - 2, y, 2, col);
    spr.drawCircle(x + 2, y, 2, col);
    spr.drawLine(x - 4, y + 1, x, y + 5, col);
    spr.drawLine(x + 4, y + 1, x, y + 5, col);
  }
}

static void drawPetStats(const Palette& p) {
  const int TOP = 70;
  spr.fillRect(0, TOP, W, H - TOP, p.bg);
  spr.setTextSize(1);
  int y = TOP + 16;

  spr.setTextColor(p.textDim, p.bg);
  spr.setCursor(6, y - 2); spr.print("mood");
  uint8_t mood = statsMoodTier();
  uint16_t moodCol = (mood >= 3) ? RED : (mood >= 2) ? HOT : p.textDim;
  for (int i = 0; i < 4; i++) tinyHeart(54 + i * 16, y + 2, i < mood, moodCol);

  y += 20;
  spr.setCursor(6, y - 2); spr.print("fed");
  uint8_t fed = statsFedProgress();
  for (int i = 0; i < 10; i++) {
    int px = 38 + i * 9;
    if (i < fed) spr.fillCircle(px, y + 1, 2, p.body);
    else spr.drawCircle(px, y + 1, 2, p.textDim);
  }

  y += 20;
  spr.setCursor(6, y - 2); spr.print("energy");
  uint8_t en = statsEnergyTier();
  uint16_t enCol = (en >= 4) ? 0x07FF : (en >= 2) ? 0xFFE0 : HOT;
  for (int i = 0; i < 5; i++) {
    int px = 54 + i * 13;
    if (i < en) spr.fillRect(px, y - 2, 9, 6, enCol);
    else spr.drawRect(px, y - 2, 9, 6, p.textDim);
  }

  y += 24;
  spr.fillRoundRect(6, y - 2, 42, 14, 3, p.body);
  spr.setTextColor(p.bg, p.body);
  spr.setCursor(11, y + 1); spr.printf("Lv %u", stats().level);

  y += 20;
  spr.setTextColor(p.textDim, p.bg);
  spr.setCursor(6, y);
  spr.printf("approved %u", stats().approvals);
  spr.setCursor(6, y + 10);
  spr.printf("denied   %u", stats().denials);
  uint32_t nap = stats().napSeconds;
  spr.setCursor(6, y + 20);
  spr.printf("napped   %luh%02lum", nap/3600, (nap/60)%60);
  auto tokFmt = [&](const char* label, uint32_t v, int yPx) {
    spr.setCursor(6, yPx);
    if (v >= 1000000)   spr.printf("%s%lu.%luM", label, v/1000000, (v/100000)%10);
    else if (v >= 1000) spr.printf("%s%lu.%luK", label, v/1000, (v/100)%10);
    else                spr.printf("%s%lu", label, v);
  };
  uint32_t shownTokens = tama.connected ? tama.tokensTotal : stats().tokens;
  tokFmt("tokens   ", shownTokens, y + 30);
  tokFmt("today    ", tama.tokensToday, y + 40);
}

static void drawPetHowTo(const Palette& p) {
  const int TOP = 70;
  spr.fillRect(0, TOP, W, H - TOP, p.bg);
  spr.setTextSize(1);
  int y = TOP + 2;
  auto ln = [&](uint16_t c, const char* s) {
    spr.setTextColor(c, p.bg); spr.setCursor(6, y); spr.print(s); y += 9;
  };
  auto gap = [&]() { y += 4; };

  y += 12;  // room for the PET header drawn by drawPet()

  ln(p.body,    "MOOD");
  ln(p.textDim, " approve fast = up");
  ln(p.textDim, " deny lots = down"); gap();

  ln(p.body,    "FED");
  ln(p.textDim, " 50K tokens =");
  ln(p.textDim, " level up + confetti"); gap();

  ln(p.body,    "ENERGY");
  ln(p.textDim, " face-down to nap");
  ln(p.textDim, " refills to full"); gap();

  ln(p.textDim, "idle 30s = off");
  ln(p.textDim, "any button = wake"); gap();

  ln(p.textDim, "A: screens  B: page");
  ln(p.textDim, "hold A: voice");
  ln(p.textDim, "hold B: menu");
}

void drawPet() {
  const Palette& p = characterPalette();
  int y = 70;

  if (petPage == 0) drawPetStats(p);
  else drawPetHowTo(p);

  // Header on top of whichever page drew — title left, counter right
  spr.setTextSize(1);
  spr.setTextColor(p.text, p.bg);
  spr.setCursor(4, y + 2);
  if (ownerName()[0]) {
    spr.printf("%s's %s", ownerName(), petName());
  } else {
    spr.print(petName());
  }
  spr.setTextColor(p.textDim, p.bg);
  spr.setCursor(W - 28, y + 2);
  spr.printf("%u/%u", petPage + 1, PET_PAGES);
}

void drawHUD() {
  if (tama.promptId[0]) { drawApproval(); return; }
  // A response from another task must not cover an active microphone session.
  // A voice failure also stays actionable. The authoritative transcript gets
  // a short guaranteed reading window while submission continues; afterward
  // assistant output supersedes terminal voice states such as "sent".
  bool voiceVisible = voiceUiVisible();
  if (voiceCaptureActive() && voiceVisible) { drawVoiceStatus(); return; }
  if (voiceVisible && !voiceUiOk) { drawVoiceStatus(); return; }
  if (voiceVisible && voiceTranscriptDwellActive()) {
    drawVoiceStatus();
    return;
  }
  if (assistantUiVisible()) { drawAssistantStatus(); return; }
  if (voiceVisible) { drawVoiceStatus(); return; }
  const Palette& p = characterPalette();
  const int SHOW = 3, LH = 8, WIDTH = 21;
  const int AREA = SHOW * LH + 4;
  spr.fillRect(0, H - AREA, W, AREA, p.bg);
  spr.setTextSize(1);

  if (tama.lineGen != lastLineGen) { msgScroll = 0; lastLineGen = tama.lineGen; wake(); }

  if (tama.nLines == 0) {
    spr.setTextColor(p.text, p.bg);
    spr.setCursor(4, H - LH - 2);
    spr.print(tama.msg);
    return;
  }

  // Wrap all transcript lines into a flat display buffer. Track which
  // transcript index each display row came from, so we can dim older ones.
  static char disp[32][24];
  static uint8_t srcOf[32];
  uint8_t nDisp = 0;
  // Bridge entries are newest-first. Flatten them oldest-to-newest so the
  // existing tail viewport lands on the newest entry and its latest rows.
  for (int i = (int)tama.nLines - 1; i >= 0 && nDisp < 32; i--) {
    uint8_t got = wrapInto(tama.lines[i], &disp[nDisp], 32 - nDisp, WIDTH);
    for (uint8_t j = 0; j < got; j++) srcOf[nDisp + j] = i;
    nDisp += got;
  }

  uint8_t maxBack = (nDisp > SHOW) ? (nDisp - SHOW) : 0;
  if (msgScroll > maxBack) msgScroll = maxBack;

  int end = (int)nDisp - msgScroll;
  int start = end - SHOW; if (start < 0) start = 0;
  uint8_t newest = 0;
  for (int i = 0; start + i < end; i++) {
    uint8_t row = start + i;
    bool fresh = (srcOf[row] == newest) && (msgScroll == 0);
    spr.setTextColor(fresh ? p.text : p.textDim, p.bg);
    spr.setCursor(4, H - AREA + 2 + i * LH);
    spr.print(disp[row]);
  }
  if (msgScroll > 0) {
    spr.setTextColor(p.body, p.bg);
    spr.setCursor(W - 18, H - LH - 2);
    spr.printf("-%u", msgScroll);
  }
}

void setup() {
  Serial.setTxBufferSize(512);
  M5.begin();
  // AXP state can survive an ESP-only reset. Always restore the LCD rail and
  // software power flags before attempting the first frame.
  M5.Axp.SetLDO2(true);
  screenOff = false;
  dimmed = false;
  M5.Lcd.setRotation(0);
  M5.Imu.Init();
  M5.Beep.begin();
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);   // off
  applyBrightness();
  lastInteractMs = millis();
  statsLoad();
  settingsLoad();
  petNameLoad();

  // Let Wi-Fi reserve its fixed RX buffers while heap is still plentiful.
  // BLE starts only after the smaller framebuffer below has been secured.
  prepareBtName();
  if (settings().wifi) wifiBridgeInit(btName);

  // An 8-bit sprite is visually sufficient for this UI and saves ~32 KiB
  // versus the default 16-bit full-screen sprite.
  spr.setColorDepth(8);
  void* spriteBuffer = spr.createSprite(W, H);
  if (!spriteBuffer) {
    Serial.printf("[display] framebuffer allocation failed (heap=%u)\n",
                  ESP.getFreeHeap());
    // Sprite operations become no-ops without a buffer, so leave a visible
    // hardware-level diagnostic on the LCD instead of a silent black screen.
    M5.Lcd.fillScreen(TFT_BLACK);
    M5.Lcd.setTextColor(TFT_RED, TFT_BLACK);
    M5.Lcd.setTextSize(1);
    M5.Lcd.setCursor(8, 96);
    M5.Lcd.println("display memory error");
    M5.Lcd.setTextColor(TFT_WHITE, TFT_BLACK);
    M5.Lcd.setCursor(8, 112);
    M5.Lcd.println("restart Xiaodex");
  } else {
    Serial.printf("[display] framebuffer ready: %dbpp, heap=%u\n",
                  spr.getColorDepth(), ESP.getFreeHeap());
  }

  // The legacy ESP32 Bluedroid stack, Wi-Fi, and a full-screen framebuffer do
  // not fit reliably at the same time on the non-PSRAM StickC Plus. Prefer the
  // authenticated Wi-Fi bridge when configured; BLE remains the fallback for
  // an unprovisioned/offline-Wi-Fi setup.
  if (!settings().bt) {
    Serial.println("[ble] disabled by setting");
  } else if (settings().wifi && wifiBridgeConfigured()) {
    Serial.println("[ble] deferred while Wi-Fi bridge is configured");
  } else {
    startBt();
  }
  if (settings().wifi && wifiBridgeConfigured() && !bleRuntimeStarted) {
    // Voice is a sustained low-latency Wi-Fi stream. On the normal provisioned
    // boot path BLE is deferred, so modem sleep can safely be disabled.
    wifiBridgeSetLowLatency(true);
    if (!voiceCaptureInit()) {
      Serial.printf("[voice] microphone warm-up deferred: %s\n",
                    voiceCaptureError());
    }
  }
  characterInitIndex(speciesIdxLoad());
  gifAvailable = characterLoaded();
  // Codex pet mode uses generated GIF assets only. If no character pack is
  // installed, the home screen shows "no character loaded".
  applyDisplayMode();

  {
    const Palette& p = characterPalette();
    spr.fillSprite(p.bg);
    spr.setTextDatum(MC_DATUM);
    spr.setTextSize(2);
    if (ownerName()[0]) {
      char line[40];
      snprintf(line, sizeof(line), "%s's", ownerName());
      spr.setTextColor(p.text, p.bg);   spr.drawString(line, W/2, H/2 - 12);
      spr.setTextColor(p.body, p.bg);   spr.drawString(petName(), W/2, H/2 + 12);
    } else {
      spr.setTextColor(p.body, p.bg);
      spr.drawString(petName(), W/2, H/2);
    }
    spr.setTextDatum(TL_DATUM); spr.setTextSize(1);
    spr.pushSprite(0, 0);
    deviceControlViewCaptureable = spriteBuffer != nullptr;
    deviceControlViewError = deviceControlViewCaptureable
      ? "" : "framebuffer unavailable";
    delay(1800);
  }

  Serial.printf("buddy: %s%s%s\n",
    gifAvailable ? "Imagen GIF character loaded" : "no GIF character loaded",
    gifAvailable ? ": " : "",
    gifAvailable ? characterPackName() : "");
}

void loop() {
  M5.update();
  M5.Beep.update();
  t++;
  uint32_t now = millis();

  uint16_t assistantSeqBeforePoll = tama.assistantSeq;
  dataPoll(&tama);
  updateMergedButtons(now, deviceCapturePhase != DEVICE_CAPTURE_IDLE);
  if (deviceControlCaptureActive()) {
    // Keep transport polling above alive, but freeze every framebuffer mutation
    // until this coherent frame has been emitted over USB.
    deviceControlCapturePoll();
    return;
  }
  uint32_t bridgeGeneration = wifiBridgeConnectionGeneration();
  if (voiceBridgeGeneration == 0) {
    voiceBridgeGeneration = bridgeGeneration;
  } else if (bridgeGeneration != voiceBridgeGeneration) {
    voiceBridgeGeneration = bridgeGeneration;
    if (voiceCaptureActive() || voiceStartAckPending || voiceCompletionPending) {
      voiceCaptureAbort();
      voiceStartAckPending = false;
      voiceStartRetryAt = 0;
      voiceCompletionPending = false;
      voicePressArmed = false;
      suppressVoiceCancelledAck = false;
      if (voicePressAttempted) voicePressErrorShown = true;
      setVoiceUi("error", "WiFi reconnected - retry A", false, 8000);
      beep(500, 80);
      triggerOneShot(P_ATTENTION, 2000);
      characterInvalidate();
    }
    // A connection generation change means the completion frame may have been
    // lost. Clear immediately instead of waiting for the inactivity fail-safe.
    // Preserve a fresh assistant frame that arrived during this same poll; it
    // belongs to the new connection.
    if (tama.assistantActive && tama.assistantStreaming &&
        tama.assistantSeq == assistantSeqBeforePoll) {
      dismissAssistantUi();
      Serial.println("[assistant] cleared after bridge reconnect");
    }
  }
  if (!tama.connected && tama.assistantActive && tama.assistantStreaming) {
    dismissAssistantUi();
    Serial.println("[assistant] cleared after bridge timeout");
  }
  if (tama.assistantActive && tama.assistantStreaming &&
      tama.assistantSeq == assistantSeqBeforePoll &&
      assistantLastUpdateAt != 0 &&
      (uint32_t)(now - assistantLastUpdateAt) > ASSISTANT_STREAM_STALE_MS) {
    dismissAssistantUi();
    Serial.println("[assistant] cleared after stream timeout");
  }
  VoiceCaptureEvent voiceEvent = voiceCapturePoll();
  if (voiceEvent == VOICE_CAPTURE_EVENT_AUTO_STOP) {
    voiceStartAckPending = false;
    voiceStartRetryAt = 0;
    voiceCompletionPending = true;
    voiceCompletionDeadline = millis() + 30000;
    setVoiceUi("transcribing", "30 second limit reached", true, 30000);
    beep(1600, 40);
    characterInvalidate();
  } else if (voiceEvent == VOICE_CAPTURE_EVENT_ERROR) {
    voiceStartAckPending = false;
    voiceStartRetryAt = 0;
    voiceCompletionPending = false;
    suppressVoiceCancelledAck = true;
    voicePressArmed = false;
    if (suppressVoiceCleanupError) {
      // A failed empty-session cleanup already reset the ambiguous socket. It
      // must not turn an ordinary A navigation tap into a voice error screen.
      suppressVoiceCleanupError = false;
    } else {
      if (voicePressAttempted) voicePressErrorShown = true;
      setVoiceUi("error", voiceCaptureError(), false, 12000);
      beep(500, 80);
      triggerOneShot(P_ATTENTION, 2000);
      characterInvalidate();
    }
  }
  if (statsPollLevelUp()) triggerOneShot(P_CELEBRATE, 3000);
  baseState = derive(tama);

  // After waking the screen, hold sleep for 12s so users see the wake-up
  // animation. Urgent states (attention, celebrate, busy) override this.
  if (baseState == P_IDLE && (int32_t)(now - wakeTransitionUntil) < 0) baseState = P_SLEEP;

  if ((int32_t)(now - oneShotUntil) >= 0) activeState = baseState;

  // LED: pulse on attention, otherwise off
  if (activeState == P_ATTENTION && settings().led) {
    digitalWrite(LED_PIN, (now / 400) % 2 ? LOW : HIGH);
  } else {
    digitalWrite(LED_PIN, HIGH);
  }

  // shake → dizzy + force scenario advance
  if (!voiceCaptureActive() && now - lastShakeCheck > 50) {
    lastShakeCheck = now;
    if (!menuOpen && !screenOff && checkShake() && (int32_t)(now - oneShotUntil) >= 0) {
      wake();
      triggerOneShot(P_DIZZY, 2000);
      Serial.println("shake: dizzy");
    }
  }

  // BtnA: step through fake scenarios
  // Prompt arrival: beep, reset response flag
  if (strcmp(tama.promptId, lastPromptId) != 0) {
    strncpy(lastPromptId, tama.promptId, sizeof(lastPromptId)-1);
    lastPromptId[sizeof(lastPromptId)-1] = 0;
    responseSent = false;
    if (tama.promptId[0]) {
      promptArrivedMs = millis();
      wake();
      beep(1200, 80);   // alert chirp
      // Jump to the approval screen no matter what was open — drawApproval
      // only runs from drawHUD which only runs in DISP_NORMAL.
      displayMode = DISP_NORMAL;
      menuOpen = settingsOpen = resetOpen = false;
      applyDisplayMode();
      characterInvalidate();
    }
  }

  bool inPrompt = tama.promptId[0] && !responseSent;

  if (tama.permissionAckSeq != lastPermissionAckSeq) {
    lastPermissionAckSeq = tama.permissionAckSeq;
    if (!tama.permissionAckOk && tama.promptId[0]) {
      responseSent = false;
      beep(500, 60);
      characterInvalidate();
    }
  }

  if (tama.voiceAckSeq != lastVoiceAckSeq) {
    lastVoiceAckSeq = tama.voiceAckSeq;
    bool staleSession = tama.voiceAckSession[0] && voiceCaptureSession()[0] &&
                        strcmp(tama.voiceAckSession, voiceCaptureSession()) != 0;
    if (staleSession) {
      Serial.printf("ignored stale voice ack for %s\n", tama.voiceAckSession);
    } else {
      const char* uiState = tama.voiceAckState;
      const char* detail = tama.voiceAckDetail;
      bool ackHasTranscript = tama.voiceAckHasText && detail[0];
      uint32_t visibleMs = 15000;
      bool showAck = true;
      bool uiOk = tama.voiceAckOk;
      if (strcmp(tama.voiceAckState, "recording") == 0) {
        voiceStartAckPending = false;
        voiceStartRetryAt = 0;
        if (voiceCompletionPending) {
          // Stop is asynchronous while the transport drains queued PCM. A
          // delayed start acknowledgement must not put the recording prompt
          // back on top after Button A has already been released.
          if (voiceCaptureActive()) voiceCaptureConfirmStart();
          uiState = "transcribing";
          if (!detail[0]) detail = "finalizing live transcript";
          visibleMs = 30000;
        } else if (voiceCaptureActive()) {
          if (voiceCaptureConfirmStart()) {
            // The remote session is pre-warmed on the press edge. Suppress its
            // early acknowledgement until the 200 ms hold is confirmed, so an
            // ordinary A navigation tap never flashes a recording screen.
            if (!voiceCaptureStreaming()) {
              showAck = false;
            // Once PCM is active, a plain start ack only confirms the session
            // and stops retries; avoid re-invalidating the existing UI.
            } else if (showAck && !detail[0] &&
                strcmp(voiceUiState, "recording") == 0) {
              showAck = false;
            } else if (showAck) {
              if (!detail[0]) detail = "streaming mic - release A";
              visibleMs = 35000;
            }
          } else {
            suppressVoiceCancelledAck = true;
            voiceCaptureCancel();
            voiceCompletionPending = false;
            uiState = "error";
            detail = voiceCaptureError();
            uiOk = false;
            visibleMs = 12000;
          }
        } else {
          // A cancel can cross a start acknowledgement on the wire. Ignore
          // that late recording ack; the following cancelled ack is terminal.
          showAck = false;
        }
      } else if (strcmp(tama.voiceAckState, "transcribing") == 0) {
        voiceStartAckPending = false;
        voiceStartRetryAt = 0;
        voiceCompletionPending = true;
        voiceCompletionDeadline = millis() + 30000;
        if (!detail[0]) detail = "finalizing live transcript";
        visibleMs = 30000;
      } else if (tama.voiceAckOk &&
                 strcmp(tama.voiceAckState, "transcribed") == 0) {
        // Realtime has produced the authoritative text. The bridge queues this
        // frame before starting turn/start, so keep it readable while Codex
        // submission and any early assistant deltas continue in the background.
        voiceStartAckPending = false;
        voiceStartRetryAt = 0;
        voiceCompletionPending = true;
        voiceCompletionDeadline = millis() + 30000;
        if (!detail[0]) detail = "transcript ready - sending";
        if (ackHasTranscript) {
          voiceTranscriptDwellUntil =
            millis() + VOICE_TRANSCRIPT_MIN_VISIBLE_MS;
        }
        visibleMs = 30000;
      } else if (tama.voiceAckOk && strcmp(tama.voiceAckState, "cancelled") == 0) {
        voiceStartAckPending = false;
        voiceStartRetryAt = 0;
        voiceCompletionPending = false;
        if (voiceCaptureActive()) voiceCaptureAbort();
        if (suppressVoiceCancelledAck) {
          // A timeout or local microphone failure already put a useful error
          // on screen. Do not replace it with the cleanup acknowledgement.
          suppressVoiceCancelledAck = false;
          showAck = false;
        } else {
          if (!detail[0]) detail = "voice capture cancelled";
          visibleMs = 4000;
        }
      } else if (tama.voiceAckOk && strcmp(tama.voiceAckState, "submitted") == 0) {
        voiceStartAckPending = false;
        voiceStartRetryAt = 0;
        voiceCompletionPending = false;
        if (ackHasTranscript && !voiceUiHasTranscript) {
          // Compatibility with a bridge that jumps directly to submitted:
          // still give the transcript a minimum reading window.
          voiceTranscriptDwellUntil =
            millis() + VOICE_TRANSCRIPT_MIN_VISIBLE_MS;
        }
        bool keepTranscriptVisible = ackHasTranscript &&
          voiceTranscriptDwellUntil != 0 &&
          (int32_t)(millis() - voiceTranscriptDwellUntil) < 0;
        // A response delta can race the submitted acknowledgement. Never put
        // the "sent" screen back on top once Codex has started responding,
        // except for the short guaranteed transcript reading window.
        if ((assistantUiVisible() || tama.assistantSeq != lastAssistantSeq) &&
            !keepTranscriptVisible) {
          showAck = false;
          dismissVoiceUi();
        } else {
          if (!detail[0]) detail = "sent to Codex";
          visibleMs = 10000;
          beep(2400, 60);
          triggerOneShot(P_HEART, 2000);
        }
      } else if (!tama.voiceAckOk || strcmp(tama.voiceAckState, "error") == 0) {
        voiceStartAckPending = false;
        voiceStartRetryAt = 0;
        voiceCompletionPending = false;
        voicePressArmed = false;
        if (voicePressAttempted) voicePressErrorShown = true;
        if (voiceCaptureActive()) voiceCaptureAbort();
        if (!detail[0]) detail = "voice request failed";
        visibleMs = 12000;
        beep(500, 80);
        triggerOneShot(P_ATTENTION, 2000);
      }
      if (showAck) {
        setVoiceUi(uiState, detail, uiOk, visibleMs, ackHasTranscript);
        wake();
        characterInvalidate();
      }
    }
  }

  if (tama.assistantSeq != lastAssistantSeq) {
    bool firstAssistant = lastAssistantSeq == 0;
    bool newItem = firstAssistant ||
                   strcmp(tama.assistantTurnId, lastAssistantTurnId) != 0 ||
                   strcmp(tama.assistantItemId, lastAssistantItemId) != 0;
    bool stateChanged = firstAssistant ||
                        tama.assistantStreaming != lastAssistantStreaming;
    lastAssistantSeq = tama.assistantSeq;
    lastAssistantStreaming = tama.assistantStreaming;
    strncpy(lastAssistantTurnId, tama.assistantTurnId,
            sizeof(lastAssistantTurnId) - 1);
    lastAssistantTurnId[sizeof(lastAssistantTurnId) - 1] = 0;
    strncpy(lastAssistantItemId, tama.assistantItemId,
            sizeof(lastAssistantItemId) - 1);
    lastAssistantItemId[sizeof(lastAssistantItemId) - 1] = 0;

    // Streaming responses remain until completion or the inactivity fail-safe.
    // Completion starts a bounded reading window from the authoritative final.
    assistantUiUntil = tama.assistantStreaming
      ? 0
      : millis() + ASSISTANT_COMPLETED_VISIBLE_MS;
    assistantLastUpdateAt = millis();

    if (newItem) {
      assistantScroll = 0;
      assistantMaxScroll = 0;
    }
    if (newItem && !voiceCaptureActive()) {
      // The first response frame is the handoff from the voice "sent" screen
      // to Codex output. Clear only the visual card: an unrelated task can
      // answer while this device's transcript is still being finalized, and
      // its protocol guards must continue to block a second recording until
      // the matching submitted/error acknowledgement arrives.
      // A currently visible failure is the exception; it outranks assistant
      // output until its own reading window expires. Likewise, keep an
      // authoritative voice transcript through its minimum reading window;
      // the assistant frames continue accumulating underneath it.
      bool preserveVoiceError = voiceUiVisible() && !voiceUiOk;
      bool preserveVoiceTranscript = voiceTranscriptDwellActive();
      if (!preserveVoiceError && !preserveVoiceTranscript) dismissVoiceUi();

      displayMode = DISP_NORMAL;
      menuOpen = settingsOpen = resetOpen = false;
      applyDisplayMode();
    }
    if (newItem || stateChanged) {
      Serial.printf("[assistant] %s bytes=%u\n",
                    tama.assistantStreaming ? "streaming" : "completed",
                    (unsigned)strlen(tama.assistantText));
    }
    wake();
  }

  // Once the guaranteed transcript dwell ends, retire its card as soon as an
  // assistant response is available. This prevents a stale "YOU SAID" card
  // from resurfacing after the assistant card's own reading window expires.
  if (!voiceCaptureActive() && voiceUiHasTranscript && assistantUiVisible() &&
      !voiceTranscriptDwellActive()) {
    dismissVoiceUi();
    characterInvalidate();
  }

  if (voiceStartAckPending &&
      (int32_t)(now - voiceStartRetryAt) >= 0 &&
      (int32_t)(now - voiceStartAckDeadline) < 0 &&
      voiceCaptureActive()) {
    if (voiceCaptureRetryStart()) {
      voiceStartRetryAt = now + 500;
    } else {
      // A duplicate start is only an idempotent ACK recovery attempt. PCM is
      // already flowing on the original ordered session, so let the normal
      // connection/error polling or the 5 s ACK deadline decide the outcome
      // rather than orphaning a valid bridge session with a local abort.
      voiceStartRetryAt = now + 500;
    }
  }

  if (voiceStartAckPending && (int32_t)(now - voiceStartAckDeadline) >= 0) {
    voiceStartAckPending = false;
    voiceStartRetryAt = 0;
    voiceCompletionPending = false;
    suppressVoiceCancelledAck = true;
    if (voicePressAttempted) voicePressErrorShown = true;
    voiceCaptureCancel(true);
    setVoiceUi("error", "no bridge response", false, 8000);
    beep(500, 80);
    triggerOneShot(P_ATTENTION, 2000);
    characterInvalidate();
  }

  if (voiceCompletionPending &&
      (int32_t)(now - voiceCompletionDeadline) >= 0) {
    voiceCompletionPending = false;
    // Recording has already stopped and the bridge owns finalization. A
    // network cancel here would destroy a valid late result and its cancelled
    // ack would overwrite this useful timeout message.
    const bool transcriptReady = strcmp(voiceUiState, "transcribed") == 0;
    setVoiceUi(
      "error",
      transcriptReady ? "Codex submission timed out" : "transcription timed out",
      false,
      10000
    );
    beep(500, 80);
    triggerOneShot(P_ATTENTION, 2000);
    characterInvalidate();
  }

  // Button-press wake. Track which button woke the screen so its full
  // press cycle (including long-press) is swallowed — you don't want
  // BtnA-to-wake to also cycle displayMode or start voice.
  if (btnAInput.isPressed() || btnBInput.isPressed()) {
    if (screenOff) {
      if (btnAInput.isPressed()) swallowBtnA = true;
      if (btnBInput.isPressed()) swallowBtnB = true;
    }
    wake();
  }

  // AXP power button (left side): short-press toggles screen off.
  // Long-press (6s) still powers off the device via AXP hardware.
  if (M5.Axp.GetBtnPress() == 0x02) {
    if (screenOff) {
      wake();
    } else {
      M5.Axp.SetLDO2(false);
      screenOff = true;
    }
  }

  // Arm a bounded local I2S pre-roll and pre-warm the ordered remote session on
  // the press edge. Audio stays local until the hold threshold; a short A tap
  // cancels the empty remote session before continuing normal navigation.
  if (btnAInput.wasPressed() && !swallowBtnA && !inPrompt &&
      !menuOverlayOpen() && !voiceStartAckPending &&
      !voiceCompletionPending && !voiceCaptureActive()) {
    voicePressAttempted = true;
    voicePressErrorShown = false;
    voicePressArmed = voiceCaptureArm();
    if (voicePressArmed) {
      suppressVoiceCancelledAck = false;
      suppressVoiceCleanupError = false;
      voiceStartAckPending = true;
      voiceStartRetryAt = millis() + 350;
      voiceStartAckDeadline = millis() + 5000;
    }
  }

  if (btnAInput.pressedFor(BTN_A_VOICE_HOLD_MS) && !btnALong && !swallowBtnA &&
      !inPrompt && !menuOverlayOpen()) {
    btnALong = true;
    if (displayMode != DISP_NORMAL) {
      displayMode = DISP_NORMAL;
      applyDisplayMode();
    }
    if (voiceCompletionPending) {
      setVoiceUi(
        "transcribing",
        "finishing previous voice",
        true,
        6000
      );
      beep(1000, 30);
    } else if (voicePressArmed && voiceCaptureStart()) {
      voicePressArmed = false;
      // A new dictation starts a new turn; retire any completed response from
      // the preceding turn so the recording UI has the screen immediately.
      dismissAssistantUi();
      suppressVoiceCancelledAck = false;
      voiceCompletionPending = false;
      setVoiceUi("recording", "release A to send", true, 35000);
      Serial.printf("voice capture started: %s\n", voiceCaptureSession());
    } else {
      // Do not retry an arm/start failure during the same physical press: that
      // would begin mid-sentence and recreate the partial-transcript bug.
      voicePressArmed = false;
      voiceStartAckPending = false;
      voiceStartRetryAt = 0;
      voiceCompletionPending = false;
      if (!voicePressErrorShown) {
        setVoiceUi("error", voiceCaptureError(), false, 10000);
        beep(500, 80);
        triggerOneShot(P_ATTENTION, 2000);
        voicePressErrorShown = true;
      }
    }
    // Keep the already-rendered character frame while live PCM is flowing.
    // The static voice overlay below does not require reopening the GIF.
    if (!voiceCaptureActive()) characterInvalidate();
  }
  if (!btnALong && !swallowBtnA) {
    handleBtnAOverlayNav(now);
  }
  if (btnAInput.wasReleased()) {
    if (!btnALong && voicePressAttempted) {
      // This remained a normal A tap. Cancel the pre-warmed empty remote
      // session, and hide its acknowledgement from the navigation UI.
      if (voicePressArmed && voiceCaptureActive()) {
        voiceStartAckPending = false;
        voiceStartRetryAt = 0;
        suppressVoiceCancelledAck = true;
        suppressVoiceCleanupError = true;
        voiceCaptureCancel();
      }
      voicePressArmed = false;
      voicePressAttempted = false;
    }
    if (btnALong && voiceCaptureActive()) {
      // If start is not acknowledged yet, preserve its retry and 5 s deadline
      // after release. UDP stays gated and queued until the ACK; the deadline
      // force-cancels even though a normal stop is already latched.
      if (voiceCaptureStop()) {
        // The worker may transmit its last complete chunk while stop waits.
        bool hadAudio = voiceCaptureSamples() > 0;
        if (hadAudio) {
          voiceCompletionPending = true;
          voiceCompletionDeadline = millis() + 30000;
          setVoiceUi("transcribing", "finalizing live transcript", true, 30000);
          // The capture reader may still be draining the release-edge tail.
          // Do not play a sound into the onboard microphone before teardown.
          Serial.printf("voice capture stopped: %lu samples\n",
                        (unsigned long)voiceCaptureSamples());
        } else {
          voiceCompletionPending = false;
          setVoiceUi("cancelled", "released too quickly", true, 4000);
        }
      } else {
        voiceCompletionPending = false;
        suppressVoiceCancelledAck = true;
        if (!voicePressErrorShown && strcmp(voiceUiState, "error") != 0) {
          setVoiceUi("error", voiceCaptureError(), false, 12000);
          beep(500, 80);
          triggerOneShot(P_ATTENTION, 2000);
        }
      }
      characterInvalidate();
    }
    if (!btnALong && !swallowBtnA && !menuOverlayOpen()) {
      if (inPrompt) {
        char cmd[96];
        snprintf(cmd, sizeof(cmd), "{\"cmd\":\"permission\",\"id\":\"%s\",\"decision\":\"once\"}", tama.promptId);
        sendCmd(cmd);
        responseSent = true;
        uint32_t tookS = (millis() - promptArrivedMs) / 1000;
        statsOnApproval(tookS);
        beep(2400, 60);
        if (tookS < 5) triggerOneShot(P_HEART, 2000);
      } else {
        beep(1800, 30);
        displayMode = (displayMode + 1) % DISP_COUNT;
        applyDisplayMode();
      }
    }
    btnALong = false;
    voicePressArmed = false;
    voicePressAttempted = false;
    voicePressErrorShown = false;
    swallowBtnA = false;
    nextBtnARepeatMs = 0;
  }

  // Outside overlays, hold B for the menu. Normal B actions run on release so
  // the firmware can distinguish a tap from this long press. Prompt denial and
  // overlay confirmation remain immediate on press.
  if (btnBInput.pressedFor(BTN_B_MENU_HOLD_MS) && !btnBLong &&
      !btnBPressHandled && !swallowBtnB && !inPrompt && !menuOverlayOpen() &&
      !voiceCaptureActive()) {
    btnBLong = true;
    btnBPressHandled = true;
    beep(800, 30);
    menuOpen = true;
    menuSel = 0;
    Serial.println("menu open");
  }

  if (btnBInput.wasPressed()) {
    if (swallowBtnB) {
      btnBPressHandled = true;
    } else if (inPrompt) {
      btnBPressHandled = true;
      char cmd[96];
      snprintf(cmd, sizeof(cmd), "{\"cmd\":\"permission\",\"id\":\"%s\",\"decision\":\"deny\"}", tama.promptId);
      sendCmd(cmd);
      responseSent = true;
      statsOnDenial();
      beep(600, 60);
    } else if (resetOpen) {
      btnBPressHandled = true;
      beep(2400, 30);
      applyReset(resetSel);
    } else if (settingsOpen) {
      btnBPressHandled = true;
      beep(2400, 30);
      applySetting(settingsSel);
    } else if (menuOpen) {
      btnBPressHandled = true;
      beep(2400, 30);
      menuConfirm();
    }
  }

  if (btnBInput.wasReleased()) {
    if (!btnBLong && !btnBPressHandled && !swallowBtnB &&
        !inPrompt && !menuOverlayOpen()) {
      if (displayMode == DISP_INFO) {
        beep(2400, 30);
        infoPage = (infoPage + 1) % INFO_PAGES;
      } else if (displayMode == DISP_PET) {
        beep(2400, 30);
        petPage = (petPage + 1) % PET_PAGES;
        applyDisplayMode();
      } else if (assistantUiVisible() &&
                 !(voiceUiVisible() &&
                   (voiceCaptureActive() || !voiceUiOk ||
                    voiceTranscriptDwellActive()))) {
        beep(2400, 30);
        assistantScroll = assistantMaxScroll == 0 ? 0 :
          (assistantScroll >= assistantMaxScroll ? 0 : assistantScroll + 1);
        // Reading interaction keeps a completed answer on screen. Streaming
        // answers already remain visible until their terminal frame arrives.
        if (!tama.assistantStreaming) {
          assistantUiUntil = millis() + ASSISTANT_COMPLETED_VISIBLE_MS;
        }
      } else {
        beep(2400, 30);
        msgScroll = (msgScroll >= 30) ? 0 : msgScroll + 1;
      }
    }
    btnBLong = false;
    btnBPressHandled = false;
    swallowBtnB = false;
  }

  bool voiceVisible = voiceUiVisible();
  bool assistantVisible = assistantUiVisible();
  static bool wasVoiceVisible = false;
  static bool wasAssistantVisible = false;
  if (voiceVisible != wasVoiceVisible) {
    // The voice overlay paints over the existing frame. Reopening and decoding
    // the GIF at recording start can stall the single transport/UI loop long
    // enough to overrun the small I2S DMA ring. Redraw fully when voice ends.
    if (!voiceCaptureActive()) characterInvalidate();
    wasVoiceVisible = voiceVisible;
  }
  if (assistantVisible != wasAssistantVisible) {
    if (!voiceCaptureActive()) characterInvalidate();
    wasAssistantVisible = assistantVisible;
  }

  // blink bookkeeping

  // Charging clock: takes over the home screen when on USB power, no
  // overlays, no prompt, no live Codex data, and the RTC has been set
  // by the bridge. Pet sleeps underneath. Exit restores Y via
  // applyDisplayMode() so the next mode-switch isn't visually offset.
  clockRefreshRtc();   // 1Hz internal throttle; also caches _onUsb
  // Show the clock when nothing is happening — bridge heartbeat alone
  // doesn't count as activity (it's the only way to get the RTC synced).
  bool clocking = chargingClockVisible(displayMode == DISP_NORMAL
               && !menuOpen && !settingsOpen && !resetOpen && !inPrompt
               && !voiceVisible && !assistantVisible
               && tama.sessionsRunning == 0 && tama.sessionsWaiting == 0
               && dataRtcValid() && _onUsb, now, oneShotUntil);
  if (clocking) clockUpdateOrient();
  else { clockOrient = 0; orientFrames = 0; paintedOrient = 0; }
  bool landscapeClock = clocking && clockOrient != 0;

  static bool wasClocking = false;
  static bool wasLandscape = false;
  if (clocking != wasClocking || landscapeClock != wasLandscape) {
    if (clocking && !landscapeClock) characterSetPeek(true);
    else applyDisplayMode();
    wasClocking = clocking;
    wasLandscape = landscapeClock;
  }
  if (clocking) {
    uint8_t dow = clockDow();
    bool weekend = (dow == 0 || dow == 6);
    bool friday  = (dow == 5);

    uint8_t h = _clkTm.Hours;
    if (h >= 1 && h < 7)             activeState = P_SLEEP;
    else if (weekend)                activeState = (now/8000 % 6 == 0) ? P_HEART : P_SLEEP;
    else if (h < 9)                  activeState = (now/6000 % 4 == 0) ? P_IDLE  : P_SLEEP;
    else if (h == 12)                activeState = (now/5000 % 3 == 0) ? P_HEART : P_IDLE;
    else if (friday && h >= 15)      activeState = (now/4000 % 3 == 0) ? P_CELEBRATE : P_IDLE;
    else if (h >= 22 || h == 0)      activeState = (now/7000 % 3 == 0) ? P_DIZZY : P_SLEEP;
    else                             activeState = (now/10000 % 5 == 0) ? P_SLEEP : P_IDLE;
  }

  static uint32_t lastPasskey = 0;
  uint32_t pk = blePasskey();
  if (pk && !lastPasskey) { wake(); beep(1800, 60); }
  lastPasskey = pk;

  bool overlayOpen = menuOpen || settingsOpen || resetOpen;
  bool voiceTransportActive = voiceCaptureActive();
  // The recording overlay is static. Limit LCD SPI traffic to 10 fps and
  // freeze GIF decoding while I2S capture and UDP streaming are latency-sensitive.
  // The first recording frame paints immediately, and normal UI remains 60 fps.
  static uint32_t nextVoicePaintMs = 0;
  bool paintSprite = true;
  if (voiceTransportActive) {
    if (nextVoicePaintMs != 0 && (int32_t)(now - nextVoicePaintMs) < 0) {
      paintSprite = false;
    } else {
      nextVoicePaintMs = now + 100;
    }
  } else {
    nextVoicePaintMs = 0;
  }
  if (napping || screenOff || landscapeClock) {
    // skip sprite render — face-down, powered off, or landscape clock
    // (which draws direct-to-LCD below)
  } else if (characterLoaded()) {
    if (!overlayOpen && !voiceTransportActive) {
      characterSetState(activeState);
      characterTick();
    }
  } else if (paintSprite) {
    const Palette& p = characterPalette();
    spr.fillSprite(p.bg);
    spr.setTextColor(p.textDim, p.bg);
    spr.setTextSize(1);
    if (xferActive()) {
      uint32_t done = xferProgress(), total = xferTotal();
      spr.setCursor(8, 90);
      spr.print("installing");
      spr.setCursor(8, 102);
      spr.printf("%luK / %luK", done/1024, total/1024);
      int barW = W - 16;
      spr.drawRect(8, 116, barW, 8, p.textDim);
      if (total > 0) {
        int fill = (int)((uint64_t)barW * done / total);
        if (fill > 1) spr.fillRect(9, 117, fill - 1, 6, p.body);
      }
    } else {
      spr.setCursor(8, 100);
      spr.print("no character loaded");
    }
  }
  if (landscapeClock) {
    drawClock();
  } else if (!napping && !screenOff && paintSprite) {
    if (blePasskey()) drawPasskey();
    else if (clocking) drawClock();
    else if (displayMode == DISP_INFO) drawInfo();
    else if (displayMode == DISP_PET) drawPet();
    else if (settings().hud || tama.promptId[0] ||
             voiceVisible || assistantVisible) drawHUD();
    if (resetOpen) drawReset();
    else if (settingsOpen) drawSettings();
    else if (menuOpen) drawMenu();
    spr.pushSprite(0, 0);
    deviceControlFramePresented();
  }
  if (landscapeClock) {
    deviceControlViewCaptureable = false;
    deviceControlViewError = "landscape clock uses direct LCD rendering";
  } else if (screenOff) {
    deviceControlViewCaptureable = false;
    deviceControlViewError = "screen is off";
  } else if (napping) {
    deviceControlViewCaptureable = false;
    deviceControlViewError = "device is face-down";
  } else {
    deviceControlViewCaptureable = spr.getColorDepth() == 8 &&
                                   spr.frameBuffer(1) != nullptr;
    deviceControlViewError = deviceControlViewCaptureable
      ? "" : "framebuffer unavailable";
  }

  // Face-down nap: dim immediately, pause animations, accumulate sleep time.
  // Skipped during approval — you're holding it to read, not sleeping it.
  // Exit needs sustained not-down so IMU noise at the threshold doesn't
  // bounce brightness between 8 and full every few frames.
  static int8_t faceDownFrames = 0;
  if (!inPrompt && !voiceVisible && !assistantVisible) {
    bool down = isFaceDown();
    if (down)       { if (faceDownFrames < 20) faceDownFrames++; }
    else            { if (faceDownFrames > -10) faceDownFrames--; }
  }

  if (!napping && faceDownFrames >= 15) {
    napping = true;
    napStartMs = now;
    M5.Axp.ScreenBreath(8);
    dimmed = true;
  } else if (napping && faceDownFrames <= -8) {
    napping = false;
    statsOnNapEnd((now - napStartMs) / 1000);
    statsOnWake();
    wake();
  }

  // millis() not the cached `now`: wake() runs after `now` is captured,
  // so now - lastInteractMs underflows when a button is held → flicker.
  // No auto-off on USB power — clock face wants to stay visible while charging.
  if (!screenOff && !inPrompt && !voiceVisible && !assistantVisible && !_onUsb
      && millis() - lastInteractMs > SCREEN_OFF_MS) {
    M5.Axp.SetLDO2(false);
    screenOff = true;
  }

  // A capture request normally transitions to BEGIN at the preceding
  // pushSprite(). If no sprite could be presented, fail explicitly instead of
  // leaving the host blocked and every later request permanently "busy".
  if (deviceCapturePhase == DEVICE_CAPTURE_REQUESTED) {
    if (voiceCaptureActive() || voiceStartAckPending) {
      rejectRequestedCapture("voice session active");
    } else if (screenOff) {
      rejectRequestedCapture("screen is off");
    } else if (napping) {
      rejectRequestedCapture("device is face-down");
    } else if (landscapeClock) {
      rejectRequestedCapture("landscape clock uses direct LCD rendering");
    } else if ((uint32_t)(millis() - deviceCaptureRequestedAt) > 1500) {
      rejectRequestedCapture("screen frame was not presented");
    }
  }

  // The audio worker now captures independently, but a short UI loop still
  // samples Button A release promptly and drains bridge acknowledgements.
  asyncCapture.poll();
  delay(screenOff ? 100 : (voiceCaptureActive() ? 1 : 16));
}
