// Xiaodex modification, 2026-08-26: original-Stick static framebuffer,
// memory/FPS diagnostics, and safe ESP32 reboot behavior.
// ESP32 implementation of GBADoom's i_system_e32 platform API.
#include <Arduino.h>
#include <stdarg.h>
#include <stdio.h>
#include "esp_timer.h"
#include "esp_system.h"
#include "doomport.h"

extern "C" {
#include "doomdef.h"
#include "doomtype.h"
#include "i_system_e32.h"
}

#define FB_SHORTS (120 * 160)

// Keep the single 38.4KB framebuffer in static DRAM. The classic ESP32 heap is
// split into regions; after reserving Doom's protected and general zones no
// individual heap block is guaranteed to be this large, even when total free
// RAM is ample. The display driver still overlaps palette conversion with SPI
// DMA, so a second framebuffer is unnecessary.
static unsigned short s_buffer[FB_SHORTS];

extern "C" {

void I_InitScreen_e32(void)
{
    DisplayInit();
    InputInit();

    memset(s_buffer, 0, sizeof(s_buffer));
}

void I_BlitScreenBmp_e32(void) {}
void I_StartWServEvents_e32(void) {}
void I_PollWServEvents_e32(void) {}
void I_ClearWindow_e32(void) {}

unsigned short* I_GetBackBuffer(void)
{
    return s_buffer;
}

unsigned short* I_GetFrontBuffer(void)
{
    return s_buffer;
}

void I_CreateWindow_e32(void) {}

void I_CreateBackBuffer_e32(void)
{
    I_CreateWindow_e32();
}

void I_FinishUpdate_e32(const byte* srcBuffer, const byte* pallete,
                        const unsigned int width, const unsigned int height)
{
    (void)pallete; (void)width; (void)height;

    if (srcBuffer)
        DisplayPushFrame(srcBuffer);

    // Periodic status over serial: frame rate + memory health.
    static uint32_t frames = 0;
    static uint32_t lastReport = 0;
    frames++;
    uint32_t now = millis();
    if (now - lastReport >= 5000) {
        if (lastReport)
            printf("[stat] fps=%.1f heap_free=%u stack_free=%u\n",
                   frames * 1000.0f / (now - lastReport),
                   (unsigned)esp_get_free_heap_size(),
                   (unsigned)(uxTaskGetStackHighWaterMark(nullptr) * sizeof(StackType_t)));
        frames = 0;
        lastReport = now;
    }
}

void I_SetPallete_e32(const byte* pallete)
{
    DisplaySetPalette(pallete);
}

int I_GetVideoWidth_e32(void)
{
    return 120;
}

int I_GetVideoHeight_e32(void)
{
    return 160;
}

void I_ProcessKeyEvents(void)
{
    InputPoll();
}

int I_GetTime_e32(void)
{
    return (int)((esp_timer_get_time() * 35) / 1000000);
}

void I_Error(const char* error, ...)
{
    char msg[512];

    va_list v;
    va_start(v, error);
    vsnprintf(msg, sizeof(msg), error, v);
    va_end(v);

    printf("\nI_Error: %s\n", msg);
    fflush(stdout);
    DisplayDrawText(msg);

    for (;;)
        vTaskDelay(pdMS_TO_TICKS(1000));
}

void I_Reboot_console(void)
{
    esp_restart();
}

void I_Quit_e32(void)
{
    esp_restart();
}

} // extern "C"
