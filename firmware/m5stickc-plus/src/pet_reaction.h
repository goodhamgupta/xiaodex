#pragma once
#include <stdint.h>

// A local reaction temporarily owns Home, including while charging. Otherwise
// the clock hides the full-size pet and overwrites its shake/heart state.
inline bool chargingClockVisible(bool idleHome, uint32_t now,
                                 uint32_t reactionUntil) {
  return idleHome && static_cast<int32_t>(now - reactionUntil) >= 0;
}
