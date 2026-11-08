#include <assert.h>
#include <stdint.h>
#include "../src/pet_reaction.h"

int main() {
  assert(chargingClockVisible(true, 0, 0));
  assert(chargingClockVisible(true, 2000, 0));
  // The two-second shake reaction must survive the clock pass on every frame.
  for (uint32_t now = 10000; now < 12000; ++now)
    assert(!chargingClockVisible(true, now, 12000));
  assert(chargingClockVisible(true, 12000, 12000));
  assert(chargingClockVisible(true, 12001, 12000));
  // An approval, voice screen, menu or non-Home screen still excludes the clock.
  assert(!chargingClockVisible(false, 11000, 12000));
  assert(!chargingClockVisible(false, 13000, 12000));
  // Reactions crossing the millis() wrap retain the same duration.
  assert(!chargingClockVisible(true, UINT32_MAX - 255, 744));
  assert(!chargingClockVisible(true, 743, 744));
  assert(chargingClockVisible(true, 744, 744));
  assert(chargingClockVisible(true, 745, 744));
}
