# Smart Songthaew v1

Passenger-facing vehicle tracking built with Express, Firebase Realtime Database, and Google Maps.

## Run locally

1. Copy `.env.example` to `.env` and set Firebase credentials, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `GOOGLE_MAPS_API_KEY`, and `GOOGLE_ROUTES_API_KEY`.
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
Authenticated admin session cookie
Content-Type: application/json

{ "key": "a-random-secret-with-at-least-24-characters" }
```

Only the salted key hash is stored. The web application no longer builds, stores, or updates device firmware.

## Forced-hop mesh test

The firmware has an opt-in test route for verifying two relays within a short range. It is disabled by default in `mesh_config.h`:

```cpp
#define FORCED_HOP_TEST_ENABLED 0
#define FORCED_HOP_TEST_SOURCE  "BUS_03"
#define FORCED_HOP_TEST_RELAY_1 "BUS_02"
#define FORCED_HOP_TEST_RELAY_2 "BUS_01"
```

Set `FORCED_HOP_TEST_ENABLED` to `1`, flash the same firmware to all three vehicles and Ground, then test this route:

```text
BUS_03 -> BUS_02 -> BUS_01 -> GROUND_01
```

Ground ignores the direct and intermediate copies of a forced-hop packet. A successful packet reaches the server with `hop: 2`, `relay_from: BUS_01`, `relay_chain: [BUS_02, BUS_01]`, `forced_hop_test: true`, and `forced_hop_complete: true`. Set the option back to `0` and flash all three vehicle boards again before normal operation.

For a 100 metre test, place Ground, BUS_01, BUS_02, and BUS_03 at roughly 0 m, 20-30 m, 50-70 m, and 80-100 m. Run at least 30 cycles and record the packet ID/hash, RSSI, SNR, hop, relay chain, Ground receive count, server accept count, and any relay queue drops. The expected success rate is at least 29 accepted final packets from 30 cycles.

## Migration

`POST /api/update-location` is retired and returns `410 Gone`. Use the authenticated `/api/v1/telemetry` or `/api/v1/ground/telemetry-batch` interfaces. `GET /api/locations` remains read-only until **2026-09-30**.

## Test and validation

Run JavaScript syntax checks with:

```sh
node --check server.js
node --check public/js/app.js
node --check public/js/shared.js
```

Before production, exercise valid/invalid vehicle keys, duplicate and out-of-order telemetry, GPS-without-fix packets, ETA quota failures, legacy audit logs, and mobile Passenger Map behavior.
