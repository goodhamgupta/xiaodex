// MPU6886 tilt, physical A/B buttons, and USB test controls for Xiaodex Doom.
#include <Arduino.h>
#include <Wire.h>
#include <ctype.h>
#include <string.h>
#include <esp_heap_caps.h>
#include "doomport.h"

extern "C" {
#include "doomdef.h"
#include "doomtype.h"
#include "d_event.h"
#include "g_game.h"
void D_PostEvent(event_t* event);
int DoomCurrentEpisode(void);
int DoomCurrentMap(void);
unsigned int DoomZoneSize(void);
unsigned int DoomZoneFree(void);
unsigned int DoomZoneLargest(void);
unsigned int DoomDrawsegOverflows(void);
unsigned int DoomOpeningOverflows(void);
unsigned int DoomVisspriteOverflows(void);
void DoomShowPhysicalPrompt(void);
int DoomPlayerX(void);
int DoomPlayerY(void);
unsigned int DoomPlayerAngle(void);
int DoomPlayerState(void);
int DoomPlayerHealth(void);
int DoomKillPlayer(void);
}

#define BUTTON_A 37
#define BUTTON_B 39
#define IMU_ADDRESS 0x68
#define IMU_WHO_AM_I 0x75
#define IMU_ACCEL_XOUT_H 0x3B

#define TILT_ENTER_G 0.20f
#define TILT_RELEASE_G 0.12f
#define BUTTON_B_LONG_MS 650
#define BUTTON_PULSE_MS 100
#define SERIAL_KEY_HOLD_MS 180
#define POWER_POLL_MS 100
#define MAX_SERIAL_KEYS 8

struct RemoteButton {
    bool down;
    uint32_t releaseAt;
};

struct SerialKey {
    int key;
    uint32_t releaseAt;
};

static RemoteButton s_remoteA;
static RemoteButton s_remoteB;
static SerialKey s_serialKeys[MAX_SERIAL_KEYS];
static bool s_keyState[11];
static bool s_imuReady;
static float s_baselineX;
static float s_baselineY;
static float s_filteredX;
static float s_filteredY;
static float s_latestDx;
static float s_latestDy;
static bool s_bWasDown;
static bool s_bLong;
static bool s_physicalA;
static bool s_physicalB;
static bool s_physicalTest;
static uint32_t s_lastPowerPoll;
static uint32_t s_bDownAt;
static uint32_t s_usePulseUntil;

static char s_serialLine[384];
static size_t s_serialLineLength;
static bool s_jsonLine;

static void postKey(int key, bool down)
{
    if (key < 1 || key > 10 || s_keyState[key] == down)
        return;
    s_keyState[key] = down;
    event_t event = {};
    event.type = down ? ev_keydown : ev_keyup;
    event.data1 = key;
    D_PostEvent(&event);
}

static bool i2cWrite(uint8_t reg, uint8_t value)
{
    Wire1.beginTransmission(IMU_ADDRESS);
    Wire1.write(reg);
    Wire1.write(value);
    return Wire1.endTransmission() == 0;
}

static bool i2cRead(uint8_t reg, uint8_t* data, size_t length)
{
    Wire1.beginTransmission(IMU_ADDRESS);
    Wire1.write(reg);
    if (Wire1.endTransmission(false) != 0)
        return false;
    if (Wire1.requestFrom((int)IMU_ADDRESS, (int)length) != (int)length)
        return false;
    for (size_t i = 0; i < length; i++)
        data[i] = Wire1.read();
    return true;
}

static bool readAccel(float* x, float* y)
{
    uint8_t raw[6];
    if (!i2cRead(IMU_ACCEL_XOUT_H, raw, sizeof(raw)))
        return false;
    int16_t ax = (int16_t)((raw[0] << 8) | raw[1]);
    int16_t ay = (int16_t)((raw[2] << 8) | raw[3]);
    *x = ax / 16384.0f;
    *y = ay / 16384.0f;
    return true;
}

static void calibrateImu(void)
{
    float sumX = 0;
    float sumY = 0;
    int samples = 0;
    for (int i = 0; i < 32; i++) {
        float x, y;
        if (readAccel(&x, &y)) {
            sumX += x;
            sumY += y;
            samples++;
        }
        delay(5);
    }
    if (samples) {
        s_baselineX = sumX / samples;
        s_baselineY = sumY / samples;
        s_filteredX = s_baselineX;
        s_filteredY = s_baselineY;
    }
    Serial.printf("[imu] calibrated x=%.3f y=%.3f samples=%d\n",
                  s_baselineX, s_baselineY, samples);
}

static bool axisPositive(float value, bool active)
{
    return value > (active ? TILT_RELEASE_G : TILT_ENTER_G);
}

static bool axisNegative(float value, bool active)
{
    return value < -(active ? TILT_RELEASE_G : TILT_ENTER_G);
}

static int serialCharToKey(int value)
{
    switch (value) {
        case 'w': case 'W': return KEYD_UP;
        case 's': case 'S': return KEYD_DOWN;
        case 'a': case 'A': return KEYD_LEFT;
        case 'd': case 'D': return KEYD_RIGHT;
        case 'q': case 'Q': return KEYD_L;
        case 'e': case 'E': return KEYD_R;
        case 'f': case 'F': return KEYD_B;
        case ' ': return KEYD_A;
        case 'm': case 'M': case '\r': case '\n': return KEYD_START;
        case 't': case 'T': case '\t': return KEYD_SELECT;
        default: return -1;
    }
}

static bool extractJsonString(const char* json, const char* key,
                              char* output, size_t capacity)
{
    char pattern[48];
    snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
    const char* begin = strstr(json, pattern);
    if (!begin)
        return false;
    begin += strlen(pattern);
    const char* end = strchr(begin, '"');
    if (!end || end == begin || (size_t)(end - begin) >= capacity)
        return false;
    size_t length = end - begin;
    for (size_t i = 0; i < length; i++) {
        unsigned char c = begin[i];
        if (!(isalnum(c) || c == '-' || c == '_' || c == '.'))
            return false;
    }
    memcpy(output, begin, length);
    output[length] = 0;
    return true;
}

static int extractJsonInt(const char* json, const char* key, int fallback)
{
    char pattern[48];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char* value = strstr(json, pattern);
    if (!value)
        return fallback;
    return atoi(value + strlen(pattern));
}

static void deviceError(const char* id, const char* operation, const char* message)
{
    Serial.printf("{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\","
                  "\"op\":\"%s\",\"state\":\"error\",\"error\":\"%s\"}\n",
                  id, operation, message);
}

static void applyRemoteButton(RemoteButton* button, const char* action,
                              int durationMs, uint32_t now)
{
    if (!strcmp(action, "release")) {
        button->down = false;
        button->releaseAt = 0;
    } else if (!strcmp(action, "press")) {
        button->down = true;
        button->releaseAt = 0;
    } else if (!strcmp(action, "tap")) {
        button->down = true;
        button->releaseAt = now + BUTTON_PULSE_MS;
    } else {
        button->down = true;
        button->releaseAt = now + durationMs;
    }
}

static void handleJsonLine(const char* line)
{
    if (strstr(line, "\"cmd\":\"status\"")) {
        Serial.printf("{\"ack\":\"status\",\"ok\":true,\"data\":{"
                      "\"name\":\"Xiaodex DOOM\",\"doom\":true,"
                      "\"imu\":%s,\"tilt_x\":%.3f,\"tilt_y\":%.3f,"
                      "\"button_a\":%s,\"button_b\":%s,"
                      "\"episode\":%d,\"map\":%d,\"zone_bytes\":%u,"
                      "\"zone_free\":%u,\"zone_largest\":%u,"
                      "\"drawseg_overflows\":%u,\"opening_overflows\":%u,"
                      "\"vissprite_overflows\":%u,"
                      "\"player_x\":%d,\"player_y\":%d,\"player_angle\":%u,"
                      "\"player_state\":%d,\"player_health\":%d,"
                      "\"stack_free\":%u,\"heap_free\":%u,"
                      "\"heap_8bit_free\":%u,\"heap_8bit_largest\":%u}}\n",
                      s_imuReady ? "true" : "false", s_latestDx, s_latestDy,
                      s_physicalA ? "true" : "false",
                      s_physicalB ? "true" : "false",
                      DoomCurrentEpisode(), DoomCurrentMap(),
                      DoomZoneSize(),
                      DoomZoneFree(), DoomZoneLargest(),
                      DoomDrawsegOverflows(), DoomOpeningOverflows(),
                      DoomVisspriteOverflows(),
                      DoomPlayerX(), DoomPlayerY(), DoomPlayerAngle(),
                      DoomPlayerState(), DoomPlayerHealth(),
                      (unsigned)(uxTaskGetStackHighWaterMark(nullptr) * sizeof(StackType_t)),
                      (unsigned)ESP.getFreeHeap(),
                      (unsigned)heap_caps_get_free_size(
                          MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                      (unsigned)heap_caps_get_largest_free_block(
                          MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        return;
    }

    if (!strstr(line, "\"cmd\":\"device_control\""))
        return;

    char id[40];
    char operation[16];
    if (!extractJsonString(line, "id", id, sizeof(id)) ||
        !extractJsonString(line, "op", operation, sizeof(operation)))
        return;

    if (!strcmp(operation, "capture")) {
        DisplaySendCapture(id);
        return;
    }
    if (!strcmp(operation, "warp")) {
        int map = extractJsonInt(line, "map", 0);
        if (map < 1 || map > 9) {
            deviceError(id, operation, "map must be between 1 and 9");
            return;
        }
        // Defer through Doom's normal gameaction path. This request is handled
        // inside I_StartTic, so loading synchronously here would mutate level
        // state underneath the current tick.
        G_DeferedInitNew(sk_medium, 1, map);
        Serial.printf("{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\","
                      "\"op\":\"warp\",\"state\":\"accepted\",\"ok\":true,"
                      "\"episode\":1,\"map\":%d}\n", id, map);
        return;
    }
    if (!strcmp(operation, "physical_test") || !strcmp(operation, "physical_end")) {
        s_physicalTest = !strcmp(operation, "physical_test");
        Serial.printf("{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\","
                      "\"op\":\"%s\",\"state\":\"accepted\",\"ok\":true}\n",
                      id, operation);
        return;
    }
    if (!strcmp(operation, "kill")) {
        if (!DoomKillPlayer()) {
            deviceError(id, operation, "player is not alive");
            return;
        }
        Serial.printf("{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\","
                      "\"op\":\"kill\",\"state\":\"accepted\",\"ok\":true}\n",
                      id);
        return;
    }
    if (!strcmp(operation, "power_off")) {
        Serial.printf("{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\","
                      "\"op\":\"power_off\",\"state\":\"accepted\",\"ok\":true}\n",
                      id);
        Serial.flush();
        delay(30);
        DisplayPowerOff();
        return;
    }
    if (strcmp(operation, "button")) {
        deviceError(id, operation, "unsupported operation");
        return;
    }

    char name[4];
    char action[12];
    if (!extractJsonString(line, "button", name, sizeof(name)) ||
        !extractJsonString(line, "action", action, sizeof(action)) ||
        (strcmp(name, "A") && strcmp(name, "B"))) {
        deviceError(id, operation, "invalid button request");
        return;
    }
    bool knownAction = !strcmp(action, "tap") || !strcmp(action, "press") ||
                       !strcmp(action, "release") || !strcmp(action, "hold");
    if (!knownAction) {
        deviceError(id, operation, "invalid button action");
        return;
    }
    int duration = extractJsonInt(line, "duration_ms", 1000);
    if (!strcmp(action, "hold") && (duration < 50 || duration > 30000)) {
        deviceError(id, operation, "invalid hold duration");
        return;
    }

    applyRemoteButton(!strcmp(name, "A") ? &s_remoteA : &s_remoteB,
                      action, duration, millis());
    Serial.printf("{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\","
                  "\"op\":\"button\",\"state\":\"accepted\",\"ok\":true,"
                  "\"button\":\"%s\",\"action\":\"%s\"}\n",
                  id, name, action);
}

static void pulseSerialKey(int key, uint32_t now)
{
    int freeSlot = -1;
    for (int i = 0; i < MAX_SERIAL_KEYS; i++) {
        if (s_serialKeys[i].key == key) {
            s_serialKeys[i].releaseAt = now + SERIAL_KEY_HOLD_MS;
            return;
        }
        if (freeSlot < 0 && s_serialKeys[i].key < 0)
            freeSlot = i;
    }
    if (freeSlot >= 0) {
        s_serialKeys[freeSlot].key = key;
        s_serialKeys[freeSlot].releaseAt = now + SERIAL_KEY_HOLD_MS;
    }
}

static void pollSerial(uint32_t now)
{
    while (Serial.available()) {
        int value = Serial.read();
        if (s_jsonLine) {
            if (value == '\n') {
                s_serialLine[s_serialLineLength] = 0;
                handleJsonLine(s_serialLine);
                s_serialLineLength = 0;
                s_jsonLine = false;
            } else if (value != '\r') {
                if (s_serialLineLength + 1 < sizeof(s_serialLine))
                    s_serialLine[s_serialLineLength++] = (char)value;
                else {
                    s_serialLineLength = 0;
                    s_jsonLine = false;
                }
            }
            continue;
        }
        if (value == '{') {
            s_jsonLine = true;
            s_serialLineLength = 0;
            s_serialLine[s_serialLineLength++] = '{';
            continue;
        }
        int key = serialCharToKey(value);
        if (key >= 0)
            pulseSerialKey(key, now);
    }
}

void InputInit(void)
{
    pinMode(BUTTON_A, INPUT);
    pinMode(BUTTON_B, INPUT);
    pinMode(10, OUTPUT);
    digitalWrite(10, HIGH);
    for (int i = 0; i < MAX_SERIAL_KEYS; i++)
        s_serialKeys[i].key = -1;

    uint8_t who = 0;
    s_imuReady = i2cRead(IMU_WHO_AM_I, &who, 1) && who == 0x19;
    if (s_imuReady) {
        i2cWrite(0x6B, 0x00);
        delay(10);
        i2cWrite(0x6B, 0x80);
        delay(10);
        i2cWrite(0x6B, 0x01);
        delay(10);
        i2cWrite(0x1C, 0x00); // +/-2g, 16384 LSB/g
        i2cWrite(0x1A, 0x01);
        i2cWrite(0x19, 0x05);
        calibrateImu();
    } else {
        Serial.printf("[imu] MPU6886 unavailable (WHO_AM_I=0x%02x)\n", who);
    }
}

void InputPoll(void)
{
    uint32_t now = millis();
    s_physicalA = digitalRead(BUTTON_A) == LOW;
    s_physicalB = digitalRead(BUTTON_B) == LOW;
    pollSerial(now);

    if (now - s_lastPowerPoll >= POWER_POLL_MS) {
        s_lastPowerPoll = now;
        unsigned char powerEvent = DisplayPollPowerButton();
        if (powerEvent & 0x01) {
            Serial.println("[power] AXP192 long press; shutting down");
            Serial.flush();
            DisplayPowerOff();
        }
    }

    if (s_remoteA.releaseAt && (int32_t)(now - s_remoteA.releaseAt) >= 0)
        s_remoteA = {};
    if (s_remoteB.releaseAt && (int32_t)(now - s_remoteB.releaseAt) >= 0)
        s_remoteB = {};

    bool desired[11] = {};
    bool aDown = s_physicalA || s_remoteA.down;
    bool bDown = s_physicalB || s_remoteB.down;
    desired[KEYD_B] = aDown;

    if (bDown && !s_bWasDown) {
        s_bDownAt = now;
        s_bLong = false;
    }
    if (bDown && !s_bLong && now - s_bDownAt >= BUTTON_B_LONG_MS)
        s_bLong = true;
    if (!bDown && s_bWasDown) {
        if (!s_bLong)
            s_usePulseUntil = now + BUTTON_PULSE_MS;
        s_bLong = false;
    }
    s_bWasDown = bDown;
    desired[KEYD_START] = bDown && s_bLong;
    if (s_usePulseUntil && (int32_t)(now - s_usePulseUntil) >= 0)
        s_usePulseUntil = 0;
    desired[KEYD_A] = s_usePulseUntil != 0;

    if (s_imuReady) {
        float x, y;
        if (readAccel(&x, &y)) {
            s_filteredX = s_filteredX * 0.72f + x * 0.28f;
            s_filteredY = s_filteredY * 0.72f + y * 0.28f;
            float dx = s_filteredX - s_baselineX;
            float dy = s_filteredY - s_baselineY;
            s_latestDx = dx;
            s_latestDy = dy;
            desired[KEYD_UP] = axisNegative(dx, s_keyState[KEYD_UP]);
            desired[KEYD_DOWN] = axisPositive(dx, s_keyState[KEYD_DOWN]);
            desired[KEYD_LEFT] = axisNegative(dy, s_keyState[KEYD_LEFT]);
            desired[KEYD_RIGHT] = axisPositive(dy, s_keyState[KEYD_RIGHT]);
        }
    }

    for (int i = 0; i < MAX_SERIAL_KEYS; i++) {
        if (s_serialKeys[i].key < 0)
            continue;
        if ((int32_t)(now - s_serialKeys[i].releaseAt) >= 0) {
            s_serialKeys[i].key = -1;
        } else {
            desired[s_serialKeys[i].key] = true;
        }
    }

    for (int key = 1; key <= 10; key++)
        postKey(key, desired[key]);

    if (s_physicalTest) {
        DoomShowPhysicalPrompt();
        digitalWrite(10, ((now / 300) & 1) ? LOW : HIGH);
    } else {
        digitalWrite(10, HIGH);
    }
}
