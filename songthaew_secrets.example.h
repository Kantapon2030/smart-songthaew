// songthaew_secrets.example.h
// Copy this file to songthaew_secrets.h and fill in deployment-specific values.
// Do not put real credentials in this example file.
// songthaew_secrets.h is ignored by Git.

#ifndef SONGTHAEW_SECRETS_H
#define SONGTHAEW_SECRETS_H

// WiFi: ground station only
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASS "YOUR_WIFI_PASSWORD"

// Server endpoint: keep /api/update-location for backward compatibility
#define SERVER_URL "https://YOUR-PROJECT.vercel.app/api/update-location"

// Ground station identity/location: used by both ground and vehicle mesh routing
#define GROUND_ID  "GROUND_01"
#define GROUND_LAT 8.4304
#define GROUND_LNG 99.9631

// Vehicle identity: change this per vehicle board before flashing
#define VEHICLE_ID "BUS_01"
#define ROUTE_ID   "route_001"
#define ROUTE_DIR  "outbound"

// Optional future auth key
// #define VEHICLE_KEY "YOUR_VEHICLE_KEY"

#endif // SONGTHAEW_SECRETS_H
