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
