// Xiaodex modification, 2026-08-26: standalone task/zone bootstrap sized from
// on-device stack high-water measurements.
// Native Doom on the original M5StickC Plus / Xiaodex.
// Port of GBADoom (doomhack), which is based on PrBoom.
#include <Arduino.h>
#include "doomport.h"

extern "C" {
#include "doomdef.h"
#include "d_main.h"
#include "z_zone.h"
#include "global_data.h"
void I_PreInitGraphics(void);
void InitGlobals(void);
}

static void doomTask(void*)
{
    // xTaskCreateStatic() can preempt setup() before it deletes Arduino's
    // loopTask. Let setup finish and let the idle task reclaim that dynamic
    // stack before Z_Init takes the largest contiguous heap block. Later maps
    // need this headroom even though E1M1 can load without it.
    vTaskDelay(pdMS_TO_TICKS(250));

    WadInit();
    SramInit();

    printf("heap before Z_Init: free=%u largest=%u\n",
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
           (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));

    // Z_Init first: the zone wants the largest contiguous heap block, so it
    // must run before the display/framebuffer allocations fragment the heap.
    Z_Init();

    printf("heap after Z_Init: free=%u largest=%u\n",
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
           (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));

    I_PreInitGraphics();   // display + input + framebuffers

    InitGlobals();

    D_DoomMain();

    for (;;)
        vTaskDelay(portMAX_DELAY);
}

// Measured high-water use is under 2.5KB during active play and USB capture.
// An 8KB static stack keeps ample safety margin while returning 16KB of scarce
// internal DRAM to Doom's contiguous zone (later maps need it).
static StaticTask_t s_doomTcb;
static StackType_t s_doomStack[8192 / sizeof(StackType_t)];

void setup()
{
    Serial.begin(115200);
    delay(100);
    Serial.println();
    Serial.println("Xiaodex DOOM (GBADoom/PrBoom, original M5StickC Plus)");
    Serial.println("controls: tilt move/turn, A fire, B use, hold B menu");
    Serial.println("USB keys: w/a/s/d move, q/e strafe, f fire, space use, m menu, t map");

    xTaskCreateStaticPinnedToCore(doomTask, "doom", 8192 / sizeof(StackType_t),
                                  nullptr, 2, s_doomStack, &s_doomTcb, 1);

    vTaskDelete(nullptr); // setup runs in loopTask; we don't need it
}

void loop() {}
