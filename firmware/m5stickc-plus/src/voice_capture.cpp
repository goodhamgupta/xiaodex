#include "voice_capture.h"

#include <driver/gpio.h>
#include <driver/i2s.h>
#include <esp_idf_version.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <string.h>

#include "wifi_bridge.h"
#include "voice_tcp_frame.h"

namespace {

constexpr i2s_port_t MIC_I2S_PORT = I2S_NUM_0;
constexpr gpio_num_t MIC_CLK_PIN = GPIO_NUM_0;
constexpr gpio_num_t MIC_DATA_PIN = GPIO_NUM_34;
// Capture mono PCM16 at the bridge wire rate. The ESP32 only packetizes these
// samples; it does not resample, compress, or transcribe them.
constexpr uint32_t SAMPLE_RATE = 16000;
constexpr uint32_t MAX_CAPTURE_MS = 30000;
// The microphone reader drains one 30 ms block at a time. The transport worker
// sends that block as one bounded JSON/base64 frame over ordered TCP.
// Resampling and transcription remain on the bridge/API.
constexpr size_t CAPTURE_CHUNK_BYTES = 960;
constexpr uint32_t CAPTURE_CHUNK_SAMPLES =
    CAPTURE_CHUNK_BYTES / sizeof(int16_t);
constexpr uint32_t CAPTURE_CHUNK_MS =
    CAPTURE_CHUNK_SAMPLES * 1000U / SAMPLE_RATE;
static_assert(CAPTURE_CHUNK_BYTES % sizeof(int16_t) == 0,
              "PCM chunks must contain complete 16-bit samples");
static_assert(CAPTURE_CHUNK_SAMPLES * 1000U == SAMPLE_RATE * 30U,
              "voice UDP chunks must remain exactly 30 ms");
// Twenty-eight fixed 30 ms slots cover 840 ms: the 200 ms hold pre-roll plus
// start-ACK scheduling and Wi-Fi jitter. This is a live backpressure queue,
// not a whole-recording buffer; a stalled link fails the turn instead of
// dropping microphone data.
constexpr uint8_t PCM_SLOT_COUNT = 28;
constexpr uint32_t PCM_QUEUE_COVERAGE_MS =
    PCM_SLOT_COUNT * CAPTURE_CHUNK_MS;
static_assert(PCM_QUEUE_COVERAGE_MS >= 800,
              "voice PCM queue must retain at least 800 ms");
constexpr uint32_t VOICE_START_DEBOUNCE_MS = 60;
// The dedicated high-priority reader drains every 30 ms into the PCM queue.
// The DMA ring covers 128 ms, enough for brief scheduler jitter without using
// scarce internal heap that the bounded 800 ms transport queue needs.
constexpr uint8_t DMA_BUFFER_COUNT = 16;
constexpr uint8_t DMA_BUFFER_SAMPLES = 128;
// RX_DONE is emitted for every completed DMA buffer. Leave enough queue room
// for those notifications plus an overflow/error event so failure reporting
// cannot itself be crowded out by a full notification queue.
constexpr UBaseType_t I2S_EVENT_QUEUE_LENGTH = 32;
constexpr uint32_t MAX_CAPTURE_DEFICIT_MS = 80;
// Allow a complete 30 ms chunk to arrive even when the read starts against an
// empty DMA ring. The final release-edge read may still return a shorter tail.
constexpr TickType_t I2S_READ_TICKS =
    pdMS_TO_TICKS(CAPTURE_CHUNK_MS + 10);
constexpr TickType_t CAPTURE_JOIN_TICKS = pdMS_TO_TICKS(750);
constexpr uint32_t TCP_CONTROL_TIMEOUT_MS = 400;
constexpr uint32_t VOICE_HOLD_PREROLL_MS = 200;
constexpr uint8_t VOICE_HOLD_PREROLL_PACKETS =
    (VOICE_HOLD_PREROLL_MS + CAPTURE_CHUNK_MS - 1) / CAPTURE_CHUNK_MS;
static_assert(VOICE_HOLD_PREROLL_PACKETS == 7,
              "a 200 ms pre-roll should occupy seven 30 ms packets");
// The 200 ms pre-roll normally releases seven frames at once. Pace only
// that initial, normal-sized burst so the Wi-Fi driver can recycle TX buffers.
// A larger backlog needs maximum throughput and receives no artificial delay.
constexpr TickType_t UDP_BACKLOG_PACE_TICKS = pdMS_TO_TICKS(4);
constexpr uint8_t UDP_BACKLOG_PACE_MAX_SLOTS =
    VOICE_HOLD_PREROLL_PACKETS * 2;
constexpr uint8_t initialBacklogPacePackets(uint8_t queued) {
  return queued <= UDP_BACKLOG_PACE_MAX_SLOTS ? queued : 0;
}
static_assert(initialBacklogPacePackets(0) == 0,
              "live one-packet streaming must not be paced");
static_assert(initialBacklogPacePackets(VOICE_HOLD_PREROLL_PACKETS) ==
                  VOICE_HOLD_PREROLL_PACKETS,
              "normal hold pre-roll must be paced");
static_assert(initialBacklogPacePackets(UDP_BACKLOG_PACE_MAX_SLOTS + 1) == 0,
              "a large backlog must drain at full speed");
constexpr uint32_t WORKER_STACK_BYTES = 6144;
constexpr UBaseType_t WORKER_PRIORITY = 3;
constexpr BaseType_t WORKER_CORE = 1;
constexpr uint32_t READER_STACK_BYTES = 3072;
constexpr UBaseType_t READER_PRIORITY = 4;
constexpr BaseType_t READER_CORE = 1;

enum StopReason : uint8_t {
  STOP_NONE = 0,
  STOP_NORMAL,
  STOP_CANCEL,
  STOP_ABORT,
  STOP_AUTO,
};

volatile bool active = false;
volatile bool streaming = false;
volatile bool holdConfirmed = false;
// The ordered remote start line is sent while audio is still being retained in
// the local pre-roll. Keep that state separate from `streaming`, which means
// the 200 ms hold was confirmed and PCM may be flushed to the bridge.
volatile bool remoteSessionStarted = false;
volatile bool startConfirmed = false;
// True only while the main task is writing the ordered remote start line. If
// capture fails concurrently, the worker waits for that commit decision before
// deciding whether a bridge session must be cancelled.
volatile bool remoteStartPending = false;
volatile bool retryStartRequested = false;
volatile bool workerRunning = false;
volatile bool readerRunning = false;
volatile bool captureDone = false;
volatile bool captureFailed = false;
volatile StopReason stopReason = STOP_NONE;
volatile VoiceCaptureEvent pendingEvent = VOICE_CAPTURE_EVENT_NONE;
volatile bool lastWorkerResult = false;
bool i2sInstalled = false;
bool captureUnavailable = false;
uint32_t startedMs = 0;
volatile uint32_t stopRequestedMs = 0;
volatile uint32_t sequence = 0;
volatile uint32_t samples = 0;
volatile uint32_t capturedSamples = 0;
volatile uint8_t maxQueuedSlots = 0;
char session[9] = "";
char lastError[64] = "";

TaskHandle_t workerTask = nullptr;
TaskHandle_t readerTask = nullptr;
QueueHandle_t i2sEvents = nullptr;
QueueHandle_t freePcmSlots = nullptr;
QueueHandle_t filledPcmSlots = nullptr;
portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;

struct PcmSlot {
  uint16_t len;
  uint8_t data[CAPTURE_CHUNK_BYTES];
};

// The reader owns a slot from the free queue until it publishes that index to
// the filled queue. The transport worker sends that slot as one TCP frame
// and returns it to the pool. The reader never waits on the socket itself.
PcmSlot* pcmSlots = nullptr;

void setError(const char* message) {
  strncpy(lastError, message ? message : "voice capture failed",
          sizeof(lastError) - 1);
  lastError[sizeof(lastError) - 1] = 0;
}

bool sendJsonLine(const char* line, size_t len) {
  if (wifiBridgeWriteLine(line, len, TCP_CONTROL_TIMEOUT_MS)) return true;
  setError("WiFi voice write timed out");
  return false;
}

bool sendStart() {
  char control[192];
  int len = snprintf(
      control, sizeof(control),
      "{\"cmd\":\"voice\",\"action\":\"start\",\"session\":\"%s\","
      "\"sampleRate\":%lu,\"channels\":1,\"format\":\"pcm_s16le\","
      "\"transport\":\"wifi\"}",
      session, (unsigned long)SAMPLE_RATE);
  if (len <= 0 || (size_t)len >= sizeof(control)) {
    setError("voice start frame overflow");
    return false;
  }
  return sendJsonLine(control, (size_t)len);
}

bool sendStop() {
  char control[160];
  int len = snprintf(
      control, sizeof(control),
      "{\"cmd\":\"voice\",\"action\":\"stop\",\"session\":\"%s\","
      "\"seq\":%lu,\"samples\":%lu}",
      session, (unsigned long)sequence, (unsigned long)samples);
  if (len <= 0 || (size_t)len >= sizeof(control)) {
    setError("voice stop frame overflow");
    return false;
  }
  return sendJsonLine(control, (size_t)len);
}

bool sendCancel() {
  char control[96];
  int len = snprintf(
      control, sizeof(control),
      "{\"cmd\":\"voice\",\"action\":\"cancel\",\"session\":\"%s\"}",
      session);
  if (len <= 0 || (size_t)len >= sizeof(control)) {
    setError("voice cancel frame overflow");
    return false;
  }
  return sendJsonLine(control, (size_t)len);
}

bool uninstallI2s() {
  if (!i2sInstalled) return true;
  esp_err_t rc = i2s_driver_uninstall(MIC_I2S_PORT);
  if (rc != ESP_OK) {
    // The legacy driver may now be in an indeterminate state. Reusing it on a
    // later turn is unsafe; require a reboot instead of producing intermittent
    // truncated recordings.
    captureUnavailable = true;
    setError("microphone restart required");
    return false;
  }
  gpio_reset_pin(MIC_CLK_PIN);
  gpio_reset_pin(MIC_DATA_PIN);
  i2sEvents = nullptr;
  i2sInstalled = false;
  return true;
}

bool installI2s() {
  if (captureUnavailable) {
    setError("microphone restart required");
    return false;
  }
  if (i2sInstalled) return true;

  i2s_config_t config = {};
  config.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_PDM);
  config.sample_rate = SAMPLE_RATE;
  config.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  config.channel_format = I2S_CHANNEL_FMT_ALL_RIGHT;
#if ESP_IDF_VERSION > ESP_IDF_VERSION_VAL(4, 1, 0)
  config.communication_format = I2S_COMM_FORMAT_STAND_I2S;
#else
  config.communication_format = I2S_COMM_FORMAT_I2S;
#endif
  config.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  config.dma_buf_count = DMA_BUFFER_COUNT;
  config.dma_buf_len = DMA_BUFFER_SAMPLES;
  config.use_apll = false;
  config.tx_desc_auto_clear = false;
  config.fixed_mclk = 0;

  esp_err_t rc = i2s_driver_install(
      MIC_I2S_PORT, &config, I2S_EVENT_QUEUE_LENGTH, &i2sEvents);
  if (rc != ESP_OK) {
    setError("microphone I2S init failed");
    return false;
  }
  i2sInstalled = true;

  i2s_pin_config_t pins = {};
#if ESP_IDF_VERSION > ESP_IDF_VERSION_VAL(4, 3, 0)
  pins.mck_io_num = I2S_PIN_NO_CHANGE;
#endif
  pins.bck_io_num = I2S_PIN_NO_CHANGE;
  pins.ws_io_num = MIC_CLK_PIN;
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num = MIC_DATA_PIN;

  rc = i2s_set_pin(MIC_I2S_PORT, &pins);
  if (rc == ESP_OK) {
    rc = i2s_set_clk(MIC_I2S_PORT, SAMPLE_RATE,
                     I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_MONO);
  }
  if (rc != ESP_OK) {
    setError("microphone pin setup failed");
    uninstallI2s();
    return false;
  }
  return true;
}

bool sendPcm(const uint8_t* raw, size_t rawLen) {
  if (!raw || rawLen == 0 || rawLen > CAPTURE_CHUNK_BYTES ||
      rawLen > UINT16_MAX || (rawLen & 1) != 0) {
    setError("voice UDP PCM frame invalid");
    return false;
  }
  char frame[voice_tcp::FRAME_CAP];
  const size_t frameLen = voice_tcp::encode(frame, sizeof(frame), session, sequence, raw, rawLen);
  if (!frameLen) { setError("voice PCM frame encoding failed"); return false; }
  if (!sendJsonLine(frame, frameLen)) return false;

  // Audio and stop share one ordered stream. TCP retransmits lost packets;
  // the final stop still validates every sample rather than accepting truncation.
  sequence++;
  samples += rawLen / sizeof(int16_t);
  return true;
}

void recyclePcmSlot(uint8_t index) {
  if (freePcmSlots) xQueueSend(freePcmSlots, &index, 0);
}

void discardFilledPcm() {
  if (!filledPcmSlots) return;
  uint8_t index = 0;
  while (xQueueReceive(filledPcmSlots, &index, 0) == pdTRUE) {
    recyclePcmSlot(index);
  }
}

bool resetPcmQueues() {
  if (!freePcmSlots || !filledPcmSlots) return false;
  xQueueReset(freePcmSlots);
  xQueueReset(filledPcmSlots);
  for (uint8_t index = 0; index < PCM_SLOT_COUNT; index++) {
    if (xQueueSend(freePcmSlots, &index, 0) != pdTRUE) return false;
  }
  return true;
}

StopReason readStopReason() {
  portENTER_CRITICAL(&stateMux);
  StopReason reason = stopReason;
  portEXIT_CRITICAL(&stateMux);
  return reason;
}

bool latchStopReason(StopReason reason, uint32_t requestedAt) {
  bool changed = false;
  portENTER_CRITICAL(&stateMux);
  if (active && stopReason == STOP_NONE) {
    stopRequestedMs = requestedAt;
    stopReason = reason;
    changed = true;
  }
  portEXIT_CRITICAL(&stateMux);
  if (changed && workerTask) xTaskNotifyGive(workerTask);
  return changed;
}

void forceCaptureAbort() {
  portENTER_CRITICAL(&stateMux);
  if (active) {
    stopRequestedMs = millis();
    stopReason = STOP_ABORT;
  }
  portEXIT_CRITICAL(&stateMux);
  if (workerTask) xTaskNotifyGive(workerTask);
}

bool forceCaptureCancel() {
  bool changed = false;
  portENTER_CRITICAL(&stateMux);
  if (active && stopReason != STOP_ABORT && stopReason != STOP_CANCEL) {
    stopRequestedMs = millis();
    stopReason = STOP_CANCEL;
    changed = true;
  }
  portEXIT_CRITICAL(&stateMux);
  if (changed && workerTask) xTaskNotifyGive(workerTask);
  return changed || (active && readStopReason() == STOP_CANCEL);
}

bool i2sReceiveOverflowed() {
  if (!i2sEvents) return false;
  i2s_event_t event;
  bool overflowed = false;
  while (xQueueReceive(i2sEvents, &event, 0) == pdTRUE) {
    if (event.type == I2S_EVENT_RX_Q_OVF ||
        event.type == I2S_EVENT_DMA_ERROR) {
      overflowed = true;
    }
  }
  if (overflowed) setError("microphone capture overflowed");
  return overflowed;
}

bool waitForReader() {
  const TickType_t started = xTaskGetTickCount();
  while (!captureDone &&
         xTaskGetTickCount() - started < CAPTURE_JOIN_TICKS) {
    vTaskDelay(1);
  }
  if (captureDone) return true;
  setError("microphone reader stop timed out");
  return false;
}

void publishWorkerCompletion(StopReason reason, bool result,
                             VoiceCaptureEvent event) {
  const uint32_t elapsedMs = millis() - startedMs;
  const uint32_t sentMs =
      (uint32_t)(((uint64_t)samples * 1000ULL) / SAMPLE_RATE);
  const uint32_t capturedMs =
      (uint32_t)(((uint64_t)capturedSamples * 1000ULL) / SAMPLE_RATE);
  const int32_t captureGapMs = (int32_t)elapsedMs - (int32_t)capturedMs;

  Serial.printf(
      "[voice] capture complete: elapsed=%lums captured=%lums sent=%lums "
      "gap=%ldms samples=%lu chunks=%lu maxQueue=%u reason=%u\n",
      (unsigned long)elapsedMs, (unsigned long)capturedMs,
      (unsigned long)sentMs, (long)captureGapMs, (unsigned long)samples,
      (unsigned long)sequence, (unsigned)maxQueuedSlots, (unsigned)reason);

  // Both tasks have finished and all queue slots have been returned before the
  // session is exposed as idle, so a new turn cannot inherit late PCM.
  streaming = false;
  holdConfirmed = false;
  remoteSessionStarted = false;
  remoteStartPending = false;
  retryStartRequested = false;
  lastWorkerResult = result;
  pendingEvent = event;
  stopReason = STOP_NONE;
  workerRunning = false;
  active = false;
}

uint32_t targetSamplesForStop(StopReason reason) {
  if (reason != STOP_NORMAL && reason != STOP_AUTO) return 0;
  const uint32_t expectedMs = stopRequestedMs - startedMs;
  return (uint32_t)(((uint64_t)expectedMs * SAMPLE_RATE) / 1000ULL);
}

void captureReader(void*) {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    if (!active) continue;
    readerRunning = true;

    bool failed = false;
    uint32_t localCapturedSamples = 0;
    while (active) {
      StopReason reason = readStopReason();
      if (reason == STOP_CANCEL || reason == STOP_ABORT) break;
      if (reason == STOP_NONE && holdConfirmed &&
          (uint32_t)(millis() - startedMs) >= MAX_CAPTURE_MS) {
        latchStopReason(STOP_AUTO, startedMs + MAX_CAPTURE_MS);
        reason = readStopReason();
      }

      uint32_t targetSamples = targetSamplesForStop(reason);
      if (targetSamples > 0 && localCapturedSamples >= targetSamples) break;

      uint8_t slotIndex = 0;
      if (xQueueReceive(freePcmSlots, &slotIndex, 0) != pdTRUE) {
        // Re-check cancellation before reporting backpressure; a short tap can
        // race this exact boundary and intentionally discards queued audio.
        reason = readStopReason();
        if (reason == STOP_CANCEL || reason == STOP_ABORT) break;
        setError("voice network buffer full");
        failed = true;
        break;
      }

      size_t requestedBytes = CAPTURE_CHUNK_BYTES;
      if (targetSamples > localCapturedSamples) {
        const size_t remainingBytes =
            (size_t)(targetSamples - localCapturedSamples) * sizeof(int16_t);
        if (remainingBytes < requestedBytes) requestedBytes = remainingBytes;
      }
      requestedBytes &= ~(size_t)1;
      if (requestedBytes == 0) {
        recyclePcmSlot(slotIndex);
        break;
      }

      size_t bytesRead = 0;
      const TickType_t readTicks =
          reason == STOP_NONE ? I2S_READ_TICKS : 0;
      esp_err_t rc = i2s_read(MIC_I2S_PORT, pcmSlots[slotIndex].data,
                              requestedBytes, &bytesRead, readTicks);
      if (rc == ESP_ERR_TIMEOUT || bytesRead == 0) {
        recyclePcmSlot(slotIndex);
        if (i2sReceiveOverflowed()) {
          failed = true;
          break;
        }
        if (reason != STOP_NONE) break;
        continue;
      }
      if (rc != ESP_OK) {
        recyclePcmSlot(slotIndex);
        setError("microphone read failed");
        failed = true;
        break;
      }
      bytesRead &= ~(size_t)1;
      reason = readStopReason();
      if (reason == STOP_CANCEL || reason == STOP_ABORT) {
        recyclePcmSlot(slotIndex);
        break;
      }

      targetSamples = targetSamplesForStop(reason);
      if (targetSamples > 0) {
        const uint32_t remainingSamples =
            targetSamples > localCapturedSamples
                ? targetSamples - localCapturedSamples
                : 0;
        const size_t allowedBytes =
            (size_t)remainingSamples * sizeof(int16_t);
        if (bytesRead > allowedBytes) bytesRead = allowedBytes & ~(size_t)1;
      }
      if (bytesRead == 0) {
        recyclePcmSlot(slotIndex);
        break;
      }

      pcmSlots[slotIndex].len = (uint16_t)bytesRead;
      if (xQueueSend(filledPcmSlots, &slotIndex, 0) != pdTRUE) {
        recyclePcmSlot(slotIndex);
        setError("voice PCM queue failed");
        failed = true;
        break;
      }
      localCapturedSamples += bytesRead / sizeof(int16_t);
      capturedSamples = localCapturedSamples;
      const UBaseType_t queued = uxQueueMessagesWaiting(filledPcmSlots);
      if (queued > maxQueuedSlots) maxQueuedSlots = (uint8_t)queued;

      if (i2sReceiveOverflowed()) {
        failed = true;
        break;
      }
      if (targetSamples > 0 && localCapturedSamples >= targetSamples) break;
    }

    StopReason reason = readStopReason();
    if (!failed && (reason == STOP_NORMAL || reason == STOP_AUTO)) {
      const uint32_t targetSamples = targetSamplesForStop(reason);
      const uint32_t deficitSamples =
          targetSamples > localCapturedSamples
              ? targetSamples - localCapturedSamples
              : 0;
      const uint32_t deficitMs =
          (uint32_t)(((uint64_t)deficitSamples * 1000ULL) / SAMPLE_RATE);
      if (deficitMs > MAX_CAPTURE_DEFICIT_MS) {
        setError("microphone capture fell behind");
        failed = true;
      }
    }

    // ESP-IDF's i2s_zero_dma_buffer() only clears TX. Rebuilding the RX driver
    // guarantees the next turn cannot inherit queued PDM samples.
    if (!uninstallI2s()) failed = true;
    if (failed) {
      Serial.printf("[voice] reader error: %s\n", lastError);
      captureFailed = true;
      forceCaptureAbort();
    }
    readerRunning = false;
    captureDone = true;
    if (workerTask) xTaskNotifyGive(workerTask);
    // Stop notifications are hints only; discard any that accumulated while
    // i2s_read was active so they cannot start this reader twice.
    ulTaskNotifyTake(pdTRUE, 0);
  }
}

void voiceWorker(void*) {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    if (!active) continue;
    workerRunning = true;

    bool failed = false;
    bool initialBacklogMeasured = false;
    uint8_t initialBacklogRemaining = 0;
    // Give very short navigation taps a chance to cancel locally without
    // creating an OpenAI session. The microphone reader continues filling the
    // bounded pre-roll during this nonblocking debounce.
    while (active && readStopReason() == STOP_NONE &&
           (uint32_t)(millis() - startedMs) < VOICE_START_DEBOUNCE_MS) {
      vTaskDelay(1);
    }

    StopReason reason = readStopReason();
    if (reason != STOP_CANCEL && reason != STOP_ABORT) {
      if (!sendStart()) {
        failed = true;
      } else {
        remoteSessionStarted = true;
        streaming = holdConfirmed;
        Serial.printf("[voice] TCP start frame sent: %s\n", session);
      }
    }
    remoteStartPending = false;

    while (!failed) {
      reason = readStopReason();
      if (captureFailed) {
        failed = true;
        break;
      }
      if (reason == STOP_CANCEL || reason == STOP_ABORT) break;

      if (retryStartRequested && remoteSessionStarted && !startConfirmed) {
        retryStartRequested = false;
        if (!sendStart()) {
          failed = true;
          break;
        }
        Serial.printf("[voice] start frame retried: %s\n", session);
      }

      // Keep pre-roll local until the bridge confirms ownership of the
      // session. The bounded PCM queue absorbs normal ACK latency.
      if (streaming && remoteSessionStarted && startConfirmed) {
        if (!initialBacklogMeasured) {
          const UBaseType_t queued = uxQueueMessagesWaiting(filledPcmSlots);
          initialBacklogRemaining = initialBacklogPacePackets(
              queued > UINT8_MAX ? UINT8_MAX : (uint8_t)queued);
          initialBacklogMeasured = true;
        }
        uint8_t slotIndex = 0;
        if (xQueueReceive(filledPcmSlots, &slotIndex,
                          pdMS_TO_TICKS(5)) == pdTRUE) {
          const size_t rawLen = pcmSlots[slotIndex].len;
          const bool sent = sendPcm(pcmSlots[slotIndex].data, rawLen);
          recyclePcmSlot(slotIndex);
          if (!sent) {
            failed = true;
            break;
          }
          if (initialBacklogRemaining > 0) initialBacklogRemaining--;
          if (initialBacklogRemaining > 0) {
            vTaskDelay(UDP_BACKLOG_PACE_TICKS);
          }
          continue;
        }
      }

      if (captureDone && reason != STOP_NONE &&
          uxQueueMessagesWaiting(filledPcmSlots) == 0) {
        break;
      }
      vTaskDelay(1);
    }

    char originalError[sizeof(lastError)] = "";
    if (failed) {
      strncpy(originalError, lastError, sizeof(originalError) - 1);
      originalError[sizeof(originalError) - 1] = 0;
      forceCaptureAbort();
    }
    if (!waitForReader()) {
      if (!failed) {
        strncpy(originalError, lastError, sizeof(originalError) - 1);
        originalError[sizeof(originalError) - 1] = 0;
      }
      failed = true;
      forceCaptureAbort();
      // Never publish the queues/session as reusable while the reader could
      // still own a slot or the I2S driver. This path is abnormal (i2s_read is
      // bounded to 40 ms), so remain safely busy until teardown really ends.
      while (!captureDone) vTaskDelay(pdMS_TO_TICKS(10));
    }
    reason = readStopReason();
    const bool hadRemoteSession = remoteSessionStarted;
    if (reason == STOP_CANCEL || reason == STOP_ABORT || failed) {
      discardFilledPcm();
    }
    // All normal queued PCM has drained. Also close any legacy UDP socket.
    wifiBridgeVoiceUdpEnd();

    bool result = false;
    VoiceCaptureEvent event = VOICE_CAPTURE_EVENT_NONE;
    if (failed) {
      Serial.printf("[voice] capture error: %s\n", lastError);
      // Local capture/transport failures leave a valid bridge session unless
      // explicitly cancelled. Network failures have already reset the socket.
      if (hadRemoteSession && wifiBridgeConnected() && !sendCancel()) {
        // A lock-timeout can fail before writing any bytes, in which case the
        // normal framing code has no reason to reset the socket. Force a new
        // connection so this abandoned voice session cannot survive.
        wifiBridgeResetConnection();
      }
      if (originalError[0]) setError(originalError);
      event = VOICE_CAPTURE_EVENT_ERROR;
    } else if (reason == STOP_ABORT) {
      result = true;
    } else if (reason == STOP_CANCEL) {
      result = !hadRemoteSession || sendCancel();
      if (!result) {
        wifiBridgeResetConnection();
        event = VOICE_CAPTURE_EVENT_ERROR;
      }
    } else {
      result = samples > 0 ? sendStop() : sendCancel();
      if (!result) {
        wifiBridgeResetConnection();
        event = VOICE_CAPTURE_EVENT_ERROR;
      } else if (reason == STOP_AUTO) {
        event = VOICE_CAPTURE_EVENT_AUTO_STOP;
      }
    }
    publishWorkerCompletion(reason, result, event);
  }
}

bool ensureWorkers() {
  if (!pcmSlots) {
    const size_t freeBefore =
        heap_caps_get_free_size(MALLOC_CAP_8BIT | MALLOC_CAP_INTERNAL);
    pcmSlots = static_cast<PcmSlot*>(heap_caps_calloc(
        PCM_SLOT_COUNT, sizeof(PcmSlot), MALLOC_CAP_8BIT | MALLOC_CAP_INTERNAL));
    if (pcmSlots) {
      Serial.printf(
          "[voice] PCM pool: %u bytes, %lums queue, %lums chunks, "
          "internal free %u -> %u, largest %u\n",
          (unsigned)(PCM_SLOT_COUNT * sizeof(PcmSlot)),
          (unsigned long)PCM_QUEUE_COVERAGE_MS,
          (unsigned long)CAPTURE_CHUNK_MS, (unsigned)freeBefore,
          (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT | MALLOC_CAP_INTERNAL),
          (unsigned)heap_caps_get_largest_free_block(
              MALLOC_CAP_8BIT | MALLOC_CAP_INTERNAL));
    }
  }
  if (!pcmSlots) {
    setError("voice PCM memory unavailable");
    return false;
  }
  if (!freePcmSlots) {
    freePcmSlots = xQueueCreate(PCM_SLOT_COUNT, sizeof(uint8_t));
  }
  if (!filledPcmSlots) {
    filledPcmSlots = xQueueCreate(PCM_SLOT_COUNT, sizeof(uint8_t));
  }
  if (!freePcmSlots || !filledPcmSlots) {
    setError("voice PCM queue init failed");
    return false;
  }
  if (!readerTask) {
    BaseType_t rc = xTaskCreatePinnedToCore(
        captureReader, "voice_mic", READER_STACK_BYTES, nullptr,
        READER_PRIORITY, &readerTask, READER_CORE);
    if (rc != pdPASS) {
      readerTask = nullptr;
      setError("voice reader init failed");
      return false;
    }
  }
  if (!workerTask) {
    BaseType_t rc = xTaskCreatePinnedToCore(
        voiceWorker, "voice_tx", WORKER_STACK_BYTES, nullptr, WORKER_PRIORITY,
        &workerTask, WORKER_CORE);
    if (rc != pdPASS) {
      workerTask = nullptr;
      setError("voice worker init failed");
      return false;
    }
  }
  return true;
}

bool requestWorkerStop(StopReason reason) {
  if (!active) return false;
  if (latchStopReason(reason, millis())) return true;
  const StopReason latched = readStopReason();
  return latched == reason ||
         (reason == STOP_NORMAL && latched == STOP_AUTO);
}

}  // namespace

bool voiceCaptureInit() {
  lastError[0] = 0;
  uint32_t before = millis();
  if (!ensureWorkers() || !installI2s()) return false;
  // Validate the microphone once. RX DMA is rebuilt for every turn because
  // the legacy driver has no supported receive-queue flush operation.
  if (!uninstallI2s()) return false;
  Serial.printf("[voice] microphone ready in %lums\n",
                (unsigned long)(millis() - before));
  return true;
}

bool voiceCaptureArm() {
  if (active) return true;
  if (workerRunning || readerRunning) {
    setError("voice workers still busy");
    return false;
  }
  lastError[0] = 0;
  if (!wifiBridgeConnected()) {
    setError("WiFi bridge unavailable");
    return false;
  }
  if (!ensureWorkers() || !resetPcmQueues()) return false;

  snprintf(session, sizeof(session), "%08lx",
           (unsigned long)(esp_random() ^ micros()));
  sequence = 0;
  samples = 0;
  capturedSamples = 0;
  maxQueuedSlots = 0;
  startConfirmed = false;
  holdConfirmed = false;
  remoteSessionStarted = false;
  remoteStartPending = true;
  retryStartRequested = false;
  captureDone = false;
  captureFailed = false;
  lastWorkerResult = false;
  pendingEvent = VOICE_CAPTURE_EVENT_NONE;
  stopReason = STOP_NONE;
  stopRequestedMs = 0;

  // Start RX on the physical press edge. The reader keeps a bounded FIFO local
  // pre-roll until voiceCaptureStart() confirms this was a deliberate hold.
  // The legacy ESP-IDF driver starts RX automatically when it is installed.
  // Every turn gets a fresh driver, so no separate i2s_start() is needed.
  if (!installI2s()) return false;
  // Measure capture duration from the moment RX is actually running. Setup
  // time before this point must not be mistaken for missing audio at release.
  startedMs = millis();
  active = true;
  streaming = false;
  xTaskNotifyGive(readerTask);
  xTaskNotifyGive(workerTask);
  Serial.printf("[voice] local pre-roll armed: %s\n", session);
  return true;
}

bool voiceCaptureStart() {
  if (!active) {
    // Commit only the pre-roll armed by this same physical press. Re-arming
    // here after an asynchronous capture failure would start mid-utterance.
    setError("microphone pre-roll stopped");
    return false;
  }
  if (holdConfirmed) return true;
  if (!remoteStartPending && !remoteSessionStarted) {
    setError("voice session did not start");
    forceCaptureAbort();
    return false;
  }
  if (!wifiBridgeConnected()) {
    setError("WiFi bridge unavailable");
    forceCaptureAbort();
    return false;
  }
  // Confirm the physical hold without blocking the UI task. PCM remains in the
  // bounded queue until the authenticated bridge acknowledges the async start.
  holdConfirmed = true;
  if (remoteSessionStarted) streaming = true;
  if (workerTask) xTaskNotifyGive(workerTask);
  Serial.printf("[voice] PCM streaming requested: %s\n", session);
  return true;
}

bool voiceCaptureRetryStart() {
  if (!active || !remoteSessionStarted || startConfirmed ||
      !wifiBridgeConnected()) return false;
  retryStartRequested = true;
  if (workerTask) xTaskNotifyGive(workerTask);
  return true;
}

bool voiceCaptureConfirmStart() {
  if (!active) {
    setError("voice session is no longer active");
    return false;
  }
  if (!wifiBridgeConnected()) {
    setError("WiFi bridge disconnected");
    return false;
  }
  if (startConfirmed) return true;
  startConfirmed = true;
  retryStartRequested = false;
  if (workerTask) xTaskNotifyGive(workerTask);
  Serial.printf("[voice] bridge ack in %lums: %s\n",
                (unsigned long)(millis() - startedMs), session);
  return true;
}

VoiceCaptureEvent voiceCapturePoll() {
  VoiceCaptureEvent event = pendingEvent;
  if (event != VOICE_CAPTURE_EVENT_NONE) {
    pendingEvent = VOICE_CAPTURE_EVENT_NONE;
    return event;
  }
  if (!active) return VOICE_CAPTURE_EVENT_NONE;
  if (!wifiBridgeConnected()) {
    if (readStopReason() != STOP_ABORT) {
      setError("WiFi bridge disconnected");
      forceCaptureAbort();
      return VOICE_CAPTURE_EVENT_ERROR;
    }
  }
  return VOICE_CAPTURE_EVENT_NONE;
}

bool voiceCaptureStop() {
  return requestWorkerStop(STOP_NORMAL);
}

bool voiceCaptureCancel(bool force) {
  if (force) return forceCaptureCancel();
  return requestWorkerStop(STOP_CANCEL);
}

void voiceCaptureAbort() {
  if (active) forceCaptureAbort();
}

bool voiceCaptureActive() { return active; }
bool voiceCaptureStreaming() { return active && holdConfirmed; }
const char* voiceCaptureError() { return lastError; }
const char* voiceCaptureSession() { return session; }
uint32_t voiceCaptureSamples() { return capturedSamples; }
