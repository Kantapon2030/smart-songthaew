# Smart Songthaew v1

Passenger-facing vehicle tracking built with Express, Firebase Realtime Database, Google Maps, and ESP8266 telemetry.

## Run locally

1. Copy `.env.example` to `.env` and set Firebase credentials, `JWT_SECRET`, `GOOGLE_MAPS_API_KEY`, and `GOOGLE_ROUTES_API_KEY`.
2. Run `npm install` and `npm start`.
3. Open `http://localhost:3000/` for Passenger Map. Admin and dashboard remain at `/admin.html` and `/dashboard.html`.

## v1 API

- `GET /api/v1/vehicles?route_id=NST-PROMKHIRI` returns `{ server_time, vehicles }` and never calculates ETA.
- `GET /api/v1/routes` returns routes, geometry, and popular places.
- `GET /api/v1/eta?vehicle_id=BUS_01&destination=8.430123,99.960456` computes one traffic-aware ETA. Cache misses are limited per session and IP; destinations must be within 5 km of the vehicle route.
- `POST /api/v1/telemetry` requires `X-Vehicle-Key` and a body with `vehicle_id`, `boot_id`, `seq`, and `gps_fix`.

Provision a vehicle key after logging in as an admin:

```http
POST /api/v1/admin/vehicle-keys/BUS_01
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{ "key": "a-random-secret-with-at-least-24-characters" }
```

Only the salted hash is stored. Copy `songthaew_secrets.example.h` to the ignored `songthaew_secrets.h` before uploading the firmware.

---

## VIBE Firmware Quick Start

### Hardware

| Part | Tested setup |
| --- | --- |
| Microcontroller | ESP8266 NodeMCU / LOLIN |
| GPS | GPS6MV2 / NEO-6M NMEA over SoftwareSerial |
| GPS timing | PPS / 1PPS connected to D1 (GPIO5) |
| LoRa | SX1276/SX1278 module |
| Battery sense | Analog divider to A0 |
| Power monitor | INA219 optional; not required by V03 firmware |

### Arduino Libraries

| Library | Version |
| --- | --- |
| LoRa by Sandeep Mistry | 0.8.0 or newer |
| TinyGPSPlus by Mikal Hart | 1.0.3 or newer |
| ArduinoJson by Benoit Blanchon | 7.x |
| ESP8266WiFi | From ESP8266 Arduino core |
| ESP8266HTTPClient | From ESP8266 Arduino core |

### Configure Before Flash

1. Copy the template secrets file:

   ```sh
   cp songthaew_secrets.example.h songthaew_secrets.h
   ```

2. Edit `songthaew_secrets.h` only. Do not commit this file:

   ```cpp
   #define WIFI_SSID  "YOUR_WIFI_SSID"
   #define WIFI_PASS  "YOUR_WIFI_PASSWORD"
   #define SERVER_URL "https://your-project.vercel.app/api/update-location"
   #define VEHICLE_ID "BUS_01"
   #define ROUTE_ID   "route_001"
   #define ROUTE_DIR  "outbound"
   ```

3. Check `mesh_config.h` for pin mapping, LoRa frequency, timing, and mesh limits. It contains no credentials and is safe to commit.

### Flash

- Vehicle node: open `Songthaew_V03_vehicle.ino` and upload.
- Ground station: open `Songthaew_V03_ground.ino` and upload.
- Legacy firmware without VIBE mesh: `Songthaew_V02.ino`.

Use Serial Monitor at `115200` baud.

Vehicle log examples:

```text
[TX-SLOT] pps_pin:D1 offset:500ms guard:100ms jitter_max:30ms
[TX] BUS_02 mode:pps hop:0 bytes:178 rssi:-77 sent
[RX] from BUS_03 hop:1 rssi:-88
```

Ground station log examples:

```text
[WiFi] connected IP:192.168.1.42
[RX] BUS_02 | hop:0 | rssi:-77 | snr:10.0
-> HTTP 200 (143ms)
```

### LoRa Settings

| Parameter | Value |
| --- | --- |
| Frequency | 923 MHz |
| Bandwidth | 125 kHz |
| Spreading Factor | SF7 |
| Coding Rate | 4/5 |
| TX Power | 17 dBm |
| Sync Word | 0x34 |
| Max Packet | 200 bytes |

### VIBE Packet Priority Tiers

When a LoRa packet gets close to 200 bytes, V03 keeps critical fields first and removes lower-priority data first.

| Tier | Fields | Droppable |
| --- | --- | --- |
| 1 Critical | id, seq, boot_id, timestamp, lat, lng, speed, battery, hop, packet_id, ttl | No |
| 2 Important | heading, routeId, direction, relay_from, link_quality, store_forward | Yes |
| 3 VIBE Mesh | relay_chain, top RSSI neighbors | Yes |
| 4 Optional | version_summary | Yes, first |

### Architecture

```text
Vehicle nodes -- LoRa mesh --> Ground station -- WiFi/4G --> Cloud server -- Dashboard
```

## Migration

`/api/locations` and `/api/update-location` remain available until **2026-09-30**. They return `Deprecation`, `Sunset`, and `Link` headers and emit a `[LEGACY_USED]` server log for every use. Migrate web clients to v1 and firmware to `/api/v1/telemetry` before the sunset date.

## Test and validation

Run JavaScript syntax checks with:

```sh
node --check server.js
node --check public/js/app.js
node --check public/js/shared.js
```

Before production, exercise valid/invalid vehicle keys, duplicate and out-of-order telemetry, GPS-without-fix packets, ETA quota failures, legacy audit logs, and mobile Passenger Map behavior.
