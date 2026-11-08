// Xiaodex modification, 2026-08-26: original StickC Plus hardware and USB
// verification surface, replacing the CYD touch/display configuration.
// Original M5StickC Plus / Xiaodex port glue.
#ifndef DOOMPORT_H
#define DOOMPORT_H

#ifdef __cplusplus
extern "C" {
#endif

// --- WAD in memory-mapped flash partition ---
// Maps the "wad" partition and points doom_iwad at it. Dies via I_Error on failure.
void WadInit(void);

// --- Persistent "SRAM" (save games + settings) in the "sram" partition ---
void SramInit(void);
void SramRead(unsigned char* dst, unsigned int size, unsigned int offset);
void SramWrite(const unsigned char* src, unsigned int size, unsigned int offset);

// --- Display (ST7789V2 over SPI) ---
// The game renders 240x160 8bpp into a framebuffer owned by the ESP32 port
// (exposed through I_GetBackBuffer/I_GetFrontBuffer in the e32 API).
void DisplayInit(void);
void DisplayPushFrame(const unsigned char* frame);
void DisplaySetPalette(const unsigned char* rgb768);
void DisplayDrawText(const char* msg);
void DisplaySetMadctl(unsigned char v);
void DisplayFillRect(int x, int y, int w, int h, unsigned short rgb565);
void DisplaySendCapture(const char* requestId);
unsigned char DisplayPollPowerButton(void);
void DisplayPowerOff(void);

// --- Input (MPU6886, A/B buttons, and USB serial controls) ---
void InputInit(void);
void InputPoll(void); // posts key events via D_PostEvent

#ifdef __cplusplus
}
#endif

#endif
