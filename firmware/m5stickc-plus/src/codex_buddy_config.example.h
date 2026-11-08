#pragma once

// Runtime USB provisioning is preferred. For a compile-time fallback, copy
// this file to codex_buddy_config.h and fill in your local network.
// codex_buddy_config.h is gitignored. The token must be a 16-96 character
// URL-safe secret using letters, digits, '.', '_', '~', or '-'.

#define CODEX_BUDDY_WIFI_SSID "your-wifi"
#define CODEX_BUDDY_WIFI_PASSWORD "your-password"
#define CODEX_BUDDY_BRIDGE_HOST "192.168.1.10"
#define CODEX_BUDDY_BRIDGE_PORT 8787
#define CODEX_BUDDY_TOKEN ""
