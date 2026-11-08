// ST7789V2 display backend for the original M5StickC Plus.
//
// GBADoom renders 240x160 indexed pixels (stored as 120x160 uint16 words).
// The Stick is 240x135 in landscape, so each output row selects its nearest
// source row. Palette conversion and SPI transfer use two small DMA buffers;
// no RGB565 framebuffer is allocated.
#include <Arduino.h>
#include <Wire.h>
#include <string.h>
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "doomport.h"

#define PIN_TFT_MOSI 15
#define PIN_TFT_SCLK 13
#define PIN_TFT_CS    5
#define PIN_TFT_DC   23
#define PIN_TFT_RST  18

#define SRC_W 240
#define SRC_H 160
#define OUT_W 240
#define OUT_H 135
#define IMAGE_W 203
#define IMAGE_X ((OUT_W - IMAGE_W) / 2)

#define COL_OFFSET 40
#define ROW_OFFSET 53
#define MADCTL_LANDSCAPE 0x68

#define ROWS_PER_CHUNK 5
#define CHUNK_BYTES (OUT_W * ROWS_PER_CHUNK * 2)
#define CAPTURE_CHUNK_BYTES 192

static spi_device_handle_t s_spi;
static uint16_t s_lut[256];
static uint8_t s_captureLut[256];
static uint8_t s_colmap[IMAGE_W];
static uint8_t s_rowmap[OUT_H];
static const uint8_t* s_lastFrame;

static uint8_t* s_chunk[2];
static bool s_chunkInFlight[2];
static spi_transaction_t s_chunkTrans[2];

static void i2cWrite(uint8_t address, uint8_t reg, uint8_t value)
{
    Wire1.beginTransmission(address);
    Wire1.write(reg);
    Wire1.write(value);
    Wire1.endTransmission();
}

static uint8_t i2cRead(uint8_t address, uint8_t reg)
{
    Wire1.beginTransmission(address);
    Wire1.write(reg);
    if (Wire1.endTransmission(false) != 0)
        return 0;
    if (Wire1.requestFrom((int)address, 1) != 1)
        return 0;
    return Wire1.read();
}

static void powerInit(void)
{
    Wire1.begin(21, 22, 400000);

    // AXP192 setup used by M5StickCPlus: LDO2 drives the LCD backlight and
    // LDO3 powers the panel. Keep the rest of the board in its normal state.
    i2cWrite(0x34, 0x28, 0xCC);
    i2cWrite(0x34, 0x82, 0xFF);
    i2cWrite(0x34, 0x33, 0xC0);
    i2cWrite(0x34, 0x12, i2cRead(0x34, 0x12) | 0x4D);
    i2cWrite(0x34, 0x32, 0x46);
    i2cWrite(0x34, 0x36, 0x0C);
    // Enable and clear AXP192 PEK short/long press IRQs. The PMIC's own
    // hardware long-hold cutoff remains enabled by register 0x36.
    i2cWrite(0x34, 0x42, 0x03);
    i2cWrite(0x34, 0x46, 0x03);
    i2cWrite(0x34, 0x30, 0x80);
}

static inline void dc(int level)
{
    gpio_set_level((gpio_num_t)PIN_TFT_DC, level);
}

static void command(uint8_t value)
{
    spi_transaction_t transaction = {};
    transaction.length = 8;
    transaction.tx_data[0] = value;
    transaction.flags = SPI_TRANS_USE_TXDATA;
    dc(0);
    ESP_ERROR_CHECK(spi_device_polling_transmit(s_spi, &transaction));
    dc(1);
}

static void data(const uint8_t* bytes, int length)
{
    uint8_t bounce[32];
    while (length > 0) {
        int count = length > (int)sizeof(bounce) ? (int)sizeof(bounce) : length;
        memcpy(bounce, bytes, count);
        spi_transaction_t transaction = {};
        transaction.length = count * 8;
        transaction.tx_buffer = bounce;
        ESP_ERROR_CHECK(spi_device_polling_transmit(s_spi, &transaction));
        bytes += count;
        length -= count;
    }
}

static void commandData(uint8_t cmd, const uint8_t* bytes, int length)
{
    command(cmd);
    if (length)
        data(bytes, length);
}

static void command1(uint8_t cmd, uint8_t value)
{
    commandData(cmd, &value, 1);
}

static void setWindow(int x0, int y0, int x1, int y1)
{
    x0 += COL_OFFSET;
    x1 += COL_OFFSET;
    y0 += ROW_OFFSET;
    y1 += ROW_OFFSET;
    uint8_t columns[4] = {
        (uint8_t)(x0 >> 8), (uint8_t)x0, (uint8_t)(x1 >> 8), (uint8_t)x1
    };
    uint8_t rows[4] = {
        (uint8_t)(y0 >> 8), (uint8_t)y0, (uint8_t)(y1 >> 8), (uint8_t)y1
    };
    commandData(0x2A, columns, sizeof(columns));
    commandData(0x2B, rows, sizeof(rows));
    command(0x2C);
}

static void waitChunk(int index)
{
    if (!s_chunkInFlight[index])
        return;
    spi_transaction_t* completed;
    ESP_ERROR_CHECK(spi_device_get_trans_result(s_spi, &completed, portMAX_DELAY));
    s_chunkInFlight[index] = false;
}

static void sendChunk(int index, int bytes)
{
    spi_transaction_t* transaction = &s_chunkTrans[index];
    memset(transaction, 0, sizeof(*transaction));
    transaction->length = bytes * 8;
    transaction->tx_buffer = s_chunk[index];
    ESP_ERROR_CHECK(spi_device_queue_trans(s_spi, transaction, portMAX_DELAY));
    s_chunkInFlight[index] = true;
}

static void fillScreen(uint16_t color)
{
    setWindow(0, 0, OUT_W - 1, OUT_H - 1);
    uint16_t swapped = (uint16_t)((color >> 8) | (color << 8));
    uint16_t* pixels = (uint16_t*)s_chunk[0];
    for (int i = 0; i < OUT_W * ROWS_PER_CHUNK; i++)
        pixels[i] = swapped;
    for (int row = 0; row < OUT_H; row += ROWS_PER_CHUNK) {
        int rows = min(ROWS_PER_CHUNK, OUT_H - row);
        waitChunk(0);
        sendChunk(0, rows * OUT_W * 2);
    }
    waitChunk(0);
}

static void panelInit(void)
{
    pinMode(PIN_TFT_RST, OUTPUT);
    digitalWrite(PIN_TFT_RST, HIGH);
    delay(10);
    digitalWrite(PIN_TFT_RST, LOW);
    delay(20);
    digitalWrite(PIN_TFT_RST, HIGH);
    delay(120);

    command(0x01);
    delay(150);
    command(0x11);
    delay(120);
    command(0x13);
    command1(0x36, MADCTL_LANDSCAPE);
    const uint8_t displayFunction[] = {0x0A, 0x82};
    commandData(0xB6, displayFunction, sizeof(displayFunction));
    command1(0x3A, 0x55);

    const uint8_t porch[] = {0x0C, 0x0C, 0x00, 0x33, 0x33};
    commandData(0xB2, porch, sizeof(porch));
    command1(0xB7, 0x35);
    command1(0xBB, 0x28);
    command1(0xC0, 0x0C);
    const uint8_t enableVdv[] = {0x01, 0xFF};
    commandData(0xC2, enableVdv, sizeof(enableVdv));
    command1(0xC3, 0x10);
    command1(0xC4, 0x20);
    command1(0xC6, 0x0F);
    const uint8_t power[] = {0xA4, 0xA1};
    commandData(0xD0, power, sizeof(power));

    const uint8_t positiveGamma[] = {
        0xD0,0x00,0x02,0x07,0x0A,0x28,0x32,0x44,0x42,0x06,0x0E,0x12,0x14,0x17
    };
    const uint8_t negativeGamma[] = {
        0xD0,0x00,0x02,0x07,0x0A,0x28,0x31,0x54,0x47,0x0E,0x1C,0x17,0x1B,0x1E
    };
    commandData(0xE0, positiveGamma, sizeof(positiveGamma));
    commandData(0xE1, negativeGamma, sizeof(negativeGamma));
    command(0x21);
    command(0x29);
    delay(120);
}

void DisplaySetPalette(const unsigned char* rgb768)
{
    if (!rgb768)
        return;
    for (int i = 0; i < 256; i++) {
        uint8_t r = *rgb768++;
        uint8_t g = *rgb768++;
        uint8_t b = *rgb768++;
        uint16_t color = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
        s_lut[i] = (uint16_t)((color >> 8) | (color << 8));
        s_captureLut[i] = (uint8_t)((r & 0xE0) | ((g >> 3) & 0x1C) | (b >> 6));
    }
}

void DisplayPushFrame(const unsigned char* frame)
{
    if (!frame)
        return;
    s_lastFrame = frame;
    // The ST7789 wraps writes at the programmed window width. Keep that width
    // identical to the number of pixels transmitted per row; otherwise the
    // 203-pixel letterboxed image walks diagonally through a 240-pixel window.
    setWindow(IMAGE_X, 0, IMAGE_X + IMAGE_W - 1, OUT_H - 1);

    int buffer = 0;
    int row = 0;
    while (row < OUT_H) {
        int rows = min(ROWS_PER_CHUNK, OUT_H - row);
        waitChunk(buffer);
        uint16_t* out = (uint16_t*)s_chunk[buffer];
        for (int r = 0; r < rows; r++) {
            const uint8_t* src = frame + s_rowmap[row + r] * SRC_W;
            for (int x = 0; x < IMAGE_W; x++)
                *out++ = s_lut[src[s_colmap[x]]];
        }
        sendChunk(buffer, rows * IMAGE_W * 2);
        buffer ^= 1;
        row += rows;
    }
    waitChunk(0);
    waitChunk(1);
}

void DisplaySetMadctl(unsigned char value)
{
    (void)value;
    command1(0x36, MADCTL_LANDSCAPE);
}

unsigned char DisplayPollPowerButton(void)
{
    uint8_t state = i2cRead(0x34, 0x46) & 0x03;
    if (state)
        i2cWrite(0x34, 0x46, 0x03);
    return state;
}

void DisplayPowerOff(void)
{
    // Official M5StickC Plus AXP192 shutdown sequence: preserve the existing
    // battery/charge configuration and set only the power-off bit.
    i2cWrite(0x34, 0x32, i2cRead(0x34, 0x32) | 0x80);
}

void DisplayFillRect(int x, int y, int width, int height, unsigned short color)
{
    if (width <= 0 || height <= 0)
        return;
    x = max(0, x); y = max(0, y);
    width = min(width, OUT_W - x); height = min(height, OUT_H - y);
    if (width <= 0 || height <= 0)
        return;
    setWindow(x, y, x + width - 1, y + height - 1);
    uint16_t swapped = (uint16_t)((color >> 8) | (color << 8));
    uint16_t* pixels = (uint16_t*)s_chunk[0];
    int capacity = CHUNK_BYTES / 2;
    for (int i = 0; i < capacity; i++) pixels[i] = swapped;
    int remaining = width * height;
    while (remaining > 0) {
        int count = min(remaining, capacity);
        waitChunk(0);
        sendChunk(0, count * 2);
        remaining -= count;
    }
    waitChunk(0);
}

void DisplayDrawText(const char* message)
{
    (void)message;
    // WadInit/SramInit run before DisplayInit so their serial diagnostics can
    // preserve scarce zone memory. Do not dereference an uninitialized SPI
    // handle or DMA buffer when one of those early checks fails.
    if (!s_spi || !s_chunk[0])
        return;
    fillScreen(0xF800);
}

static uint8_t capturePixel(uint32_t offset)
{
    uint32_t x = offset % OUT_W;
    uint32_t y = offset / OUT_W;
    if (x < IMAGE_X || x >= IMAGE_X + IMAGE_W)
        return 0;
    return s_captureLut[
        s_lastFrame[s_rowmap[y] * SRC_W + s_colmap[x - IMAGE_X]]
    ];
}

static uint32_t captureCrc32(void)
{
    uint32_t crc = 0xFFFFFFFFu;
    for (uint32_t i = 0; i < OUT_W * OUT_H; i++) {
        crc ^= capturePixel(i);
        for (int bit = 0; bit < 8; bit++)
            crc = (crc >> 1) ^ (0xEDB88320u & (uint32_t)-(int)(crc & 1));
    }
    return crc ^ 0xFFFFFFFFu;
}

static void base64Encode(const uint8_t* source, int length, char* output)
{
    static const char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    int out = 0;
    for (int i = 0; i < length; i += 3) {
        uint32_t value = (uint32_t)source[i] << 16;
        int available = min(3, length - i);
        if (available > 1) value |= (uint32_t)source[i + 1] << 8;
        if (available > 2) value |= source[i + 2];
        output[out++] = alphabet[(value >> 18) & 63];
        output[out++] = alphabet[(value >> 12) & 63];
        output[out++] = available > 1 ? alphabet[(value >> 6) & 63] : '=';
        output[out++] = available > 2 ? alphabet[value & 63] : '=';
    }
    output[out] = 0;
}

void DisplaySendCapture(const char* requestId)
{
    if (!s_lastFrame) {
        Serial.printf("{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\","
                      "\"op\":\"capture\",\"state\":\"error\","
                      "\"error\":\"framebuffer unavailable\"}\n", requestId);
        return;
    }

    const uint32_t bytes = OUT_W * OUT_H;
    const uint32_t chunks = (bytes + CAPTURE_CHUNK_BYTES - 1) / CAPTURE_CHUNK_BYTES;
    const uint32_t crc = captureCrc32();
    Serial.printf("{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\","
                  "\"op\":\"capture\",\"state\":\"begin\",\"width\":%d,"
                  "\"height\":%d,\"bytes\":%u,\"chunk_bytes\":%d,"
                  "\"format\":\"rgb332\"}\n",
                  requestId, OUT_W, OUT_H, (unsigned)bytes, CAPTURE_CHUNK_BYTES);

    uint8_t raw[CAPTURE_CHUNK_BYTES];
    char encoded[CAPTURE_CHUNK_BYTES * 4 / 3 + 5];
    for (uint32_t seq = 0; seq < chunks; seq++) {
        uint32_t offset = seq * CAPTURE_CHUNK_BYTES;
        int count = min((uint32_t)CAPTURE_CHUNK_BYTES, bytes - offset);
        for (int i = 0; i < count; i++) raw[i] = capturePixel(offset + i);
        base64Encode(raw, count, encoded);
        Serial.printf("{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\","
                      "\"op\":\"capture\",\"state\":\"chunk\",\"seq\":%u,"
                      "\"offset\":%u,\"data\":\"%s\"}\n",
                      requestId, (unsigned)seq, (unsigned)offset, encoded);
    }
    Serial.printf("{\"ack\":\"device_control\",\"v\":1,\"id\":\"%s\","
                  "\"op\":\"capture\",\"state\":\"end\",\"chunks\":%u,"
                  "\"bytes\":%u,\"crc32\":\"%08x\"}\n",
                  requestId, (unsigned)chunks, (unsigned)bytes, (unsigned)crc);
    Serial.flush();
}

void DisplayInit(void)
{
    for (int x = 0; x < IMAGE_W; x++)
        s_colmap[x] = (uint8_t)((x * SRC_W) / IMAGE_W);
    for (int y = 0; y < OUT_H; y++)
        s_rowmap[y] = (uint8_t)((y * SRC_H) / OUT_H);

    uint8_t grayscale[768];
    for (int i = 0; i < 256; i++) {
        grayscale[i * 3] = grayscale[i * 3 + 1] = grayscale[i * 3 + 2] = (uint8_t)i;
    }
    DisplaySetPalette(grayscale);

    powerInit();
    pinMode(PIN_TFT_CS, OUTPUT);
    pinMode(PIN_TFT_DC, OUTPUT);
    digitalWrite(PIN_TFT_CS, HIGH);
    digitalWrite(PIN_TFT_DC, HIGH);

    s_chunk[0] = (uint8_t*)heap_caps_malloc(CHUNK_BYTES, MALLOC_CAP_DMA);
    s_chunk[1] = (uint8_t*)heap_caps_malloc(CHUNK_BYTES, MALLOC_CAP_DMA);
    if (!s_chunk[0] || !s_chunk[1]) {
        Serial.println("[lcd] DMA buffer allocation failed");
        for (;;) delay(1000);
    }

    spi_bus_config_t bus = {};
    bus.mosi_io_num = PIN_TFT_MOSI;
    bus.miso_io_num = -1;
    bus.sclk_io_num = PIN_TFT_SCLK;
    bus.quadwp_io_num = -1;
    bus.quadhd_io_num = -1;
    bus.max_transfer_sz = CHUNK_BYTES + 64;
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));

    spi_device_interface_config_t device = {};
    device.clock_speed_hz = 26 * 1000 * 1000;
    device.mode = 0;
    device.spics_io_num = PIN_TFT_CS;
    device.queue_size = 4;
    ESP_ERROR_CHECK(spi_bus_add_device(SPI2_HOST, &device, &s_spi));
    dc(1);

    panelInit();
    fillScreen(0x0000);
    Serial.printf("[lcd] ST7789 240x135 ready, heap=%u\n",
                  (unsigned)ESP.getFreeHeap());
}
