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
