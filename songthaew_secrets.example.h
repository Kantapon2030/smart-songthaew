// songthaew_secrets.example.h
// Copy this file to songthaew_secrets.h and fill in deployment-specific values.
// Do not put real credentials in this example file.
// songthaew_secrets.h is ignored by Git.

#ifndef SONGTHAEW_SECRETS_H
#define SONGTHAEW_SECRETS_H

// WiFi: ground station only
#ifndef WIFI_SSID
#define WIFI_SSID "YOUR_WIFI_SSID"
#endif
#ifndef WIFI_PASS
#define WIFI_PASS "YOUR_WIFI_PASSWORD"
#endif

// Server endpoint: keep /api/update-location for backward compatibility
#ifndef SERVER_URL
#define SERVER_URL "https://YOUR-PROJECT.vercel.app/api/update-location"
#endif

// Ground batch authentication: provision the same value through
// POST /api/v1/admin/ground-keys/GROUND_01 before flashing the ground board.
#ifndef GROUND_KEY
#define GROUND_KEY "REPLACE_WITH_AT_LEAST_24_RANDOM_CHARACTERS"
#endif

// Ground station identity/location: used by both ground and vehicle mesh routing
#ifndef GROUND_ID
#define GROUND_ID  "GROUND_01"
#endif
#ifndef GROUND_LAT
#define GROUND_LAT 8.4304
#endif
#ifndef GROUND_LNG
#define GROUND_LNG 99.9631
#endif

// Vehicle identity: change this per vehicle board before flashing
#ifndef VEHICLE_ID
#define VEHICLE_ID "BUS_01"
#endif
#ifndef ROUTE_ID
#define ROUTE_ID   "route_001"
#endif
#ifndef ROUTE_DIR
#define ROUTE_DIR  "outbound"
#endif

// Optional future auth key
// #define VEHICLE_KEY "YOUR_VEHICLE_KEY"

#endif // SONGTHAEW_SECRETS_H
