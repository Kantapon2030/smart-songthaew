/**
 * ============================================================
 *  server.js — Smart Songthaew Tracker (Improved v2)
 *  Node.js + Express + Firebase Admin SDK
 * ============================================================
 *
 *  BUG FIXES จากโค้ดเดิม:
 *  - [FIX] ลบ POST /api/update-location ซ้ำ (route ที่ 2 ถูก ignore)
 *  - [FIX] เพิ่ม GET /api/locations ที่ frontend เรียกใช้จริง
 *  - [FIX] แก้ todayStr() ให้ใช้ timezone Asia/Bangkok
 *
 *  IMPROVEMENTS:
 *  - รวม fields ทั้งสอง route เข้าด้วยกัน (vehicleId, routeId, direction, speed, battery)
 *  - เพิ่ม GET /api/analytics/peak-hours สำหรับ Admin chart
 *  - เพิ่ม GET /api/analytics/speed-by-hour สำหรับ Admin Speed chart
 *  - เพิ่ม GET /api/simulate สำหรับ dev test
 *  - Validation GPS coordinates
 *
 *  Firebase DB Structure:
 *    fleet/{vehicleId}/current         ← live position (overwrite)
 *    history/{date}/{vehicleId}/{ts}   ← time-series log
 *    routes_active/{date}/{routeId}/{vehicleId}
 *    analytics/peak_hours/{date}/{vehicleId}/{hour}
 * ============================================================
 */

'use strict';

require('dotenv').config();

const express    = require('express');
const admin      = require('firebase-admin');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const packageJson = require('./package.json');

// ── Firebase Init ─────────────────────────────────────────────────────────────
// [DEPLOY] อ่าน credentials จาก Environment Variable (Railway/Vercel)
// local dev: fallback อ่านจากไฟล์ firebase-service-account.json
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('[Firebase] Using credentials from ENV');
  } catch (e) {
    console.error('[Firebase] ERROR: FIREBASE_SERVICE_ACCOUNT is not valid JSON');
    process.exit(1);
  }
} else {
  try {
    serviceAccount = require('./firebase-service-account.json');
    console.log('[Firebase] Using credentials from file (local dev)');
  } catch (e) {
    console.error('[Firebase] ERROR: No credentials found.');
    console.error('  - Set FIREBASE_SERVICE_ACCOUNT env var (production)');
    console.error('  - Or place firebase-service-account.json in project root (local)');
    process.exit(1);
  }
}

admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://smart-songthaew-50aff-default-rtdb.asia-southeast1.firebasedatabase.app',
});

const db = admin.database();

// ── JWT Config ────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET environment variable is not set. Server will not start.');
  process.exit(1);
}
const JWT_EXPIRES = '8h'; // 8 hours
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD_HASH = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
const SESSION_COOKIE = 'ss_admin_session';
const SESSION_COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

// ── Rate Limiting Store ───────────────────────────────────────────────────────
const TELEMETRY_RATE_WINDOW_MS = 60 * 1000;
const TELEMETRY_RATE_MAX = 120;
let locationsCache = { key: null, expiresAt: 0, payload: null };
const LOCATIONS_CACHE_MS = 1000;
let networkCache = { key: null, expiresAt: 0, payload: null };
const NETWORK_CACHE_MS = 3000;
const DEFAULT_BATTERY_CALIBRATION = {
  adcMax: 1023,
  adcRefV: 3.3,
  dividerRatio: 6.6508,
  emptyVoltage: 3.30,
  fullVoltage: 4.19,
};

function clearLocationsCache() {
  locationsCache = { key: null, expiresAt: 0, payload: null };
}

function timeoutPromise(promise, timeoutMs, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function firebaseKeyPart(value) {
  return String(value || '').replace(/[.#$\/\[\]]/g, '_');
}

function hashKey(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseCookies(header = '') {
  return String(header).split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index < 1) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch (_) { cookies[key] = value; }
    return cookies;
  }, {});
}

function authConfigured() {
  return Boolean(JWT_SECRET && ADMIN_USERNAME && ADMIN_PASSWORD_HASH);
}

function sessionCookie(value, maxAge = SESSION_COOKIE_MAX_AGE_MS) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge / 1000)}${secure}`;
}

function getBangkokHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', hourCycle: 'h23',
  }).format(date));
}

function finiteNumberOrDefault(value, fallback, min = -Infinity, max = Infinity) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalizeBatteryCalibrationConfig(input = {}) {
  const defaults = DEFAULT_BATTERY_CALIBRATION;
  const adcMax = finiteNumberOrDefault(input.adcMax, defaults.adcMax, 1, 4095);
  const adcRefV = finiteNumberOrDefault(input.adcRefV, defaults.adcRefV, 0.1, 5.5);
  const dividerRatio = finiteNumberOrDefault(input.dividerRatio, defaults.dividerRatio, 0.1, 100);
  let emptyVoltage = finiteNumberOrDefault(input.emptyVoltage, defaults.emptyVoltage, 0, 20);
  let fullVoltage = finiteNumberOrDefault(input.fullVoltage, defaults.fullVoltage, 0, 20);
  if (fullVoltage <= emptyVoltage) {
    emptyVoltage = defaults.emptyVoltage;
    fullVoltage = defaults.fullVoltage;
  }
  return {
    adcMax,
    adcRefV,
    dividerRatio,
    emptyVoltage,
    fullVoltage,
  };
}

function calculateBatteryFromRaw(rawValue, calibrationInput = {}) {
  const raw = Number(rawValue);
  if (!Number.isFinite(raw) || raw < 0) return null;
  const calibration = normalizeBatteryCalibrationConfig(calibrationInput);
  const a0Voltage = raw / calibration.adcMax * calibration.adcRefV;
  const batteryVoltage = a0Voltage * calibration.dividerRatio;
  const percent = (batteryVoltage - calibration.emptyVoltage) * 100 /
    (calibration.fullVoltage - calibration.emptyVoltage);
  return {
    raw: Math.round(raw),
    a0Voltage: Number(a0Voltage.toFixed(3)),
    battVoltage: Math.round(batteryVoltage * 1000),
    battery: Number(Math.min(100, Math.max(0, percent)).toFixed(1)),
  };
}

// ── Auth Middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const cookieToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const token = cookieToken || (authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '');
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized - No token' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized - Invalid token' });
  }
}

// ── Rate Limit Middleware ───────────────────────────────────────────────────
async function rateLimitMiddleware(req, res, next) {
  const identity = req.get('X-Ground-Key') || req.get('X-Vehicle-Key') || req.body?.ground_id || req.body?.vehicle_id || req.ip || 'anonymous';
  const ref = db.ref(`security/rate_limits/${hashKey(`${req.path}:${identity}`)}`);
  const now = Date.now();
  try {
    const result = await ref.transaction(current => {
      if (!current || now - Number(current.startedAt || 0) >= TELEMETRY_RATE_WINDOW_MS) return { startedAt: now, count: 1 };
      return { startedAt: current.startedAt, count: Number(current.count || 0) + 1 };
    });
    if (Number(result.snapshot.val()?.count || 0) > TELEMETRY_RATE_MAX) {
      return res.status(429).json({ error: 'Too many telemetry requests', retryAfter: 60 });
    }
    return next();
  } catch (error) {
    console.error('[RATE_LIMIT]', error.message);
    return res.status(503).json({ error: 'Rate limiter unavailable' });
  }
}

// ── Explicit legacy seed helper (never called during application startup) ─────
async function initializeDefaultData() {
  try {
    // ── Auto-purge stale DEMO/TWIN vehicles on startup ──
    const fleetSnap = await db.ref('fleet').once('value');
    const fleet = fleetSnap.val() || {};
    const staleKeys = Object.keys(fleet).filter(k => k.startsWith('DEMO_') || k.startsWith('TWIN_'));
    if (staleKeys.length) {
      const purge = {};
      staleKeys.forEach(k => { purge[`fleet/${k}`] = null; });
      await db.ref().update(purge);
      console.log('[Init] Purged stale vehicles:', staleKeys.join(', '));
    }

    // Check if default route exists
    const routesSnap = await db.ref('routes').once('value');
    if (!routesSnap.exists()) {
      // เส้นทางจริง: นครศรีธรรมราช (เซ็นทรัล) → พรหมคีรี (โรงเรียนเตรียมอุดมฯ ภาคใต้)
      const defaultRoute = {
        name: 'นครศรีธรรมราช ↔ พรหมคีรี (ถนน 4016)',
        description: 'วงเวียนนาคร → โรงเรียนพรหมคีรีนครศรีธรรมราช ผ่านถนน 4016',
        coords: [
          [8.4325,99.9629],[8.4340,99.9430],[8.4370,99.9200],
          [8.4480,99.9000],[8.4680,99.8820],[8.4900,99.8680],
          [8.5120,99.8530],[8.5350,99.8380],[8.5580,99.8250],
          [8.5780,99.8160],
        ],
        stops: [
          { name: 'นครศรีธรรมราช (วงเวียนนาคร)', lat: 8.4325, lng: 99.9629 },
          { name: 'โรงเรียนพรหมคีรีนครศรีธรรมราช', lat: 8.5780, lng: 99.8160 },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      defaultRoute.id = 'route_nakhon_phromkhiri';
      defaultRoute.shortName = 'นคร-พรหม';
      defaultRoute.color = '#2563EB';
      defaultRoute.active = true;
      defaultRoute.directions = {
        outbound: {
          label: 'ขาไป (นครฯ → พรหมคีรี)',
          coords: normalizeCoordsList(defaultRoute.coords),
          stops: normalizeStopList(defaultRoute.stops, defaultRoute.id, 'outbound'),
        },
        inbound: {
          label: 'ขากลับ (พรหมคีรี → นครฯ)',
          coords: normalizeCoordsList(defaultRoute.coords).reverse(),
          stops: normalizeStopList(defaultRoute.stops, defaultRoute.id, 'inbound').reverse(),
        },
      };
      delete defaultRoute.coords;
      delete defaultRoute.stops;
      await db.ref('routes/route_nakhon_phromkhiri').set(defaultRoute);
      console.log('[Init] Default route created: นครศรีธรรมราช ↔ พรหมคีรี');
    }
  } catch (e) {
    console.error('[Init] Error:', e);
  }
}

// ── Express ───────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    // Legacy pages still contain inline handlers. Keep this compatibility allowance
    // while those handlers are migrated to addEventListener; all third-party origins
    // remain explicitly allow-listed.
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://maps.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://maps.googleapis.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
  });
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', async (_req, res) => {
  let firebase = 'ok';
  try {
    await timeoutPromise(db.ref('system/config').once('value'), 3000, 'firebase_health');
  } catch (error) {
    firebase = 'error';
    console.error('[HEALTH] Firebase check failed:', error.message);
  }

  const ready = firebase === 'ok' && authConfigured();
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    firebase,
    auth: authConfigured() ? 'ok' : 'misconfigured',
    uptime_s: Math.floor(process.uptime()),
    version: packageJson.version || 'unknown',
    ts: Date.now(),
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
/** วันที่ปัจจุบัน (timezone Bangkok) → "2026-03-16" */
function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

/** ตรวจ GPS bound (Thailand) */
function validLatLng(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    !isNaN(lat) && !isNaN(lng) &&
    lat >= 5.5 && lat <= 20.5 &&
    lng >= 97.5 && lng <= 105.7
  );
}

const DEFAULT_GROUND_STATION = {
  id: 'GROUND_01',
  label: 'สถานีภาคพื้น',
  lat: 8.4304,
  lng: 99.9631,
};

function normalizeGroundStationConfig(value = {}) {
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  const id = String(value.id || DEFAULT_GROUND_STATION.id).trim().replace(/[^\w-]/g, '').slice(0, 40) || DEFAULT_GROUND_STATION.id;
  const label = String(value.label || DEFAULT_GROUND_STATION.label).trim().slice(0, 80) || DEFAULT_GROUND_STATION.label;
  return {
    id,
    label,
    lat: validLatLng(lat, lng) ? lat : DEFAULT_GROUND_STATION.lat,
    lng: validLatLng(lat, lng) ? lng : DEFAULT_GROUND_STATION.lng,
  };
}

function normalizeCoordPoint(point) {
  const lat = Array.isArray(point) ? Number(point[0]) : Number(point?.lat);
  const lng = Array.isArray(point) ? Number(point[1]) : Number(point?.lng);
  return validLatLng(lat, lng) ? { lat, lng } : null;
}

function normalizeCoordsList(coords = []) {
  return (Array.isArray(coords) ? coords : [])
    .map(normalizeCoordPoint)
    .filter(Boolean);
}

function normalizeStopList(stops = [], routeId = '', dir = 'outbound') {
  return (Array.isArray(stops) ? stops : [])
    .map((stop, index) => {
      const point = normalizeCoordPoint(stop);
      if (!point) return null;
      return {
        id: String(stop?.id || stop?.place_id || `${dir}_stop_${index + 1}`),
        name: String(stop?.name || `Stop ${index + 1}`),
        lat: point.lat,
        lng: point.lng,
      };
    })
    .filter(Boolean);
}

function normalizeRouteDirection(direction = {}, fallback = {}, routeId = '', dir = 'outbound') {
  const fallbackLabel = dir === 'inbound' ? 'ขากลับ' : 'ขาไป';
  return {
    label: String(direction?.label || fallback?.label || fallbackLabel),
    coords: normalizeCoordsList(direction?.coords ?? fallback?.coords ?? []),
    stops: normalizeStopList(direction?.stops ?? fallback?.stops ?? [], routeId, dir),
  };
}

function routeVehicleCount(fleet = {}, routeId = '') {
  return Object.values(fleet || {}).filter(v => (v?.routeId || v?.route_id) === routeId).length;
}

function normalizeRouteForApi(route = {}, routeId = '', vehicleCount = 0) {
  const id = String(route?.id || route?.routeId || route?.route_id || routeId || '');
  const outbound = normalizeRouteDirection(route?.directions?.outbound, {
    coords: route?.coords,
    stops: route?.stops || route?.places,
  }, id, 'outbound');
  const inbound = normalizeRouteDirection(route?.directions?.inbound, {}, id, 'inbound');
  const stopCount = outbound.stops.length + inbound.stops.length;
  return {
    ...route,
    id,
    routeId: id,
    route_id: id,
    name: String(route?.name || id || 'Untitled route'),
    shortName: String(route?.shortName || route?.short_name || '').slice(0, 10),
    color: route?.color || '#2563EB',
    active: route?.active !== false,
    directions: { outbound, inbound },
    coords: outbound.coords,
    stops: outbound.stops,
    vehicleCount,
    stopCount,
  };
}

function sanitizeRouteId(value) {
  const clean = String(value || '')
    .trim()
    .replace(/[^\w-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return clean || `route_${Date.now()}`;
}

function buildRouteForWrite(body = {}, routeId = '', existing = {}) {
  const now = Date.now();
  const merged = { ...existing, ...body, id: routeId };
  const normalized = normalizeRouteForApi(merged, routeId);
  const route = {
    id: routeId,
    name: normalized.name,
    shortName: normalized.shortName,
    color: normalized.color,
    active: normalized.active,
    directions: normalized.directions,
    createdAt: existing?.createdAt || body?.createdAt || now,
    updatedAt: now,
  };
  if (body.description !== undefined || existing.description !== undefined) {
    route.description = body.description ?? existing.description ?? '';
  }
  return route;
}

function buildRoutePatch(body = {}) {
  const updates = { updatedAt: Date.now() };
  ['name', 'shortName', 'color', 'active', 'description'].forEach(field => {
    if (body[field] !== undefined) {
      updates[field] = field === 'shortName' ? String(body[field]).slice(0, 10) : body[field];
    }
  });
  if (body.coords !== undefined) updates['directions/outbound/coords'] = normalizeCoordsList(body.coords);
  if (body.stops !== undefined) updates['directions/outbound/stops'] = normalizeStopList(body.stops, '', 'outbound');
  for (const dir of ['outbound', 'inbound']) {
    const direction = body?.directions?.[dir];
    if (!direction) continue;
    if (direction.label !== undefined) updates[`directions/${dir}/label`] = String(direction.label);
    if (direction.coords !== undefined) updates[`directions/${dir}/coords`] = normalizeCoordsList(direction.coords);
    if (direction.stops !== undefined) updates[`directions/${dir}/stops`] = normalizeStopList(direction.stops, '', dir);
  }
  return updates;
}

function validRouteDir(dir) {
  return dir === 'outbound' || dir === 'inbound';
}

const LEGACY_SUNSET = '2026-09-30';
const ETA_CACHE_MS = 30 * 1000;
const ETA_SESSION_LIMIT = 10;
const ETA_IP_LIMIT = 60;
const ETA_WINDOW_MS = 60 * 1000;
const etaCache = new Map();
const etaRateLimits = new Map();
const ROUTE_ALIASES = {
  route_001: 'NST-PROMKHIRI',
  '001': 'NST-PROMKHIRI',
  route_nakhon_phromkhiri: 'NST-PROMKHIRI',
  nakhon_phromkhiri: 'NST-PROMKHIRI',
};

function unixNow() { return Math.floor(Date.now() / 1000); }
function canonicalRouteId(routeId) { return ROUTE_ALIASES[routeId] || routeId || 'unassigned'; }
function validGpsTime(value, now = unixNow()) {
  return Number.isInteger(value) && value >= 946684800 && value <= now + 24 * 60 * 60;
}
function vehicleStatus(lastSeen, now = unixNow()) {
  const age = Math.max(0, now - Number(lastSeen || 0));
  if (age <= 90) return 'online';
  if (age <= 120) return 'delayed';
  return 'offline';
}
function isConnectivityStatus(status) {
  return ['online', 'delayed', 'offline'].includes(String(status || '').toLowerCase());
}
function normalizeTelemetryStatus(status) {
  const value = String(status || '').trim();
  if (!value || isConnectivityStatus(value)) return '';
  return value.slice(0, 40);
}
function legacyHeaders(res, successor) {
  res.set('Deprecation', 'true');
  res.set('Sunset', LEGACY_SUNSET);
  res.set('Link', `<${successor}>; rel="successor-version"`);
}
function logLegacy(req, vehicleId) {
  console.warn(`[LEGACY_USED] endpoint=${req.path} vehicle_id=${vehicleId || '-'} ip=${req.ip}`);
}

function sanitizePlate(value) {
  const plate = String(value || '').trim();
  if (!plate) return '';
  return plate.replace(/\s+/g, ' ').slice(0, 32);
}

function normalizeTelemetryFields(current = {}, entry = {}) {
  const out = {};
  const numericFields = [
    'batteryRaw', 'a0Voltage', 'battVoltage', 'currentMa', 'powerMw', 'txCount', 'sats', 'hdop',
    'rssi', 'snr', 'link_quality', 'seq', 'ttl', 'received_rssi',
    'received_snr', 'heading', 'bearing'
  ];
  const textFields = ['boot_id', 'packet_id', 'relay_from', 'source', 'telemetry_status', 'gps_status'];
  const boolFields = ['store_forward', 'gps_fix', 'sleepMode', 'demo'];
  const arrayFields = ['relay_chain', 'neighbors', 'version_summary'];

  numericFields.forEach(field => {
    const value = Number(current[field]);
    if (Number.isFinite(value)) out[field] = value;
  });
  textFields.forEach(field => {
    if (current[field] !== undefined && current[field] !== null && current[field] !== '') out[field] = current[field];
  });
  boolFields.forEach(field => {
    if (current[field] !== undefined) out[field] = current[field] === true;
  });
  arrayFields.forEach(field => {
    if (Array.isArray(current[field])) out[field] = current[field];
  });

  const plate = sanitizePlate(entry.plate || current.plate || current.license_plate || current.licensePlate);
  if (plate) out.plate = plate;
  if (entry.description || current.description) out.description = entry.description || current.description;
  return out;
}

function normalizeVehicle(vehicleId, entry, now = unixNow()) {
  const current = entry?.current || entry || {};
  const receivedAt = Number(current.server_received_at || current.serverReceivedAt || current.last_seen || current.lastSeen || Math.floor(Number(current.timestamp || 0) / 1000));
  const lastSeen = Number.isFinite(receivedAt) && receivedAt > 0 ? receivedAt : 0;
  const heading = Number(current.heading ?? current.bearing ?? 0);
  return {
    vehicle_id: current.vehicle_id || vehicleId,
    lat: Number(current.lat),
    lng: Number(current.lng),
    speed: Number(current.speed || 0),
    heading,
    bearing: Number(current.bearing ?? heading),
    battery: current.battery ?? -1,
    gps_time: validGpsTime(Number(current.gps_time)) ? Number(current.gps_time) : null,
    server_received_at: lastSeen,
    last_seen: lastSeen,
    gps_fix: current.gps_fix ?? validLatLng(Number(current.lat), Number(current.lng)),
    status: vehicleStatus(lastSeen, now),
    route_id: canonicalRouteId(current.route_id || current.routeId || entry?.routeId),
    direction: current.direction || 'unknown',
    hop: Number.isFinite(Number(current.hop)) ? Number(current.hop) : 0,
    source: current.source || 'legacy',
    ...normalizeTelemetryFields({ ...current, heading, bearing: Number(current.bearing ?? heading) }, entry),
  };
}
function isWithinRouteCorridor(lat, lng, coords, radiusKm = 5) {
  if (!Array.isArray(coords) || coords.length < 2) return false;
  const toRadians = value => value * Math.PI / 180;
  const meanLat = toRadians(lat);
  const kmPoint = (a, b) => ({ x: (b - lng) * 111.32 * Math.cos(meanLat), y: (a - lat) * 110.57 });
  for (let i = 0; i < coords.length - 1; i++) {
    const [aLat, aLng] = coords[i];
    const [bLat, bLng] = coords[i + 1];
    const a = kmPoint(aLat, aLng), b = kmPoint(bLat, bLng);
    const lengthSq = b.x * b.x + b.y * b.y;
    const t = lengthSq ? Math.max(0, Math.min(1, (-(a.x * (b.x - a.x) + a.y * (b.y - a.y))) / lengthSq)) : 0;
    const x = a.x + t * (b.x - a.x), y = a.y + t * (b.y - a.y);
    if (Math.hypot(x, y) <= radiusKm) return true;
  }
  return false;
}
function consumeRateLimit(key, limit) {
  const now = Date.now();
  const recent = (etaRateLimits.get(key) || []).filter(ts => now - ts < ETA_WINDOW_MS);
  if (recent.length >= limit) {
    etaRateLimits.set(key, recent);
    return Math.ceil((ETA_WINDOW_MS - (now - recent[0])) / 1000);
  }
  recent.push(now);
  etaRateLimits.set(key, recent);
  return 0;
}
async function verifyVehicleKey(vehicleId, providedKey) {
  if (!providedKey) return false;
  const snap = await db.ref(`system/device_credentials/${vehicleId}`).once('value');
  const credential = snap.val();
  const keyHash = typeof credential === 'string' ? credential : credential?.keyHash;
  return !!keyHash && bcrypt.compareSync(providedKey, keyHash);
}
async function verifyGroundKey(groundId, providedKey) {
  if (!groundId || !providedKey) return false;
  const snap = await db.ref(`system/ground_credentials/${firebaseKeyPart(groundId)}`).once('value');
  const credential = snap.val();
  const keyHash = typeof credential === 'string' ? credential : credential?.keyHash;
  return !!keyHash && bcrypt.compareSync(providedKey, keyHash);
}
function telemetryDecision(previous, packet) {
  if (!previous) return { accepted: true };
  if (previous.boot_id === packet.boot_id) {
    if (packet.seq === previous.seq) return { accepted: false, reason: 'duplicate_seq' };
    if (packet.seq < previous.seq) return { accepted: false, reason: 'out_of_order_seq' };
  }
  const previousGpsTime = Number(previous.gps_time);
  if (previous.boot_id !== packet.boot_id && packet.gps_fix && previous.gps_fix && validGpsTime(packet.gps_time) && validGpsTime(previousGpsTime) && packet.gps_time < previousGpsTime) {
    return { accepted: false, reason: 'stale_gps_time' };
  }
  return { accepted: true };
}

function isDemoVehicle(vehicleId, entry = {}) {
  const current = entry?.current || entry || {};
  return vehicleId.startsWith('DEMO') || vehicleId.startsWith('TWIN') || entry?.demo === true || current.demo === true;
}

function hasValidGpsFix(current = {}) {
  return current.gps_fix !== false && validLatLng(Number(current.lat), Number(current.lng));
}

function hasLastKnownPosition(current = {}) {
  const telemetryStatus = current.telemetry_status || normalizeTelemetryStatus(current.status);
  return ['last_known', 'gps_hold'].includes(telemetryStatus) && validLatLng(Number(current.lat), Number(current.lng));
}

function currentForLiveMode(current = {}) {
  if (hasValidGpsFix(current) || hasLastKnownPosition(current)) return current;
  const { lat, lng, ...withoutCoordinates } = current;
  return withoutCoordinates;
}

function currentForFleetResponse(vehicleId, entry = {}, demoMode = false) {
  const current = entry.current && !demoMode ? currentForLiveMode(entry.current) : entry.current;
  if (!current) return null;
  const routeId = current.routeId || current.route_id || entry.routeId || 'unassigned';
  const receivedAt = Number(current.server_received_at || current.serverReceivedAt || current.last_seen || current.lastSeen || Math.floor(Number(current.timestamp || 0) / 1000));
  const lastSeen = Number.isFinite(receivedAt) && receivedAt > 0 ? receivedAt : 0;
  const telemetryStatus = current.telemetry_status || normalizeTelemetryStatus(current.status);
  return {
    ...current,
    vehicle_id: current.vehicle_id || current.vehicleId || vehicleId,
    routeId,
    route_id: current.route_id || routeId,
    server_received_at: lastSeen,
    last_seen: lastSeen,
    status: vehicleStatus(lastSeen),
    ...(telemetryStatus ? { telemetry_status: telemetryStatus } : {}),
    ...normalizeTelemetryFields(current, entry),
  };
}

async function getDemoMode() {
  const config = (await db.ref('system/config').once('value')).val() || {};
  return config.demoMode === true;
}
// Mesh network helpers
function haversineDistanceMeters(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function normalizeHistoryDate(value) {
  const date = String(value || todayStr()).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayStr();
}

function sanitizeHistoryVehicleId(value) {
  return String(value || '').trim().replace(/[^\w-]/g, '').slice(0, 80);
}

function parseHistoryTimestamp(key, record = {}) {
  const serverReceived = Number(record.server_received_at || record.last_seen);
  if (Number.isFinite(serverReceived) && serverReceived > 0) return serverReceived > 10_000_000_000 ? Math.floor(serverReceived / 1000) : Math.floor(serverReceived);
  const timestamp = Number(record.timestamp || key);
  if (Number.isFinite(timestamp) && timestamp > 0) return timestamp > 10_000_000_000 ? Math.floor(timestamp / 1000) : Math.floor(timestamp);
  return null;
}

function formatHistoryTime(ts) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ts * 1000));
}

function historyHour(ts) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok',
    hour: 'numeric',
    hour12: false,
  }).format(new Date(ts * 1000))) % 24;
}

function parseHistoryTimeFilter(value) {
  const match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60;
}

function secondsOfDayBangkok(ts) {
  const [hh, mm, ss] = formatHistoryTime(ts).split(':').map(Number);
  return hh * 3600 + mm * 60 + ss;
}

function normalizeHistoryPoint(vehicleId, key, record = {}) {
  const lat = Number(record.lat);
  const lng = Number(record.lng);
  const ts = parseHistoryTimestamp(key, record);
  if (!ts || !validLatLng(lat, lng)) return null;
  const numberOrNull = value => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };
  return {
    vehicleId,
    ts,
    time: formatHistoryTime(ts),
    lat,
    lng,
    speed: numberOrNull(record.speed) ?? 0,
    battery: numberOrNull(record.battery),
    rssi: numberOrNull(record.rssi ?? record.received_rssi),
    hop: numberOrNull(record.hop) ?? 0,
    direction: record.direction || 'unknown',
    gps_fix: record.gps_fix !== false,
    routeId: record.route_id || record.routeId || 'unassigned',
    source: record.source || '',
  };
}

function historyPointsFromVehicle(vehicleId, vehicleHistory = {}, filters = {}) {
  const fromSeconds = parseHistoryTimeFilter(filters.from);
  const toSeconds = parseHistoryTimeFilter(filters.to);
  return Object.entries(vehicleHistory || {})
    .map(([key, record]) => normalizeHistoryPoint(vehicleId, key, record))
    .filter(Boolean)
    .filter(point => {
      const daySecond = secondsOfDayBangkok(point.ts);
      if (fromSeconds !== null && daySecond < fromSeconds) return false;
      if (toSeconds !== null && daySecond > toSeconds) return false;
      return true;
    })
    .sort((a, b) => a.ts - b.ts);
}

function activeSecondsForHistory(points) {
  if (points.length < 2) return 0;
  let active = 0;
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].ts - points[i - 1].ts;
    if (gap > 0 && gap <= 300) active += gap;
  }
  return active;
}

function summarizeHistoryPoints(points) {
  const speeds = points.map(point => Number(point.speed)).filter(Number.isFinite);
  const batteries = points.map(point => Number(point.battery)).filter(Number.isFinite);
  let distanceM = 0;
  for (let i = 1; i < points.length; i++) {
    distanceM += haversineDistanceMeters(points[i - 1], points[i]);
  }
  const activeSeconds = activeSecondsForHistory(points);
  const spanSeconds = points.length > 1 ? Math.max(1, points[points.length - 1].ts - points[0].ts) : 0;
  const avgSpeed = speeds.length ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : 0;
  return {
    totalPoints: points.length,
    avgSpeed: Number(avgSpeed.toFixed(1)),
    maxSpeed: speeds.length ? Math.max(...speeds) : 0,
    minBattery: batteries.length ? Math.min(...batteries) : null,
    startTime: points[0]?.time || null,
    endTime: points[points.length - 1]?.time || null,
    distanceKm: Number((distanceM / 1000).toFixed(2)),
    onlineRatio: points.length <= 1 ? (points.length ? 1 : 0) : Number(Math.min(1, activeSeconds / spanSeconds).toFixed(2)),
    activeHours: Number((activeSeconds / 3600).toFixed(2)),
    batteryStart: batteries.length ? points.find(point => Number.isFinite(Number(point.battery)))?.battery ?? null : null,
    batteryEnd: batteries.length ? [...points].reverse().find(point => Number.isFinite(Number(point.battery)))?.battery ?? null : null,
  };
}

function topHistoryHours(points, analyticsHours = {}) {
  const counts = {};
  Object.entries(analyticsHours || {}).forEach(([hour, count]) => {
    const h = Number(hour);
    if (Number.isInteger(h) && h >= 0 && h < 24 && Number(count) > 0) counts[h] = Number(count);
  });
  if (!Object.keys(counts).length) {
    points.forEach(point => {
      const hour = historyHour(point.ts);
      counts[hour] = (counts[hour] || 0) + 1;
    });
  }
  return Object.entries(counts)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || Number(a[0]) - Number(b[0]))
    .slice(0, 4)
    .map(([hour]) => Number(hour));
}

function finiteNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeBatteryPercent(record = {}) {
  const value = finiteNumberOrNull(record.battery ?? record.batteryPct ?? record.battery_percent);
  if (value === null || value < 0) return null;
  return Number(Math.min(100, value).toFixed(1));
}

function normalizeBatteryVoltage(record = {}) {
  const raw = finiteNumberOrNull(record.battVoltage ?? record.batteryVoltage ?? record.voltage ?? record.vbat);
  if (raw === null || raw <= 0) return null;
  const volts = raw > 20 ? raw / 1000 : raw;
  return Number(volts.toFixed(2));
}

function diagnosticRowsFromVehicleHistory(vehicleId, vehicleHistory = {}) {
  return Object.entries(vehicleHistory || {})
    .map(([key, record = {}]) => {
      const ts = parseHistoryTimestamp(key, record);
      if (!ts) return null;
      return {
        key,
        vehicleId,
        ts,
        time: formatHistoryTime(ts),
        record,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);
}

async function loadDiagnosticRows(vehicleId, date) {
  const snap = await db.ref(`history/${date}/${vehicleId}`).once('value');
  return diagnosticRowsFromVehicleHistory(vehicleId, snap.val() || {})
    .map(row => ({ ...row, date }));
}

function localDateFromMs(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

function historyDateToUtcMs(date) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function historyDatesBetween(startDate, endDate) {
  const startMs = historyDateToUtcMs(startDate);
  const endMs = historyDateToUtcMs(endDate);
  if (startMs === null || endMs === null) return [];
  const dates = [];
  const step = 24 * 60 * 60 * 1000;
  for (let ms = startMs; ms <= endMs; ms += step) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

function normalizeDiagnosticsDateRange(query = {}, maxDays = 120) {
  const fromRaw = query.from || query.startDate || query.start || query.date;
  const toRaw = query.to || query.endDate || query.end || query.date || fromRaw;
  let startDate = normalizeHistoryDate(fromRaw);
  let endDate = normalizeHistoryDate(toRaw);
  if (historyDateToUtcMs(startDate) > historyDateToUtcMs(endDate)) {
    [startDate, endDate] = [endDate, startDate];
  }
  const dates = historyDatesBetween(startDate, endDate);
  return {
    startDate,
    endDate,
    dates,
    tooLong: dates.length > maxDays,
    maxDays,
  };
}

function average(values, digits = 1) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return Number((clean.reduce((sum, value) => sum + value, 0) / clean.length).toFixed(digits));
}

function summarizePdrRows(rows, targetPackets, startTime, endTime) {
  const scoped = rows.filter(row => {
    const ms = row.ts * 1000;
    return ms >= startTime && ms <= endTime;
  });
  const rssiValues = scoped.map(row => finiteNumberOrNull(row.record.rssi ?? row.record.received_rssi)).filter(Number.isFinite);
  const snrValues = scoped.map(row => finiteNumberOrNull(row.record.snr ?? row.record.received_snr)).filter(Number.isFinite);
  const received = scoped.length;
  return {
    received,
    targetPackets,
    pdr: targetPackets > 0 ? Number(Math.min(100, (received / targetPackets) * 100).toFixed(1)) : 0,
    avgRSSI: average(rssiValues, 1),
    avgSNR: average(snrValues, 1),
    elapsed_s: Math.max(0, Math.round((endTime - startTime) / 1000)),
  };
}

function pdrSampleValues(samples = {}) {
  return Object.values(samples || {})
    .filter(sample => sample && typeof sample === 'object')
    .sort((a, b) => Number(a.receivedAt || 0) - Number(b.receivedAt || 0));
}

function summarizePdrSamples(samples = [], session = {}, endTime = Date.now()) {
  const targetPackets = Number(session.targetPackets || 100);
  const startTime = Number(session.startTime || session.startedAt || endTime);
  const scoped = samples.filter(sample => {
    const receivedAt = Number(sample.receivedAt || 0);
    return receivedAt >= startTime && receivedAt <= endTime;
  });
  const rssiValues = scoped.map(sample => finiteNumberOrNull(sample.rssi)).filter(Number.isFinite);
  const snrValues = scoped.map(sample => finiteNumberOrNull(sample.snr)).filter(Number.isFinite);
  const received = scoped.length;
  const lastPacketAt = scoped.length ? Math.max(...scoped.map(sample => Number(sample.receivedAt || 0))) : null;
  return {
    received,
    targetPackets,
    pdr: targetPackets > 0 ? Number(Math.min(100, (received / targetPackets) * 100).toFixed(1)) : 0,
    avgRSSI: average(rssiValues, 1),
    avgSNR: average(snrValues, 1),
    elapsed_s: Math.max(0, Math.round((endTime - startTime) / 1000)),
    lastPacketAt,
    pdrSource: 'live_packets',
  };
}

async function calculatePdrSessionProgress(session = {}) {
  const vehicleId = sanitizeHistoryVehicleId(session.vehicleId);
  const startTime = Number(session.startTime || session.startedAt || Date.now());
  const endTime = session.status === 'running' ? Date.now() : Number(session.endTime || Date.now());
  const samples = pdrSampleValues(session.samples);
  if (samples.length || session.pdrSource === 'live_packets') {
    return summarizePdrSamples(samples, session, endTime);
  }
  const dates = [...new Set([localDateFromMs(startTime), localDateFromMs(endTime)])];
  const allRows = [];
  for (const date of dates) {
    allRows.push(...await loadDiagnosticRows(vehicleId, date));
  }
  return {
    ...summarizePdrRows(allRows, Number(session.targetPackets || 100), startTime, endTime),
    pdrSource: 'history_fallback',
  };
}

const PDR_SESSION_CACHE_MS = 1000;
const pdrSessionCache = new Map();

function clearPdrSessionCache(vehicleId) {
  if (vehicleId) pdrSessionCache.delete(sanitizeHistoryVehicleId(vehicleId));
  else pdrSessionCache.clear();
}

function pdrPacketKey(packet = {}) {
  if (packet.packet_id) return `packet_${firebaseKeyPart(packet.packet_id)}`;
  if (packet.boot_id && packet.seq !== null && packet.seq !== undefined) {
    return `seq_${firebaseKeyPart(packet.boot_id)}_${firebaseKeyPart(packet.seq)}`;
  }
  return `rx_${Number(packet.receivedAtMs || Date.now())}_${Math.random().toString(36).slice(2, 8)}`;
}

async function getRunningPdrSessionsForVehicle(vehicleId) {
  const cleanVehicleId = sanitizeHistoryVehicleId(vehicleId);
  const now = Date.now();
  const cached = pdrSessionCache.get(cleanVehicleId);
  if (cached && cached.expiresAt > now) return cached.sessions;

  const snap = await db.ref('diagnostics/pdrTests').orderByChild('vehicleId').equalTo(cleanVehicleId).once('value');
  const sessions = Object.entries(snap.val() || {})
    .filter(([, session]) => session?.status === 'running');
  pdrSessionCache.set(cleanVehicleId, {
    expiresAt: now + PDR_SESSION_CACHE_MS,
    sessions,
  });
  return sessions;
}

async function recordPdrPacketForVehicle(vehicleId, packet = {}) {
  const cleanVehicleId = sanitizeHistoryVehicleId(vehicleId);
  if (!cleanVehicleId) return 0;
  const receivedAt = Number(packet.receivedAtMs || Date.now());
  const sessions = await getRunningPdrSessionsForVehicle(cleanVehicleId);
  let counted = 0;

  for (const [sessionId, session] of sessions) {
    if (!session || session.status !== 'running') continue;
    const startTime = Number(session.startTime || 0);
    const endTime = Number(session.endTime || 0);
    if (startTime && receivedAt < startTime) continue;
    if (endTime && receivedAt > endTime) continue;

    const key = pdrPacketKey(packet);
    const sample = {
      receivedAt,
      packet_id: packet.packet_id || null,
      boot_id: packet.boot_id || null,
      seq: packet.seq ?? null,
      rssi: finiteNumberOrNull(packet.rssi ?? packet.received_rssi),
      snr: finiteNumberOrNull(packet.snr ?? packet.received_snr),
      hop: finiteNumberOrNull(packet.hop),
      gps_fix: packet.gps_fix === true,
      source: packet.source || 'telemetry',
      routeId: packet.routeId || packet.route_id || 'unassigned',
    };
    const sampleRef = db.ref(`diagnostics/pdrTests/${sessionId}/samples/${key}`);
    const sampleResult = await sampleRef.transaction(current => current ? undefined : sample);
    if (!sampleResult.committed) continue;

    const update = {
      received: admin.database.ServerValue.increment(1),
      updatedAt: receivedAt,
      lastPacketAt: receivedAt,
      pdrSource: 'live_packets',
    };
    if (sample.rssi !== null) {
      update.rssiSum = admin.database.ServerValue.increment(sample.rssi);
      update.rssiCount = admin.database.ServerValue.increment(1);
    }
    if (sample.snr !== null) {
      update.snrSum = admin.database.ServerValue.increment(sample.snr);
      update.snrCount = admin.database.ServerValue.increment(1);
    }
    await db.ref(`diagnostics/pdrTests/${sessionId}`).update(update);
    counted += 1;
  }

  return counted;
}

async function recordPdrPacketSafely(vehicleId, packet = {}) {
  try {
    return await recordPdrPacketForVehicle(vehicleId, packet);
  } catch (error) {
    console.warn('[PDR] packet counter skipped:', error.message);
    return 0;
  }
}

function isValidCoord(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number' &&
    lat >= 5.5 && lat <= 20.5 && lng >= 97.5 && lng <= 105.7;
}

function linkPairKey(from, to) {
  return [String(from || ''), String(to || '')].sort().join('|');
}

function deduplicateLinks(links) {
  const seen = new Set();
  return links.filter(link => {
    const key = linkPairKey(link.from, link.to);
    if (!link.from || !link.to || link.from === link.to || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveUpstream(nodeA, nodeB) {
  const hopA = Number.isFinite(Number(nodeA?.hop)) ? Number(nodeA.hop) : Number.MAX_SAFE_INTEGER;
  const hopB = Number.isFinite(Number(nodeB?.hop)) ? Number(nodeB.hop) : Number.MAX_SAFE_INTEGER;
  if (hopA !== hopB) {
    return hopA < hopB
      ? { from: nodeB.id, to: nodeA.id }
      : { from: nodeA.id, to: nodeB.id };
  }

  const rssiA = Number(nodeA?.received_rssi ?? nodeA?.rssi);
  const rssiB = Number(nodeB?.received_rssi ?? nodeB?.rssi);
  if (Number.isFinite(rssiA) && Number.isFinite(rssiB) && rssiA !== rssiB) {
    return rssiA > rssiB
      ? { from: nodeB.id, to: nodeA.id }
      : { from: nodeA.id, to: nodeB.id };
  }

  const seenA = Number(nodeA?.last_seen || 0);
  const seenB = Number(nodeB?.last_seen || 0);
  if (seenA !== seenB) {
    return seenA > seenB
      ? { from: nodeB.id, to: nodeA.id }
      : { from: nodeA.id, to: nodeB.id };
  }

  return String(nodeA.id) < String(nodeB.id)
    ? { from: nodeB.id, to: nodeA.id }
    : { from: nodeA.id, to: nodeB.id };
}

function sanitizeRelayChain(chain, senderId, nodeIds = new Set()) {
  if (!Array.isArray(chain)) return [];
  const seen = new Set([senderId]);
  const clean = [];

  for (const item of chain) {
    const node = String(item || '').trim();
    if (!node || node === senderId) {
      console.warn(`[NETWORK] relay_chain loop detected: ${(chain || []).join('->')} (sender: ${senderId})`);
      return null;
    }
    if (seen.has(node)) {
      console.warn(`[NETWORK] relay_chain duplicate detected: ${(chain || []).join('->')} (sender: ${senderId})`);
      return null;
    }
    if (nodeIds.size && !nodeIds.has(node)) continue;
    seen.add(node);
    clean.push(node);
  }

  return clean;
}

function telemetryTimestampMs(data = {}) {
  const timestamp = Number(data.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  }
  const receivedAt = Number(data.server_received_at || data.serverReceivedAt || data.last_seen || data.lastSeen);
  return Number.isFinite(receivedAt) && receivedAt > 0 ? receivedAt * 1000 : 0;
}

function normalizeNetworkNode(vehicleId, data, vehicleMeta, offlineThresholdMs, demoMode, batteryCalibration = {}) {
  const lat = parseFloat(data.lat);
  const lng = parseFloat(data.lng);
  const gpsFix = hasValidGpsFix(data);
  const lastSeen = telemetryTimestampMs(data);
  const routeId = canonicalRouteId(data.routeId || data.route_id || vehicleMeta?.routeId || 'unassigned');
  const isDemo = isDemoVehicle(vehicleId, vehicleMeta) || String(routeId).toLowerCase().includes('demo');
  const recentlySeen = lastSeen > 0 && Date.now() - lastSeen < offlineThresholdMs;
  const isOnline = (isDemo && demoMode) || recentlySeen;
  const displayGpsFix = isOnline && gpsFix;
  const hop = isOnline && typeof data.hop === 'number' ? data.hop : null;
  const relayFrom = isOnline ? (data.relay_from || null) : null;
  const relayChain = isOnline && Array.isArray(data.relay_chain) ? data.relay_chain : [];
  const batteryCalc = calculateBatteryFromRaw(
    data.batteryRaw ?? data.a0Raw ?? data.rawA0 ?? data.a0,
    batteryCalibration
  );
  const node = {
    id: vehicleId,
    type: 'vehicle',
    vehicle_id: vehicleId,
    lat: displayGpsFix ? lat : null,
    lng: displayGpsFix ? lng : null,
    status: isOnline ? 'online' : 'offline',
    gps_fix: displayGpsFix,
    gps_status: displayGpsFix ? 'fixed' : 'no_fix',
    demo: isDemo,
    route_id: routeId,
    direction: data.direction || 'unknown',
    hop,
    last_seen: lastSeen,
    battery: batteryCalc ? batteryCalc.battery : typeof data.battery === 'number' ? data.battery : null,
    speed: typeof data.speed === 'number' ? data.speed : null,
    relay_from: relayFrom,
    relay_chain: relayChain,
    neighbors: Array.isArray(data.neighbors) ? data.neighbors : [],
    link_quality: typeof data.link_quality === 'number' ? data.link_quality : null,
    rssi: typeof data.rssi === 'number' ? data.rssi : null,
    snr: typeof data.snr === 'number' ? data.snr : null,
    gps_time: validGpsTime(Number(data.gps_time || data.gps_timestamp)) ? Number(data.gps_time || data.gps_timestamp) : null,
    ttl: typeof data.ttl === 'number' ? data.ttl : null,
    store_forward: data.store_forward === true,
    battVoltage: batteryCalc ? batteryCalc.battVoltage : typeof data.battVoltage === 'number' ? data.battVoltage : null,
    batteryRaw: batteryCalc ? batteryCalc.raw : typeof data.batteryRaw === 'number' ? data.batteryRaw : null,
    a0Voltage: batteryCalc ? batteryCalc.a0Voltage : typeof data.a0Voltage === 'number' ? data.a0Voltage : null,
    currentMa: typeof data.currentMa === 'number' ? data.currentMa : null,
    powerMw: typeof data.powerMw === 'number' ? data.powerMw : null,
    txCount: typeof data.txCount === 'number' ? data.txCount : null,
    sats: typeof data.sats === 'number' ? data.sats : null,
    hdop: typeof data.hdop === 'number' ? data.hdop : null,
    seq: typeof data.seq === 'number' ? data.seq : null,
    boot_id: data.boot_id || null,
    packet_id: data.packet_id || null,
    received_rssi: typeof data.received_rssi === 'number' ? data.received_rssi : null,
    received_snr: typeof data.received_snr === 'number' ? data.received_snr : null,
    heading: typeof data.heading === 'number' ? data.heading : typeof data.bearing === 'number' ? data.bearing : null,
    bearing: typeof data.bearing === 'number' ? data.bearing : typeof data.heading === 'number' ? data.heading : null,
    timestamp: data.timestamp || null
  };
  if (!demoMode && !displayGpsFix) {
    delete node.lat;
    delete node.lng;
  }
  return node;
}

function buildEstimatedLinks(nodes, groundStation) {
  const MAX_LINK_DISTANCE_M = 15000;
  const links = [];
  const onlineNodes = nodes.filter(n => n.status === 'online' && Number.isFinite(n.lat) && Number.isFinite(n.lng));
  if (onlineNodes.length === 0) return links;

  onlineNodes.forEach(node => {
    if (!groundStation || !Number.isFinite(groundStation.lat) || !Number.isFinite(groundStation.lng)) return;
    const distToGround = haversineDistanceMeters(node, groundStation);
    if (distToGround <= MAX_LINK_DISTANCE_M) {
      links.push({
        from: node.id,
        to: groundStation.id,
        type: 'direct',
        distance_m: Math.round(distToGround),
        hop: 0,
        status: distToGround < 5000 ? 'good' : distToGround < 10000 ? 'fair' : 'weak',
        source: 'estimated',
        rssi: null, snr: null, latency_ms: null,
        last_seen: node.last_seen
      });
    }
  });

  for (let i = 0; i < onlineNodes.length; i++) {
    for (let j = i + 1; j < onlineNodes.length; j++) {
      const a = onlineNodes[i];
      const b = onlineNodes[j];
      const dist = haversineDistanceMeters(a, b);
      if (dist > MAX_LINK_DISTANCE_M) continue;
      const direction = resolveUpstream(a, b);
      links.push({
        from: direction.from,
        to: direction.to,
        type: 'relay',
        distance_m: Math.round(dist),
        hop: Math.max(Number(a.hop || 0), Number(b.hop || 0)),
        status: dist < 3000 ? 'good' : dist < 8000 ? 'fair' : 'weak',
        source: 'estimated',
        rssi: null, snr: null, latency_ms: null,
        last_seen: Math.max(Number(a.last_seen || 0), Number(b.last_seen || 0))
      });
    }
  }

  return deduplicateLinks(links);
}

function buildRealTelemetryLinks(nodes, groundStation) {
  const links = [];
  const addedPairs = new Set();
  const nodeIds = new Set(nodes.map(node => node.id));
  const addLink = link => {
    const key = linkPairKey(link.from, link.to);
    if (!link.from || !link.to || link.from === link.to || addedPairs.has(key)) return;
    addedPairs.add(key);
    links.push(link);
  };

  nodes.forEach(node => {
    if (node.status !== 'online') return;
    const chain = sanitizeRelayChain(node.relay_chain, node.id, nodeIds);
    if (chain === null) return;
    const relayPath = chain.length ? [node.id, ...chain] : node.relay_from ? [node.id, node.relay_from] : [];

    if (relayPath.length > 1) {
      for (let i = 0; i < relayPath.length - 1; i++) {
        const from = relayPath[i];
        const to = relayPath[i + 1];
        addLink({
          from,
          to,
          type: 'relay',
          distance_m: null,
          hop: i + 1,
          status: node.link_quality >= 70 ? 'good' : node.link_quality >= 40 ? 'fair' : 'poor',
          source: 'telemetry',
          rssi: node.rssi, snr: node.snr, latency_ms: null,
          last_seen: node.last_seen
        });
      }
      const lastRelay = relayPath[relayPath.length - 1];
      addLink({
        from: lastRelay,
        to: groundStation.id,
        type: 'relay',
        distance_m: null,
        hop: node.hop || relayPath.length - 1,
        status: node.link_quality >= 70 ? 'good' : node.link_quality >= 40 ? 'fair' : 'poor',
        source: 'telemetry',
        rssi: node.rssi, snr: node.snr, latency_ms: null,
        last_seen: node.last_seen
      });
    } else if (node.relay_from) {
      const dist = Number.isFinite(node.lat) && Number.isFinite(node.lng)
        ? haversineDistanceMeters(node, groundStation)
        : null;
      addLink({
        from: node.id,
        to: node.relay_from,
        type: 'relay',
        distance_m: dist ? Math.round(dist) : null,
        hop: node.hop || 1,
        status: node.link_quality >= 70 ? 'good' : node.link_quality >= 40 ? 'fair' : 'poor',
        source: 'telemetry',
        rssi: node.rssi, snr: node.snr, latency_ms: null,
        last_seen: node.last_seen
      });
    } else if (Number(node.hop) === 0 || (Number.isFinite(node.lat) && Number.isFinite(node.lng))) {
      const hasPosition = Number.isFinite(node.lat) && Number.isFinite(node.lng);
      const distToGround = hasPosition ? haversineDistanceMeters(node, groundStation) : null;
      addLink({
        from: node.id,
        to: groundStation.id,
        type: 'direct',
        distance_m: distToGround === null ? null : Math.round(distToGround),
        hop: 0,
        status: 'good',
        source: 'telemetry',
        rssi: node.rssi, snr: node.snr, latency_ms: null,
        last_seen: node.last_seen
      });
    }
  });
  return deduplicateLinks(links);
}

function calculateMeshHealth(nodes, links) {
  const total = nodes.filter(n => n.type === 'vehicle').length;
  if (total === 0) return { score: 0, label: 'ไม่มีข้อมูล' };
  const online = nodes.filter(n => n.type === 'vehicle' && n.status === 'online').length;
  const onlineRatio = online / total;
  const hops = links.filter(l => l.hop !== null).map(l => l.hop);
  const avgHop = hops.length ? hops.reduce((a, b) => a + b, 0) / hops.length : 0;
  const hopScore = Math.max(0, 1 - avgHop / 5);
  const distances = links.filter(l => l.distance_m !== null).map(l => l.distance_m);
  const avgDist = distances.length ? distances.reduce((a, b) => a + b, 0) / distances.length : 0;
  const distScore = Math.max(0, 1 - avgDist / 20000);
  const staleRatio = nodes.filter(n => n.type === 'vehicle' && n.status === 'offline').length / Math.max(total, 1);
  const staleScore = 1 - staleRatio;
  const score = Math.round(onlineRatio * 40 + hopScore * 20 + distScore * 20 + staleScore * 20);
  const label = score >= 70 ? 'เครือข่ายพร้อมใช้งาน' : score >= 40 ? 'เครือข่ายพอใช้ได้' : 'เครือข่ายมีปัญหา';
  return { score, label };
}

// ============================================================
//  POST /api/update-location
//  ── รับข้อมูล GPS จาก ESP8266 ──
//  [FIX] รวม 2 duplicate route เป็น 1 เดียว
//
//  Body: { vehicleId, lat, lng, speed?, battery?, routeId?, direction? }
// ============================================================
app.post('/api/update-location', rateLimitMiddleware, async (req, res) => {
  res.set('Link', '</api/v1/telemetry>; rel="successor-version"');
  return res.status(410).json({ error: 'legacy_telemetry_retired', successor: '/api/v1/telemetry' });

  /* Legacy implementation retained below temporarily for source-history review.
     It is unreachable and must never accept writes. */
  legacyHeaders(res, '/api/v1/telemetry');
  logLegacy(req, req.body?.vehicleId);
  const {
    vehicleId,
    lat,
    lng,
    speed       = 0,
    battery     = -1,
    routeId     = 'unassigned',
    direction   = 'unknown',
    // ── Power fields จาก Arduino ──────────────────────
    battVoltage = -1,   // แรงดันแบต (mV) จาก ADC A0
    currentMa   = -1,   // กระแสไฟ (mA)
    powerMw     = -1,   // กำลังไฟ (mW)
    txCount     = -1,   // จำนวน packet ที่ส่งตั้งแต่ boot
    // ── GPS quality fields จาก Arduino (v6+) ─────────────
    sats        = -1,   // จำนวนดาวเทียม (จาก GPS6MV2 จริง)
    hdop        = -1,   // Horizontal Dilution of Precision (จาก GPS6MV2 จริง)
    rssi        = null, // WiFi signal strength dBm (จาก WiFi.RSSI() จริง)
    plate       = '',
  } = req.body;

  // Optional VIBE Mesh fields (backward-compatible)
  const hop = typeof req.body.hop === 'number' ? req.body.hop : null;
  const relay_from = req.body.relay_from || null;
  const relay_chain = Array.isArray(req.body.relay_chain) ? req.body.relay_chain : [];
  const neighbors = Array.isArray(req.body.neighbors) ? req.body.neighbors : [];
  const version_summary = Array.isArray(req.body.version_summary) ? req.body.version_summary : [];
  const link_quality = typeof req.body.link_quality === 'number' ? req.body.link_quality : null;
  const snr = typeof req.body.snr === 'number' ? req.body.snr : null;
  const seq = typeof req.body.seq === 'number' ? req.body.seq : null;
  const boot_id = req.body.boot_id || null;
  const packet_id = req.body.packet_id || req.body.packetId || null;
  const ttl = typeof req.body.ttl === 'number' ? req.body.ttl : null;
  const store_forward = req.body.store_forward === true;
  const source = req.body.source || 'vehicle';
  const received_rssi = typeof req.body.received_rssi === 'number' ? req.body.received_rssi : null;
  const received_snr = typeof req.body.received_snr === 'number' ? req.body.received_snr : null;
  const batteryRawInput = req.body.batteryRaw ?? req.body.a0Raw ?? req.body.rawA0 ?? req.body.a0 ?? -1;

  const plateValue = sanitizePlate(plate || req.body.license_plate || req.body.licensePlate);
  const headingValue = Number(req.body.heading ?? req.body.bearing);
  const sleepMode = req.body.sleepMode === true;
  const telemetryStatus = normalizeTelemetryStatus(req.body.status);
  const incomingRouteId = routeId && routeId !== 'unassigned' ? routeId : (req.body.route_id || 'unassigned');
  const incomingDirection = direction && direction !== 'unknown' ? direction : (req.body.route_direction || req.body.dir || 'unknown');

  if (!vehicleId) {
    return res.status(400).json({ error: 'vehicleId is required' });
  }

  if (req.body.heartbeat === true) {
    const ts = Date.now();
    const lastSeen = Math.floor(ts / 1000);
    const currentRef = db.ref(`fleet/${vehicleId}/current`);
    const previous = (await currentRef.once('value')).val() || {};
    const heartbeatRouteId = req.body.routeId || req.body.route_id || previous.routeId || previous.route_id || 'unassigned';
    const patch = {
      timestamp: ts,
      server_received_at: lastSeen,
      last_seen: lastSeen,
      status: vehicleStatus(lastSeen, lastSeen),
      vehicle_id: vehicleId,
      routeId: heartbeatRouteId,
      route_id: heartbeatRouteId,
      direction: incomingDirection !== 'unknown' ? incomingDirection : (previous.direction || 'unknown'),
      source,
      relay_via: req.body.relay_via || previous.relay_via || 'lora',
      heartbeat: true,
      gps_fix: previous.gps_fix === true,
    };
    if (received_rssi !== null) {
      patch.received_rssi = received_rssi;
      patch.rssi = received_rssi;
    }
    if (received_snr !== null) {
      patch.received_snr = received_snr;
      patch.snr = received_snr;
    }
    if (hop !== null) patch.hop = hop;
    if (plateValue) patch.plate = plateValue;
    if (telemetryStatus) patch.telemetry_status = telemetryStatus;
    if (Number.isFinite(headingValue)) {
      patch.heading = headingValue;
      patch.bearing = headingValue;
    }
    await currentRef.update(patch);
    await recordPdrPacketSafely(vehicleId, {
      ...patch,
      packet_id,
      boot_id,
      seq,
      hop,
      rssi: received_rssi ?? rssi,
      snr: received_snr,
      receivedAtMs: ts,
    });
    clearLocationsCache();
    return res.status(200).json({ message: 'Heartbeat updated', status: 'heartbeat', timestamp: ts });
  }

  const latF = parseFloat(lat);
  const lngF = parseFloat(lng);

  const hasValidGPS = validLatLng(latF, lngF);
  // ถ้า lat/lng ไม่ valid (เช่น 0,0 ตอนยังไม่ fix)
  // ยังรับ packet ได้ แต่ไม่อัปเดตพิกัด — เพื่อให้ timestamp + battery อัปเดต
  // frontend จะรู้ว่า online อยู่แต่ยังไม่มี GPS fix

  const spdF  = parseFloat(speed)  || 0;
  const ts    = Date.now();
  const lastSeen = Math.floor(ts / 1000);
  const today = todayStr();
  const hour  = getBangkokHour();

  const batteryCalibrationSnap = await db.ref('system/config/batteryCalibration').once('value');
  const batteryCalc = calculateBatteryFromRaw(batteryRawInput, batteryCalibrationSnap.val() || {});

  // Power fields
  const incomingBatI = Number(battery);
  const incomingBatVF = Number(battVoltage);
  const batI = batteryCalc ? batteryCalc.battery : (Number.isFinite(incomingBatI) ? incomingBatI : -1);
  const batVF  = batteryCalc ? batteryCalc.battVoltage : (Number.isFinite(incomingBatVF) ? incomingBatVF : -1);
  const currF  = parseFloat(currentMa)   || -1;
  const powF   = parseFloat(powerMw)     || (currF > 0 && batVF > 0 ? parseFloat((currF * batVF / 1000).toFixed(0)) : -1);
  const txI    = parseInt(txCount,   10) || -1;
  const satsParsed = parseInt(sats, 10);
  const satsI  = Number.isFinite(satsParsed) ? satsParsed : -1;  // จำนวนดาวเทียมจริง
  const hdopF  = parseFloat(hdop)        || -1;  // HDOP จริง
  const rssiI  = rssi !== null ? parseInt(rssi, 10) : null; // RSSI dBm จริง
  const gpsTimeRaw = Number(req.body.gps_timestamp ?? req.body.gps_time);
  const gpsTime = validGpsTime(gpsTimeRaw, lastSeen) ? gpsTimeRaw : null;
  const gpsFix = req.body.gps_fix === false ? false : hasValidGPS;

  const data = {
    // ถ้าไม่มี GPS fix ยังคง lat/lng เดิมใน Firebase (ไม่ส่ง 0,0 ทับ)
    ...(hasValidGPS ? { lat: latF, lng: lngF } : {}),
    speed:       hasValidGPS ? parseFloat(spdF.toFixed(1)) : 0,
    battery:     batI,
    battVoltage: batVF,    // mV
    ...(batteryCalc ? { batteryRaw: batteryCalc.raw, a0Voltage: batteryCalc.a0Voltage } : {}),
    currentMa:   currF,    // mA
    powerMw:     powF,     // mW
    txCount:     txI,
    sats:        satsI,   // จำนวนดาวเทียมจริงจาก GPS
    hdop:        hdopF,   // HDOP จริงจาก GPS
    rssi:        rssiI,   // WiFi RSSI dBm จริง
    timestamp:   ts,
    server_received_at: lastSeen,
    last_seen:   lastSeen,
    status:      vehicleStatus(lastSeen, lastSeen),
    gps_time:    gpsTime,
    gps_timestamp: gpsTime,
    gps_fix:     gpsFix,
    routeId:     incomingRouteId,
    route_id:    incomingRouteId,
    direction:   incomingDirection,
  };
  if (Number.isFinite(headingValue)) {
    data.heading = headingValue;
    data.bearing = headingValue;
  }
  if (plateValue) data.plate = plateValue;
  if (sleepMode) data.sleepMode = true;
  if (telemetryStatus) data.telemetry_status = telemetryStatus;

  // Preserve existing telemetry payloads by storing mesh fields only when supplied.
  if (hop !== null) data.hop = hop;
  if (relay_from) data.relay_from = relay_from;
  if (relay_chain.length > 0) data.relay_chain = relay_chain;
  if (neighbors.length > 0) data.neighbors = neighbors;
  if (link_quality !== null) data.link_quality = link_quality;
  if (snr !== null) data.snr = snr;
  if (seq !== null) data.seq = seq;
  if (boot_id) data.boot_id = boot_id;
  if (packet_id) data.packet_id = packet_id;
  if (ttl !== null) data.ttl = ttl;
  if (store_forward) data.store_forward = true;
  if (source) data.source = source;
  if (received_rssi !== null) data.received_rssi = received_rssi;
  if (received_snr !== null) data.received_snr = received_snr;
  if (version_summary.length > 0) data.version_summary = version_summary;

  try {
    if (packet_id) {
      const dedupRef = db.ref(`dedup/${firebaseKeyPart(vehicleId)}/${firebaseKeyPart(packet_id)}`);
      const dedupResult = await dedupRef.transaction(current => (
        current || {
          packet_id,
          processedAt: ts,
          date: today,
        }
      ));
      if (!dedupResult.committed) {
        return res.status(200).json({
          status: 'duplicate',
          message: 'Packet already processed.',
          packet_id,
          timestamp: ts,
        });
      }
    }

    if (boot_id && seq !== null) {
      const previous = (await db.ref(`fleet/${vehicleId}/current`).once('value')).val();
      const decision = telemetryDecision(previous, { boot_id, seq, gps_time: gpsTime, gps_fix: gpsFix });
      if (!decision.accepted) {
        if (!hasValidGPS) {
          await db.ref(`fleet/${vehicleId}/current`).update({
            timestamp: ts,
            server_received_at: lastSeen,
            last_seen: lastSeen,
            status: vehicleStatus(lastSeen, lastSeen),
            gps_fix: false,
            routeId: incomingRouteId || previous?.routeId || 'unassigned',
            route_id: incomingRouteId || previous?.route_id || previous?.routeId || 'unassigned',
            direction: incomingDirection !== 'unknown' ? incomingDirection : (previous?.direction || 'unknown'),
            battery: batI,
            battVoltage: batVF,
            ...(batteryCalc ? { batteryRaw: batteryCalc.raw, a0Voltage: batteryCalc.a0Voltage } : {}),
            speed: 0,
            ...(plateValue ? { plate: plateValue } : {}),
            ...(Number.isFinite(headingValue) ? { heading: headingValue, bearing: headingValue } : {}),
            ...(hop !== null ? { hop } : {}),
            ...(link_quality !== null ? { link_quality } : {}),
            ...(rssiI !== null ? { rssi: rssiI } : {}),
            ...(snr !== null ? { snr } : {}),
            ...(telemetryStatus ? { telemetry_status: telemetryStatus } : {}),
            last_ignored_reason: decision.reason,
          });
          return res.status(200).json({ message: 'Telemetry heartbeat updated', status: 'heartbeat', reason: decision.reason, timestamp: ts });
        }
        return res.status(200).json({ message: 'Telemetry ignored', status: 'ignored', reason: decision.reason, timestamp: ts });
      }
    }

    const updates = {};

    // 1. Live current position (overwrite)
    updates[`fleet/${vehicleId}/current`] = data;

    // 2. History แยกตามวัน — เก็บเฉพาะเมื่อมี GPS fix จริง
    if (hasValidGPS) updates[`history/${today}/${vehicleId}/${ts}`] = data;

    // 3. Routes active
    if (hasValidGPS && incomingRouteId && incomingRouteId !== 'unassigned') {
      updates[`routes_active/${today}/${incomingRouteId}/${vehicleId}`] = {
        lastActive: ts, lat: latF, lng: lngF,
      };
    }

    // 4. Peak-hours counter (atomic increment)
    updates[`analytics/peak_hours/${today}/${vehicleId}/${hour}`] =
      admin.database.ServerValue.increment(1);

    await db.ref().update(updates);
    await recordPdrPacketSafely(vehicleId, {
      ...data,
      receivedAtMs: ts,
    });
    clearLocationsCache();

    const gpsStatus = hasValidGPS ? `${latF},${lngF}` : 'no-fix';
  console.log(`[GPS] ${vehicleId} | ${gpsStatus} | ${spdF}km/h | bat:${batI}% | ${batVF}mV | raw:${batteryCalc?.raw ?? '-'} | ${currF}mA | sats:${satsI} | hdop:${hdopF} | rssi:${rssiI} | ${incomingDirection}`);

    return res.status(200).json({ message: 'Location & Route updated successfully', timestamp: ts });

  } catch (err) {
    console.error('[POST /api/update-location]', err);
    return res.status(500).json({ error: 'Database error', details: err.message });
  }
});

// ============================================================
//  GET /api/locations
//  [FIX] Endpoint ที่ frontend (app.js, admin.js) เรียกใช้จริง
//  ── ดึงตำแหน่งปัจจุบันของรถทุกคัน พร้อม history structure ──
//  Query: ?routeId=xxx (optional) - filter by route
//  Response: { "ST-01": { current: {...} }, "ST-02": { current: {...} } }
// ============================================================
app.get('/api/locations', async (req, res) => {
  legacyHeaders(res, '/api/v1/vehicles');
  logLegacy(req);
  try {
    const { routeId } = req.query;
    const cacheKey = `locations:${routeId || 'all'}`;
    if (locationsCache.key === cacheKey && locationsCache.expiresAt > Date.now()) {
      res.set('X-Cache', 'HIT');
      return res.status(200).json(locationsCache.payload);
    }

    await ensureDemoFleetRunning('locations');
    const [fleetSnap, demoMode] = await Promise.all([db.ref('fleet').once('value'), getDemoMode()]);
    const raw = fleetSnap.val() || {};

    const result = [];
    for (const [id, val] of Object.entries(raw)) {
      // TWIN_ / DEMO_ เสมอส่ง — ไม่ต้อง filter ด้วย routeId
      if (!demoMode && isDemoVehicle(id, val)) continue;
      if (demoMode && isDemoVehicle(id, val)) console.log(`[demo] including demo vehicle ${id}`);
      const entryRouteId = val.routeId || val.current?.routeId || val.current?.route_id || 'unassigned';
      if (routeId && canonicalRouteId(entryRouteId) !== canonicalRouteId(routeId) && !isDemoVehicle(id, val)) continue;
      if (val?.current) {
        const current = currentForFleetResponse(id, val, demoMode);
        result.push({
          vehicleId: id,
          vehicle_id: id,
          ...current,
          current,
          routeId: entryRouteId,
          route_id: current.route_id || entryRouteId,
          type: val.type,
          plate: sanitizePlate(val.plate || val.current?.plate) || '',
          description: val.description || '',
        });
      }
    }

    locationsCache = {
      key: cacheKey,
      expiresAt: Date.now() + LOCATIONS_CACHE_MS,
      payload: result,
    };
    res.set('X-Cache', 'MISS');
    return res.status(200).json(result);
  } catch (err) {
    console.error('[GET /api/locations]', err);
    return res.status(500).json({ error: 'Failed to fetch locations' });
  }
});

// ============================================================
// API v1 — Passenger data contract
// ============================================================
app.get('/api/v1/vehicles', async (req, res) => {
  try {
    const routeId = req.query.route_id ? canonicalRouteId(req.query.route_id) : null;
    const now = unixNow();
    await ensureDemoFleetRunning('v1_vehicles');
    const [fleetSnap, demoMode] = await Promise.all([db.ref('fleet').once('value'), getDemoMode()]);
    const fleet = fleetSnap.val() || {};
    const vehicles = Object.entries(fleet)
      .filter(([, entry]) => entry?.current)
      .filter(([id, entry]) => demoMode || !isDemoVehicle(id, entry))
      .map(([id, entry]) => normalizeVehicle(id, entry, now))
      .filter(vehicle => !routeId || vehicle.route_id === routeId)
      .filter(vehicle => validLatLng(vehicle.lat, vehicle.lng));
    return res.json({ server_time: now, vehicles });
  } catch (error) {
    console.error('[GET /api/v1/vehicles]', error);
    return res.status(500).json({ error: 'Failed to fetch vehicles' });
  }
});

app.get('/api/v1/routes', async (_req, res) => {
  try {
    const raw = (await db.ref('routes').once('value')).val() || {};
    const routesById = new Map();
    for (const [legacyId, route] of Object.entries(raw)) {
      const routeId = canonicalRouteId(route.route_id || route.routeId || legacyId);
      if (routesById.has(routeId)) continue;
      const places = Array.isArray(route.places) && route.places.length
        ? route.places
        : (route.stops || []).map((place, index) => ({
          place_id: place.place_id || `${routeId}-PLACE-${index + 1}`,
          name: place.name,
          lat: place.lat,
          lng: place.lng,
        }));
      routesById.set(routeId, {
        route_id: routeId,
        name: route.name || routeId,
        color: route.color || '#1E88E5',
        coords: route.coords || [],
        places,
      });
    }
    return res.json({ routes: [...routesById.values()] });
  } catch (error) {
    console.error('[GET /api/v1/routes]', error);
    return res.status(500).json({ error: 'Failed to fetch routes' });
  }
});

app.get('/api/v1/eta', async (req, res) => {
  const vehicleId = String(req.query.vehicle_id || '');
  const [latRaw, lngRaw] = String(req.query.destination || '').split(',');
  const destination = { lat: Number(latRaw), lng: Number(lngRaw) };
  if (!vehicleId || !validLatLng(destination.lat, destination.lng)) {
    return res.status(400).json({ error: 'vehicle_id and a valid destination=lat,lng are required' });
  }

  try {
    const [fleetSnap, demoMode] = await Promise.all([db.ref(`fleet/${vehicleId}`).once('value'), getDemoMode()]);
    const fleetEntry = fleetSnap.val();
    if (!fleetEntry?.current) return res.status(404).json({ error: 'Vehicle not found' });
    if (!demoMode && isDemoVehicle(vehicleId, fleetEntry)) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }
    const vehicle = normalizeVehicle(vehicleId, fleetEntry);
    if (vehicle.status === 'offline' || !vehicle.gps_fix || !validLatLng(vehicle.lat, vehicle.lng)) {
      return res.json({ vehicle_id: vehicleId, eta_min: null, distance_m: null, cached: false });
    }

    const routes = (await db.ref('routes').once('value')).val() || {};
    const route = Object.entries(routes).find(([id, value]) => canonicalRouteId(value.route_id || value.routeId || id) === vehicle.route_id)?.[1];
    if (!route || !isWithinRouteCorridor(destination.lat, destination.lng, route.coords)) {
      return res.status(400).json({ error: 'Destination is outside this vehicle service area' });
    }

    const cacheKey = `${vehicleId}:${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}`;
    const cached = etaCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < ETA_CACHE_MS) {
      return res.json({ ...cached.value, cached: true });
    }

    const session = String(req.get('x-client-session') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    const sessionRetry = consumeRateLimit(`eta:session:${session || req.ip}`, ETA_SESSION_LIMIT);
    const ipRetry = consumeRateLimit(`eta:ip:${req.ip}`, ETA_IP_LIMIT);
    const retryAfter = Math.max(sessionRetry, ipRetry);
    if (retryAfter) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too Many Requests', retry_after: retryAfter });
    }

    const apiKey = process.env.GOOGLE_ROUTES_API_KEY || GMAPS_KEY;
    if (!apiKey) return res.json({ vehicle_id: vehicleId, eta_min: null, distance_m: null, cached: false });
    const mapsResponse = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: vehicle.lat, longitude: vehicle.lng } } },
        destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
      }),
    });
    if (!mapsResponse.ok) throw new Error(`Routes API ${mapsResponse.status}`);
    const mapsData = await mapsResponse.json();
    const routeResult = mapsData.routes?.[0];
    const seconds = Number(String(routeResult?.duration || '').replace('s', ''));
    const value = {
      vehicle_id: vehicleId,
      eta_min: Number.isFinite(seconds) ? Math.max(1, Math.round(seconds / 60)) : null,
      distance_m: Number.isFinite(Number(routeResult?.distanceMeters)) ? Number(routeResult.distanceMeters) : null,
      cached: false,
    };
    etaCache.set(cacheKey, { createdAt: Date.now(), value });
    return res.json(value);
  } catch (error) {
    console.error('[GET /api/v1/eta]', error.message);
    return res.json({ vehicle_id: vehicleId, eta_min: null, distance_m: null, cached: false });
  }
});

async function ingestGroundTelemetryPacket(data, batteryCalibration, receivedAt) {
  const vehicleId = String(data.vehicleId || data.vehicle_id || '');
  const bootId = String(data.boot_id || '');
  const seq = Number(data.seq);
  const packetId = String(data.packet_id || data.packetId || '');
  if (!/^BUS_0[1-3]$/.test(vehicleId) || !bootId || !Number.isInteger(seq) || seq < 0 || !packetId) {
    return { packet_id: packetId || null, vehicle_id: vehicleId || null, status: 'rejected', reason: 'invalid_identity' };
  }

  const currentRef = db.ref(`fleet/${vehicleId}/current`);
  const previous = (await currentRef.once('value')).val() || null;
  const gpsTimeValue = Number(data.gps_time ?? data.gps_timestamp);
  const gpsTime = validGpsTime(gpsTimeValue, receivedAt) ? gpsTimeValue : null;
  const lat = Number(data.lat);
  const lng = Number(data.lng);
  const gpsFix = data.gps_fix === true && validLatLng(lat, lng);
  const decision = telemetryDecision(previous, { boot_id: bootId, seq, gps_time: gpsTime, gps_fix: gpsFix });
  if (!decision.accepted) {
    return { packet_id: packetId, vehicle_id: vehicleId, status: 'duplicate', reason: decision.reason };
  }

  const batteryCalc = calculateBatteryFromRaw(
    data.batteryRaw ?? data.a0Raw ?? data.rawA0 ?? data.a0,
    batteryCalibration
  );
  const routeId = canonicalRouteId(data.routeId || data.route_id || previous?.routeId || previous?.route_id || 'unassigned');
  const heading = Number(data.heading ?? data.bearing ?? previous?.heading ?? 0);
  const current = {
    ...(previous || {}),
    vehicle_id: vehicleId,
    ...(gpsFix ? { lat, lng, heading, bearing: heading, speed: Number(data.speed || 0) } : {}),
    ...(batteryCalc ? {
      batteryRaw: batteryCalc.raw,
      a0Voltage: batteryCalc.a0Voltage,
      battVoltage: batteryCalc.battVoltage,
      battery: batteryCalc.battery,
    } : {}),
    gps_time: gpsTime,
    gps_timestamp: gpsTime,
    server_received_at: receivedAt,
    last_seen: receivedAt,
    timestamp: receivedAt * 1000,
    status: vehicleStatus(receivedAt, receivedAt),
    gps_fix: gpsFix,
    boot_id: bootId,
    seq,
    packet_id: packetId,
    route_id: routeId,
    routeId,
    direction: data.direction || previous?.direction || 'unknown',
    hop: Number.isFinite(Number(data.hop)) ? Number(data.hop) : 0,
    ttl: Number.isFinite(Number(data.ttl)) ? Number(data.ttl) : null,
    source: 'ground_station',
    relay_via: 'lora',
    relay_from: data.relay_from || null,
    relay_chain: Array.isArray(data.relay_chain) ? data.relay_chain : [],
    neighbors: Array.isArray(data.neighbors) ? data.neighbors : [],
    store_forward: data.store_forward === true,
    rssi: Number.isFinite(Number(data.received_rssi ?? data.rssi)) ? Number(data.received_rssi ?? data.rssi) : null,
    snr: Number.isFinite(Number(data.received_snr ?? data.snr)) ? Number(data.received_snr ?? data.snr) : null,
    received_rssi: Number.isFinite(Number(data.received_rssi)) ? Number(data.received_rssi) : null,
    received_snr: Number.isFinite(Number(data.received_snr)) ? Number(data.received_snr) : null,
  };

  const updates = {
    [`fleet/${vehicleId}/current`]: current,
    [`fleet/${vehicleId}/routeId`]: routeId,
    [`dedup/${firebaseKeyPart(vehicleId)}/${firebaseKeyPart(packetId)}`]: {
      packet_id: packetId,
      seq,
      boot_id: bootId,
      receivedAt: receivedAt * 1000,
    },
  };
  if (gpsFix) {
    const historyKey = `${receivedAt * 1000}_${firebaseKeyPart(bootId)}_${seq}`;
    updates[`history/${todayStr()}/${vehicleId}/${historyKey}`] = current;
    updates[`routes_active/${todayStr()}/${routeId}/${vehicleId}`] = { lastActive: receivedAt * 1000, lat, lng };
    updates[`analytics/peak_hours/${todayStr()}/${vehicleId}/${getBangkokHour()}`] = admin.database.ServerValue.increment(1);
  }
  await db.ref().update(updates);
  await recordPdrPacketSafely(vehicleId, {
    ...current,
    packet_id: packetId,
    receivedAtMs: receivedAt * 1000,
  });
  return { packet_id: packetId, vehicle_id: vehicleId, status: 'accepted' };
}

app.post('/api/v1/ground/telemetry-batch', rateLimitMiddleware, async (req, res) => {
  const groundId = String(req.body?.ground_id || '');
  const packets = Array.isArray(req.body?.packets) ? req.body.packets : [];
  if (!groundId || packets.length < 1 || packets.length > 6) {
    return res.status(400).json({ error: 'ground_id and 1..6 packets are required' });
  }
  try {
    if (!await verifyGroundKey(groundId, req.get('X-Ground-Key'))) {
      return res.status(403).json({ error: 'Ground key is not authorized for this ground_id' });
    }
    const calibrationSnap = await db.ref('system/config/batteryCalibration').once('value');
    const calibration = calibrationSnap.val() || {};
    const receivedAt = unixNow();
    const seen = new Set();
    const results = new Array(packets.length);
    const groups = new Map();
    packets.forEach((packet, index) => {
      const packetId = String(packet?.packet_id || packet?.packetId || '');
      if (packetId && seen.has(packetId)) {
        results[index] = { packet_id: packetId, vehicle_id: packet?.vehicleId || packet?.vehicle_id || null, status: 'duplicate', reason: 'duplicate_batch' };
        return;
      }
      if (packetId) seen.add(packetId);
      const vehicleId = String(packet?.vehicleId || packet?.vehicle_id || `invalid_${index}`);
      if (!groups.has(vehicleId)) groups.set(vehicleId, []);
      groups.get(vehicleId).push({ packet: packet || {}, index });
    });
    await Promise.all([...groups.values()].map(async entries => {
      for (const entry of entries) {
        results[entry.index] = await ingestGroundTelemetryPacket(entry.packet, calibration, receivedAt);
      }
    }));
    const counts = results.reduce((out, result) => {
      out[result.status] = (out[result.status] || 0) + 1;
      return out;
    }, { accepted: 0, duplicate: 0, rejected: 0 });
    clearLocationsCache();
    return res.json({ ok: true, ground_id: groundId, ...counts, results, server_received_at: receivedAt });
  } catch (error) {
    console.error('[POST /api/v1/ground/telemetry-batch]', error);
    return res.status(500).json({ error: 'Failed to ingest ground telemetry batch' });
  }
});

app.post('/api/v1/telemetry', rateLimitMiddleware, async (req, res) => {
  const vehicleId = String(req.body.vehicle_id || '');
  const bootId = String(req.body.boot_id || '');
  const seq = Number(req.body.seq);
  if (!vehicleId || !bootId || !Number.isInteger(seq) || seq < 0) {
    return res.status(400).json({ error: 'vehicle_id, boot_id, and non-negative integer seq are required' });
  }
  try {
    if (!await verifyVehicleKey(vehicleId, req.get('X-Vehicle-Key'))) {
      return res.status(403).json({ error: 'Vehicle key is not authorized for this vehicle_id' });
    }
    const receivedAt = unixNow();
    const gpsTime = Number(req.body.gps_time);
    const gpsFix = req.body.gps_fix === true;
    const telemetryStatus = normalizeTelemetryStatus(req.body.status);
    const lat = Number(req.body.lat), lng = Number(req.body.lng);
    const hasCoordinates = gpsFix && validLatLng(lat, lng);
    const currentRef = db.ref(`fleet/${vehicleId}/current`);
    const previous = (await currentRef.once('value')).val();
    const packet = { boot_id: bootId, seq, gps_time: validGpsTime(gpsTime, receivedAt) ? gpsTime : null, gps_fix: gpsFix };
    const decision = telemetryDecision(previous, packet);
    if (!decision.accepted) {
      if (!hasCoordinates) {
        await currentRef.update({
          timestamp: receivedAt * 1000,
          server_received_at: receivedAt,
          last_seen: receivedAt,
          status: vehicleStatus(receivedAt, receivedAt),
          gps_fix: gpsFix,
          route_id: previous?.route_id || previous?.routeId || 'unassigned',
          routeId: previous?.routeId || previous?.route_id || 'unassigned',
          direction: req.body.direction || previous?.direction || 'unknown',
          battery: req.body.battery ?? previous?.battery ?? -1,
          speed: previous?.speed ?? 0,
          ...(telemetryStatus ? { telemetry_status: telemetryStatus } : {}),
          last_ignored_reason: decision.reason,
        });
        return res.json({ ok: true, status: 'heartbeat', reason: decision.reason, server_received_at: receivedAt, last_seen: receivedAt });
      }
      return res.json({ ok: true, status: 'ignored', reason: decision.reason });
    }

    const routeId = canonicalRouteId(req.body.route_id || 'unassigned');
    const heading = Number(req.body.heading ?? req.body.bearing ?? previous?.heading ?? 0);
    const current = {
      ...(previous || {}),
      vehicle_id: vehicleId,
      ...(hasCoordinates ? { lat, lng, heading, bearing: heading } : {}),
      ...(hasCoordinates ? { speed: Number(req.body.speed || 0) } : {}),
      battery: req.body.battery ?? previous?.battery ?? -1,
      gps_time: packet.gps_time,
      server_received_at: receivedAt,
      last_seen: receivedAt,
      status: vehicleStatus(receivedAt, receivedAt),
      gps_fix: gpsFix,
      boot_id: bootId,
      seq,
      route_id: routeId,
      routeId,
      direction: req.body.direction || previous?.direction || 'unknown',
      hop: Number.isFinite(Number(req.body.hop)) ? Number(req.body.hop) : 0,
      source: req.body.source || 'vehicle',
      timestamp: receivedAt * 1000,
      battVoltage: req.body.battVoltage ?? previous?.battVoltage ?? -1,
      currentMa: req.body.currentMa ?? previous?.currentMa ?? -1,
      powerMw: req.body.powerMw ?? previous?.powerMw ?? -1,
      txCount: req.body.txCount ?? previous?.txCount ?? -1,
      sats: req.body.sats ?? previous?.sats ?? -1,
      hdop: req.body.hdop ?? previous?.hdop ?? -1,
      rssi: req.body.rssi ?? previous?.rssi ?? null,
      ...(telemetryStatus ? { telemetry_status: telemetryStatus } : {}),
    };
    const updates = { [`fleet/${vehicleId}/current`]: current, [`fleet/${vehicleId}/routeId`]: routeId };
    if (hasCoordinates) {
      const historyKey = Date.now();
      updates[`history/${todayStr()}/${vehicleId}/${historyKey}`] = current;
      updates[`routes_active/${todayStr()}/${routeId}/${vehicleId}`] = { lastActive: receivedAt * 1000, lat, lng };
      updates[`analytics/peak_hours/${todayStr()}/${vehicleId}/${getBangkokHour()}`] = admin.database.ServerValue.increment(1);
    }
    await db.ref().update(updates);
    await recordPdrPacketSafely(vehicleId, {
      ...current,
      packet_id: req.body.packet_id || req.body.packetId || null,
      boot_id: bootId,
      seq,
      snr: req.body.snr ?? req.body.received_snr ?? null,
      receivedAtMs: receivedAt * 1000,
    });
    return res.json({ ok: true, status: 'accepted', server_received_at: receivedAt, last_seen: receivedAt });
  } catch (error) {
    console.error('[POST /api/v1/telemetry]', error);
    return res.status(500).json({ error: 'Failed to ingest telemetry' });
  }
});

// Admin-only provisioning endpoint. The clear-text key is never persisted.
app.post('/api/v1/admin/vehicle-keys/:vehicleId', authMiddleware, async (req, res) => {
  const key = String(req.body.key || '');
  if (key.length < 24) return res.status(400).json({ error: 'Vehicle key must be at least 24 characters' });
  const vehicleId = req.params.vehicleId;
  await db.ref(`system/device_credentials/${vehicleId}`).set({ keyHash: bcrypt.hashSync(key, 12), updatedAt: Date.now() });
  return res.json({ ok: true, vehicle_id: vehicleId });
});

app.post('/api/v1/admin/ground-keys/:groundId', authMiddleware, async (req, res) => {
  const key = String(req.body.key || '');
  if (key.length < 24) return res.status(400).json({ error: 'Ground key must be at least 24 characters' });
  const groundId = firebaseKeyPart(req.params.groundId);
  if (!/^GROUND_\d{2}$/.test(groundId)) return res.status(400).json({ error: 'Ground id must match GROUND_01 format' });
  await db.ref(`system/ground_credentials/${groundId}`).set({ keyHash: bcrypt.hashSync(key, 12), updatedAt: Date.now() });
  return res.json({ ok: true, ground_id: groundId });
});

// ============================================================
//  GET /api/analytics/today
//  ── raw history ของวันนี้ (เหมือนโค้ดเดิม) ──
// ============================================================
app.get('/api/analytics/today', async (req, res) => {
  const today = todayStr();
  try {
    const snap = await db.ref(`history/${today}`).once('value');
    return res.status(200).json(snap.val() || {});
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ============================================================
//  GET /api/analytics/speed-by-hour
//  ── ค่าเฉลี่ยความเร็วแยกตามชั่วโมง สำหรับ Admin Chart ──
//  Query: ?date=YYYY-MM-DD
//  Response: { labels: ["00:00",...], data: [45, 30, ...] }
// ============================================================
app.get('/api/analytics/speed-by-hour', async (req, res) => {
  const date = req.query.date || todayStr();
  try {
    const snap    = await db.ref(`history/${date}`).once('value');
    const histRaw = snap.val() || {};

    // ตาราง { hour: [speed, speed, ...] }
    const speedsByHour = {};
    for (let h = 0; h < 24; h++) speedsByHour[h] = [];

    for (const vehicleHistory of Object.values(histRaw)) {
      for (const rec of Object.values(vehicleHistory)) {
        if (rec?.timestamp && typeof rec.speed === 'number') {
          const h = getBangkokHour(new Date(rec.timestamp));
          speedsByHour[h].push(rec.speed);
        }
      }
    }

    // คำนวณ average
    const labels = [];
    const data   = [];
    for (let h = 0; h < 24; h++) {
      const arr = speedsByHour[h];
      labels.push(`${String(h).padStart(2,'0')}:00`);
      data.push(arr.length > 0 ? Math.round(arr.reduce((a,b) => a+b, 0) / arr.length) : 0);
    }

    return res.status(200).json({ labels, data });
  } catch (err) {
    console.error('[GET /api/analytics/speed-by-hour]', err);
    return res.status(500).json({ error: 'Failed to compute speed analytics' });
  }
});

// ============================================================
//  GET /api/analytics/peak-hours
//  ── นับจำนวน GPS events ต่อชั่วโมง สำหรับ peak chart ──
// ============================================================
app.get('/api/analytics/peak-hours', async (req, res) => {
  const date = req.query.date || todayStr();
  try {
    const snap = await db.ref(`analytics/peak_hours/${date}`).once('value');
    const raw  = snap.val() || {};

    const totals = {};
    for (let h = 0; h < 24; h++) totals[h] = 0;

    for (const vehicleHours of Object.values(raw)) {
      for (const [hour, count] of Object.entries(vehicleHours)) {
        totals[parseInt(hour, 10)] += count;
      }
    }

    // Fallback: คำนวณจาก history ถ้า analytics ยังว่าง
    if (Object.values(totals).reduce((a,b) => a+b, 0) === 0) {
      const histSnap = await db.ref(`history/${date}`).once('value');
      const histRaw  = histSnap.val() || {};
      for (const vhist of Object.values(histRaw)) {
        for (const rec of Object.values(vhist)) {
          if (rec?.timestamp) totals[getBangkokHour(new Date(rec.timestamp))]++;
        }
      }
    }

    return res.status(200).json(totals);
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute peak hours' });
  }
});

// ============================================================
//  GOOGLE MAPS PROXY APIs — ซ่อน API Key + Memory Cache 5 นาที
// ============================================================
app.get('/api/history/vehicles', authMiddleware, async (req, res) => {
  const date = normalizeHistoryDate(req.query.date);
  try {
    const snap = await db.ref(`history/${date}`).once('value');
    const raw = snap.val() || {};
    const vehicles = [];
    let totalRecords = 0;
    for (const [vehicleId, history] of Object.entries(raw)) {
      const count = Object.keys(history || {}).length;
      if (count > 0) {
        vehicles.push(vehicleId);
        totalRecords += count;
      }
    }
    vehicles.sort((a, b) => a.localeCompare(b));
    return res.json({ date, vehicles, totalRecords });
  } catch (error) {
    console.error('[GET /api/history/vehicles]', error);
    return res.status(500).json({ error: 'Failed to fetch history vehicles' });
  }
});

app.get('/api/history/trail', authMiddleware, async (req, res) => {
  const vehicleId = sanitizeHistoryVehicleId(req.query.vehicleId || req.query.vehicle_id);
  const date = normalizeHistoryDate(req.query.date);
  if (!vehicleId) return res.status(400).json({ error: 'vehicleId is required' });
  try {
    const snap = await db.ref(`history/${date}/${vehicleId}`).once('value');
    const points = historyPointsFromVehicle(vehicleId, snap.val() || {}, {
      from: req.query.from,
      to: req.query.to,
    });
    const requestedLimit = Number(req.query.limit || 500);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 2000) : 500;
    const cursor = String(req.query.cursor || '');
    const startAt = cursor ? points.findIndex(point => String(point.timestamp || point.server_received_at || '') > cursor) : 0;
    const page = points.slice(Math.max(startAt, 0), Math.max(startAt, 0) + limit);
    const next = startAt + limit < points.length ? page[page.length - 1] : null;
    return res.json({
      vehicleId,
      date,
      points: page.map(({ vehicleId: _vehicleId, gps_fix, routeId, source, ...point }) => point),
      summary: summarizeHistoryPoints(points),
      nextCursor: next ? String(next.timestamp || next.server_received_at || '') : null,
    });
  } catch (error) {
    console.error('[GET /api/history/trail]', error);
    return res.status(500).json({ error: 'Failed to fetch vehicle history trail' });
  }
});

app.get('/api/history/analytics', authMiddleware, async (req, res) => {
  const date = normalizeHistoryDate(req.query.date);
  const vehicleId = sanitizeHistoryVehicleId(req.query.vehicleId || req.query.vehicle_id);
  try {
    const [historySnap, peakSnap] = await Promise.all([
      vehicleId ? db.ref(`history/${date}/${vehicleId}`).once('value') : db.ref(`history/${date}`).once('value'),
      db.ref(`analytics/peak_hours/${date}`).once('value'),
    ]);
    const peakRaw = peakSnap.val() || {};
    const historyRaw = vehicleId ? { [vehicleId]: historySnap.val() || {} } : historySnap.val() || {};
    const vehicles = Object.entries(historyRaw)
      .map(([id, history]) => {
        const points = historyPointsFromVehicle(id, history || {});
        const summary = summarizeHistoryPoints(points);
        return {
          vehicleId: id,
          avgSpeed: summary.avgSpeed,
          maxSpeed: summary.maxSpeed,
          totalDistanceKm: summary.distanceKm,
          activeHours: summary.activeHours,
          batteryStart: summary.batteryStart,
          batteryEnd: summary.batteryEnd,
          totalPoints: summary.totalPoints,
          onlineRatio: summary.onlineRatio,
          peakHours: topHistoryHours(points, peakRaw[id]),
        };
      })
      .filter(item => item.totalPoints > 0 || vehicleId);

    const totalPoints = vehicles.reduce((sum, item) => sum + item.totalPoints, 0);
    const weightedSpeed = vehicles.reduce((sum, item) => sum + item.avgSpeed * item.totalPoints, 0);
    const weightedOnline = vehicles.reduce((sum, item) => sum + item.onlineRatio * item.totalPoints, 0);
    return res.json({
      date,
      vehicles,
      fleet: {
        avgSpeed: totalPoints ? Number((weightedSpeed / totalPoints).toFixed(1)) : 0,
        totalDistanceKm: Number(vehicles.reduce((sum, item) => sum + item.totalDistanceKm, 0).toFixed(2)),
        onlineRatio: totalPoints ? Number((weightedOnline / totalPoints).toFixed(2)) : 0,
      },
    });
  } catch (error) {
    console.error('[GET /api/history/analytics]', error);
    return res.status(500).json({ error: 'Failed to fetch history analytics' });
  }
});

app.get('/api/history/dates', authMiddleware, async (req, res) => {
  const vehicleId = sanitizeHistoryVehicleId(req.query.vehicleId || req.query.vehicle_id);
  try {
    const snap = await db.ref('history').once('value');
    const raw = snap.val() || {};
    const dates = Object.entries(raw)
      .filter(([, byVehicle]) => !vehicleId || byVehicle?.[vehicleId])
      .map(([date]) => date)
      .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))
      .sort((a, b) => b.localeCompare(a));
    return res.json({ dates, ...(vehicleId ? { vehicleId } : {}) });
  } catch (error) {
    console.error('[GET /api/history/dates]', error);
    return res.status(500).json({ error: 'Failed to fetch history dates' });
  }
});

const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const _mapsCache = new Map(); // key → { data, ts }
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function getCached(key) {
  const c = _mapsCache.get(key);
  if (c && (Date.now() - c.ts) < CACHE_TTL) return c.data;
  _mapsCache.delete(key);
  return null;
}

// GET /api/maps/key — ส่ง API Key ไป frontend (ใช้โหลด Google Maps JS)
app.get('/api/maps/key', (req, res) => {
  res.json({ key: GMAPS_KEY || '' });
});

// GET /api/maps/directions?origin=lat,lng&destination=lat,lng
app.get('/api/maps/directions', async (req, res) => {
  const { origin, destination } = req.query;
  if (!origin || !destination) return res.status(400).json({ error: 'origin & destination required' });
  if (!GMAPS_KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not set' });

  const cacheKey = `dir:${origin}:${destination}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&mode=driving&language=th&key=${GMAPS_KEY}`;
    const r = await fetch(url).then(r => r.json());
    _mapsCache.set(cacheKey, { data: r, ts: Date.now() });
    res.json(r);
  } catch (e) {
    console.error('[MAPS/directions]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/maps/eta?origin=lat,lng&destination=lat,lng — Traffic-aware ETA
app.get('/api/maps/eta', async (req, res) => {
  const { origin, destination } = req.query;
  if (!origin || !destination) return res.status(400).json({ error: 'origin & destination required' });
  if (!GMAPS_KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not set' });

  const cacheKey = `eta:${origin}:${destination}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin}&destinations=${destination}&mode=driving&departure_time=now&traffic_model=best_guess&language=th&key=${GMAPS_KEY}`;
    const r = await fetch(url).then(r => r.json());
    const elem = r.rows?.[0]?.elements?.[0];
    const result = {
      distance: elem?.distance || null,
      duration: elem?.duration || null,
      duration_in_traffic: elem?.duration_in_traffic || null,
      status: elem?.status || 'UNKNOWN',
    };
    _mapsCache.set(cacheKey, { data: result, ts: Date.now() });
    res.json(result);
  } catch (e) {
    console.error('[MAPS/eta]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
//  CENTRAL CONFIG — Admin controls สิ่งที่ทุกหน้าต้องรู้
//  GET  /api/config          ← ทุกหน้าอ่าน
//  POST /api/config          ← Admin เขียน
//  Firebase: system/config
// ============================================================
app.get('/api/config', async (req, res) => {
  try {
    const snap = await db.ref('system/config').once('value');
    const cfg  = snap.val() || {};
    // defaults
    return res.json({
      demoMode:       cfg.demoMode       ?? false,
      demoVehicles:   cfg.demoVehicles   ?? 3,
      routeName:      cfg.routeName      ?? 'Siam Square ↔ แยก Rama IV (ถ.อังรีดูนัง)',
      offlineTimeout: (cfg.offlineTimeout && cfg.offlineTimeout >= 90) ? cfg.offlineTimeout : 90,
      announcement:   cfg.announcement  ?? '',
      groundStation:  normalizeGroundStationConfig(cfg.groundStation),
      batteryCalibration: normalizeBatteryCalibrationConfig(cfg.batteryCalibration),
      updatedAt:      cfg.updatedAt      ?? null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/config', authMiddleware, async (req, res) => {
  try {
    const allowed = ['demoMode','demoVehicles','routeName','offlineTimeout','announcement'];
    const patch   = {};
    for (const k of allowed) {
      if (k in req.body) patch[k] = req.body[k];
    }
    if ('offlineTimeout' in patch) {
      patch.offlineTimeout = Math.max(90, Number.parseInt(patch.offlineTimeout, 10) || 90);
    }
    if ('groundStation' in req.body) {
      patch.groundStation = normalizeGroundStationConfig(req.body.groundStation);
    }
    if ('batteryCalibration' in req.body) {
      patch.batteryCalibration = normalizeBatteryCalibrationConfig(req.body.batteryCalibration);
    }
    patch.updatedAt = Date.now();
    await db.ref('system/config').update(patch);
    if (patch.demoMode === true) {
      await ensureDemoFleetRunning('config_enabled');
    } else if (patch.demoMode === false) {
      await stopDemoFleet();
    }
    console.log('[CONFIG]', patch);
    return res.json({ ok: true, config: patch });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/config/ground-station', authMiddleware, async (req, res) => {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!validLatLng(lat, lng)) {
      return res.status(400).json({ error: 'lat must be 5.5-20.5 and lng must be 97.5-105.7' });
    }

    const patch = { lat, lng, updatedAt: Date.now() };
    if (req.body?.id !== undefined) {
      patch.id = String(req.body.id || DEFAULT_GROUND_STATION.id)
        .trim()
        .replace(/[^\w-]/g, '')
        .slice(0, 40) || DEFAULT_GROUND_STATION.id;
    }
    if (req.body?.label !== undefined) {
      patch.label = String(req.body.label || DEFAULT_GROUND_STATION.label)
        .trim()
        .slice(0, 80) || DEFAULT_GROUND_STATION.label;
    }

    const ref = db.ref('system/config/groundStation');
    await ref.update(patch);
    const snap = await ref.once('value');
    return res.json({ ok: true, groundStation: normalizeGroundStationConfig(snap.val() || {}) });
  } catch (e) {
    console.error('[CONFIG ground-station]', e);
    return res.status(500).json({ error: e.message });
  }
});

// Demo fleet simulation
function bearingCalc(la1,lo1,la2,lo2){
  const dO=(lo2-lo1)*Math.PI/180;
  const y=Math.sin(dO)*Math.cos(la2*Math.PI/180);
  const x=Math.cos(la1*Math.PI/180)*Math.sin(la2*Math.PI/180)-Math.sin(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.cos(dO);
  return((Math.atan2(y,x)*180/Math.PI)+360)%360;
}
const DEMO_IDS = ['DEMO_1', 'DEMO_2', 'DEMO_3'];
const DEMO_PLATES = {
  DEMO_1: 'DEMO-001',
  DEMO_2: 'DEMO-002',
  DEMO_3: 'DEMO-003',
};
const DEMO_FALLBACK_COORDS = [
  { lat: 8.4304, lng: 99.9631 },
  { lat: 8.4580, lng: 99.9502 },
  { lat: 8.4892, lng: 99.9378 },
  { lat: 8.5201, lng: 99.9215 },
  { lat: 8.5489, lng: 99.9087 },
  { lat: 8.5812, lng: 99.8934 },
  { lat: 8.6134, lng: 99.8821 },
  { lat: 8.6445, lng: 99.8673 },
  { lat: 8.6723, lng: 99.8512 },
  { lat: 8.7001, lng: 99.8334 },
];
let _demoTimer = null;
let _demoRouteId = 'route_nakhon_phromkhiri';
let demoRouteCoords = [];
let _demoRouteCoordFormat = 'unknown';
let _demoRouteCoordSource = 'none';
let _demoSpeedMultiplier = 1;
let _demoVehicles = new Map();
let _demoWriteLogCounts = new Map();
let _demoLastTickAt = 0;
let _demoLastError = null;
const DEMO_SPEED_MULTIPLIER_MIN = 0.25;
const DEMO_SPEED_MULTIPLIER_MAX = 2.0;
const DEMO_MAX_ELAPSED_SECONDS = 3;
const DEMO_BASE_SPEEDS_KMH = [16, 20, 24];
const demoVehicleState = {
  DEMO_1: { coordIndex: 0, direction: 'outbound', forward: true },
  DEMO_2: { coordIndex: 0, direction: 'outbound', forward: true },
  DEMO_3: { coordIndex: 0, direction: 'inbound', forward: false },
};

function clampDemoSpeedMultiplier(value) {
  const speed = Number(value);
  if (!Number.isFinite(speed)) return 1;
  return Math.max(DEMO_SPEED_MULTIPLIER_MIN, Math.min(DEMO_SPEED_MULTIPLIER_MAX, speed));
}

function buildVehiclePairs(nodes) {
  const vehicles = nodes.filter(node => node.type === 'vehicle' && node.status === 'online' && Number.isFinite(node.lat) && Number.isFinite(node.lng));
  const pairs = [];
  for (let i = 0; i < vehicles.length; i++) {
    for (let j = i + 1; j < vehicles.length; j++) {
      const distance = haversineDistanceMeters(vehicles[i], vehicles[j]);
      const distance_m = Math.round(distance);
      pairs.push({
        from: vehicles[i].vehicle_id,
        to: vehicles[j].vehicle_id,
        distance_m,
        distance_label: distance_m < 2000 ? `${distance_m} m` : `${(distance_m / 1000).toFixed(2)} km`,
        status: distance_m < 500 ? 'close' : distance_m < 2000 ? 'near' : distance_m < 10000 ? 'far' : 'distant'
      });
    }
  }
  return pairs;
}

function demoPointDirection(point, fallback = 'outbound') {
  return point?.direction === 'inbound' ? 'inbound' : fallback;
}

function isSameDemoPoint(a, b, thresholdM = 8) {
  if (!validLatLng(a?.lat, a?.lng) || !validLatLng(b?.lat, b?.lng)) return false;
  return haversineDistanceMeters(a, b) <= thresholdM;
}

function demoRouteLengthMeters(coords = demoRouteCoords) {
  if (!Array.isArray(coords) || coords.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < coords.length; i++) {
    const a = coords[i];
    const b = coords[(i + 1) % coords.length];
    if (validLatLng(a?.lat, a?.lng) && validLatLng(b?.lat, b?.lng)) {
      total += haversineDistanceMeters(a, b);
    }
  }
  return total;
}

function demoDistanceAtCoordIndex(index, coords = demoRouteCoords) {
  if (!Array.isArray(coords) || coords.length < 2) return 0;
  const end = Math.max(0, Math.min(coords.length - 1, Number(index) || 0));
  let distance = 0;
  for (let i = 0; i < end; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    if (validLatLng(a?.lat, a?.lng) && validLatLng(b?.lat, b?.lng)) {
      distance += haversineDistanceMeters(a, b);
    }
  }
  return distance;
}

function demoPositionAtDistance(distanceM, coords = demoRouteCoords) {
  const total = demoRouteLengthMeters(coords);
  if (!total || coords.length < 2) return null;
  let remaining = ((distanceM % total) + total) % total;
  for (let i = 0; i < coords.length; i++) {
    const a = coords[i];
    const b = coords[(i + 1) % coords.length];
    const segment = haversineDistanceMeters(a, b);
    if (!segment) continue;
    if (remaining <= segment) {
      const t = remaining / segment;
      const lat = a.lat + (b.lat - a.lat) * t;
      const lng = a.lng + (b.lng - a.lng) * t;
      return {
        lat,
        lng,
        segmentIndex: i,
        bearing: bearingCalc(lat, lng, b.lat, b.lng),
        direction: demoPointDirection(a, demoPointDirection(b)),
      };
    }
    remaining -= segment;
  }
  const first = coords[0];
  const next = coords[1];
  return { lat: first.lat, lng: first.lng, segmentIndex: 0, bearing: bearingCalc(first.lat, first.lng, next.lat, next.lng), direction: demoPointDirection(first) };
}

function initializeDemoFleet() {
  const len = demoRouteCoords.length;
  const routeLengthM = demoRouteLengthMeters();
  console.log(`[DEMO] initializeDemoFleet coords=${len} source=${_demoRouteCoordSource} format=${_demoRouteCoordFormat}`);
  const indices = [
    0,
    Math.floor(len / 3),
    Math.floor((2 * len) / 3)
  ];
  DEMO_IDS.forEach((id, index) => {
    const distanceM = routeLengthM
      ? Math.min(routeLengthM - 1, demoDistanceAtCoordIndex(indices[index]))
      : 0;
    const startPosition = demoPositionAtDistance(distanceM);
    Object.assign(demoVehicleState[id], {
      id,
      coordIndex: startPosition?.segmentIndex ?? Math.max(0, Math.min(len - 1, indices[index])),
      distanceM,
      lastMovedAt: Date.now(),
      direction: startPosition?.direction || (index === 2 ? 'inbound' : 'outbound'),
      forward: true,
      speed: DEMO_BASE_SPEEDS_KMH[index],
      battery: [93, 86, 79][index],
    });
  });
  _demoVehicles = new Map(DEMO_IDS.map(id => [id, demoVehicleState[id]]));
  _demoWriteLogCounts = new Map(DEMO_IDS.map(id => [id, 0]));
  for (const vehicle of _demoVehicles.values()) {
    console.log(`[DEMO] ${vehicle.id} starts at idx=${vehicle.coordIndex} direction=${vehicle.direction} forward=${vehicle.forward}`);
  }
}

function moveDemoVehicle(vehicleId, timestamp, updates) {
  const vehicle = demoVehicleState[vehicleId] || _demoVehicles.get(vehicleId);
  const routeLengthM = demoRouteLengthMeters();
  if (!vehicle || !routeLengthM || demoRouteCoords.length < 2) return null;
  const index = DEMO_IDS.indexOf(vehicleId);
  const elapsedSeconds = vehicle.lastMovedAt
    ? Math.max(0, Math.min(DEMO_MAX_ELAPSED_SECONDS, (timestamp - vehicle.lastMovedAt) / 1000))
    : 0;
  vehicle.lastMovedAt = timestamp;

  const wave = Math.sin(timestamp / 12000 + index * 1.7);
  const baseSpeed = DEMO_BASE_SPEEDS_KMH[index] || 18;
  const targetSpeed = (baseSpeed + wave * 2.5) * clampDemoSpeedMultiplier(_demoSpeedMultiplier);
  vehicle.speed = Math.max(4, Math.min(42, vehicle.speed + (targetSpeed - vehicle.speed) * 0.18));
  vehicle.distanceM = ((Number(vehicle.distanceM || 0) + (vehicle.speed * 1000 / 3600) * elapsedSeconds) % routeLengthM + routeLengthM) % routeLengthM;

  const position = demoPositionAtDistance(vehicle.distanceM);
  if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lng)) {
    console.error(`[DEMO] Invalid interpolated position for ${vehicleId} distance=${vehicle.distanceM}`);
    return null;
  }
  const lat = position.lat;
  const lng = position.lng;
  const direction = position.direction || vehicle.direction || 'outbound';
  vehicle.direction = direction;
  vehicle.coordIndex = position.segmentIndex;
  vehicle.battery = Math.max(20, Number((vehicle.battery - 0.015).toFixed(2)));
  const bearing = position.bearing;

  const current = {
    vehicle_id: vehicleId,
    plate: DEMO_PLATES[vehicleId] || vehicleId,
    lat,
    lng,
    speed: Number(vehicle.speed.toFixed(1)),
    battery: Number(vehicle.battery.toFixed(1)),
    bearing: Number(bearing.toFixed(1)),
    heading: Number(bearing.toFixed(1)),
    timestamp,
    server_received_at: Math.floor(timestamp / 1000),
    last_seen: Math.floor(timestamp / 1000),
    gps_fix: true,
    routeId: _demoRouteId,
    route_id: _demoRouteId,
    demo: true,
    direction,
    source: 'demo',
    battVoltage: Math.round(12400 + vehicle.battery * 7),
    currentMa: Math.round(420 + vehicle.speed * 9),
    powerMw: Math.round((12400 + vehicle.battery * 7) * (420 + vehicle.speed * 9) / 1000),
    txCount: Math.floor(timestamp / 1000) % 100000,
    sats: 9 + index,
    hdop: Number((0.8 + index * 0.12).toFixed(2)),
    rssi: -54 - index * 5,
    snr: Number((9.5 - index * 0.8).toFixed(1)),
    link_quality: Math.max(70, 96 - index * 8),
    seq: Math.floor(timestamp / 1000),
    boot_id: `demo-${vehicleId}`,
    packet_id: `${vehicleId}-${timestamp}`,
    ttl: 5,
    store_forward: false,
    relay_from: index > 0 ? DEMO_IDS[0] : null,
    relay_chain: index > 0 ? [DEMO_IDS[0]] : [],
    neighbors: DEMO_IDS.filter(id => id !== vehicleId),
    version_summary: ['demo-sim:1.0'],
    received_rssi: -50 - index * 4,
    received_snr: Number((10.2 - index * 0.7).toFixed(1)),
  };

  updates[`fleet/${vehicleId}/current`] = current;
  updates[`fleet/${vehicleId}/routeId`] = _demoRouteId;
  updates[`fleet/${vehicleId}/type`] = 'demo';
  updates[`fleet/${vehicleId}/demo`] = true;
  updates[`fleet/${vehicleId}/plate`] = current.plate;
  updates[`fleet/${vehicleId}/description`] = `Demo vehicle ${index + 1}`;
  updates[`history/${todayStr()}/${vehicleId}/${timestamp}`] = current;
  updates[`analytics/peak_hours/${todayStr()}/${vehicleId}/${getBangkokHour()}`] = admin.database.ServerValue.increment(1);
  console.log(`[DEMO tick] ${vehicleId} idx:${vehicle.coordIndex} direction:${direction} speed:${current.speed} lat:${Number(lat).toFixed(6)} lng:${Number(lng).toFixed(6)}`);
  const logCount = _demoWriteLogCounts.get(vehicleId) || 0;
  if (logCount < 3) {
    console.log(`[DEMO] write ${vehicleId} tick=${logCount + 1} path=fleet/${vehicleId}/current idx=${vehicle.coordIndex} direction=${direction} speed=${current.speed} lat=${current.lat} lng=${current.lng} routeId=${current.routeId}`);
    _demoWriteLogCounts.set(vehicleId, logCount + 1);
  }
  return current;
}

async function stopDemoFleet() {
  console.log('[DEMO] stopDemoFleet clearing interval and removing demo fleet entries');
  clearInterval(_demoTimer); _demoTimer = null; _demoVehicles = new Map();
  _demoLastTickAt = 0;
  _demoLastError = null;
  const cleanup = { 'fleet/TWIN_01': null };
  DEMO_IDS.forEach(id => { cleanup[`fleet/${id}`] = null; });
  await db.ref().update(cleanup);
}

async function demoFleetTick() {
  try {
    if (!await getDemoMode()) { await stopDemoFleet(); return; }
    const timestamp = Date.now();
    const updates = {};
    DEMO_IDS.forEach(vehicleId => moveDemoVehicle(vehicleId, timestamp, updates));
    const count = Object.keys(updates).length;
    console.log(`[DEMO] demoFleetTick updates=${count} coordCount=${demoRouteCoords.length}`);
    if (count > 0) {
      await db.ref().update(updates);
      _demoLastTickAt = Date.now();
      _demoLastError = null;
    } else {
      _demoLastError = 'no_demo_updates';
    }
  } catch (error) {
    _demoLastError = error.message;
    console.error('[DEMO] demoFleetTick failed:', error);
  }
}

function activeDemoIntervalCount() {
  return _demoTimer ? 1 : 0;
}

function scheduleDemoFleetTick() {
  clearInterval(_demoTimer);
  _demoTimer = setInterval(() => {
    demoFleetTick().catch(error => {
      _demoLastError = error.message;
      console.error('[DEMO] async tick failed:', error);
    });
  }, 1000);
}

async function ensureDemoFleetRunning(reason = 'watchdog') {
  const demoMode = await getDemoMode();
  if (!demoMode) return { demoMode, running: false, started: false, reason };
  const stale = !_demoLastTickAt || Date.now() - _demoLastTickAt > 5000;
  if (_demoTimer && !stale && demoRouteCoords.length) {
    return { demoMode, running: true, started: false, reason, lastTickAt: _demoLastTickAt };
  }
  console.warn(`[DEMO] watchdog restarting simulator reason=${reason} timer=${!!_demoTimer} stale=${stale} coords=${demoRouteCoords.length}`);
  await startDemoFleet();
  return { demoMode: true, running: true, started: true, reason, lastTickAt: _demoLastTickAt };
}

function normalizeDemoRouteCoords(coords = []) {
  const normalized = coords.map(point => {
    if (Array.isArray(point)) return { lat: Number(point[0]), lng: Number(point[1]) };
    return { lat: Number(point?.lat), lng: Number(point?.lng) };
  }).filter(point => validLatLng(point.lat, point.lng));
  const first = coords[0];
  const format = Array.isArray(first) ? 'array-pair' : first && typeof first === 'object' ? 'object-lat-lng' : 'unknown';
  return { coords: normalized, format };
}

function appendDemoDirectionCoords(target, coords, direction) {
  coords.forEach(point => {
    const next = { lat: point.lat, lng: point.lng, direction };
    const previous = target[target.length - 1];
    if (!previous || !isSameDemoPoint(previous, next)) target.push(next);
  });
}

function buildDemoRoutePath(route = {}) {
  const outboundRaw = Array.isArray(route?.directions?.outbound?.coords)
    ? route.directions.outbound.coords
    : Array.isArray(route?.coords)
      ? route.coords
      : [];
  const inboundRaw = Array.isArray(route?.directions?.inbound?.coords)
    ? route.directions.inbound.coords
    : [];
  const outbound = normalizeDemoRouteCoords(outboundRaw);
  const inbound = normalizeDemoRouteCoords(inboundRaw);
  const coords = [];
  appendDemoDirectionCoords(coords, outbound.coords, 'outbound');
  if (inbound.coords.length > 1) {
    appendDemoDirectionCoords(coords, inbound.coords, 'inbound');
  } else if (outbound.coords.length > 1) {
    appendDemoDirectionCoords(coords, [...outbound.coords].reverse(), 'inbound');
  }
  return {
    coords,
    format: inbound.coords.length > 1 ? `${outbound.format}+inbound:${inbound.format}` : `${outbound.format}+reverse`,
    outboundCount: outbound.coords.length,
    inboundCount: inbound.coords.length,
    hasInbound: inbound.coords.length > 1,
  };
}

function findDemoRouteWithCoords(routes, preferredRouteId = '') {
  const entries = Object.entries(routes || {});
  const orderedEntries = preferredRouteId
    ? [
      ...entries.filter(([routeKey, route]) => [routeKey, route?.id, route?.route_id, route?.routeId].includes(preferredRouteId)),
      ...entries.filter(([routeKey, route]) => ![routeKey, route?.id, route?.route_id, route?.routeId].includes(preferredRouteId)),
    ]
    : entries;
  console.log(`[DEMO] Scanning ${entries.length} Firebase routes for coords length > 5`);
  for (const [routeKey, route] of orderedEntries) {
    const normalized = buildDemoRoutePath(route);
    const routeId = route?.id || route?.route_id || route?.routeId || routeKey;
    console.log(`[DEMO] route candidate routeId=${routeId} outbound=${normalized.outboundCount} inbound=${normalized.inboundCount} validPath=${normalized.coords.length} format=${normalized.format} hasInbound=${normalized.hasInbound}`);
    if (normalized.coords.length > 5) {
      console.log(`[DEMO] selected routeId=${routeId} coordCount=${normalized.coords.length} firstCoord=${JSON.stringify(normalized.coords[0])}`);
      console.log(`[DEMO] normalized first3=${normalized.coords.slice(0, 3).map(point => `${point.lat},${point.lng}`).join(' | ')}`);
      return { routeKey, route, normalized };
    }
  }
  return null;
}

async function startDemoFleet(options = {}) {
  const [routesSnap, configSnap] = await Promise.all([
    db.ref('routes').once('value'),
    db.ref('system/config').once('value'),
  ]);
  const routes = routesSnap.val() || {};
  const config = configSnap.val() || {};
  _demoSpeedMultiplier = clampDemoSpeedMultiplier(config.demoSpeed ?? _demoSpeedMultiplier);
  const preferredRouteId = String(options.routeId || config.demoRouteId || '').trim();
  console.log(`[DEMO] startDemoFleet demoRouteIdConfig=${config.demoRouteId || '-'} requested=${preferredRouteId || '-'} assumption=routes is object keyed by routeId; coords may be [lat,lng] or {lat,lng}`);
  const selected = findDemoRouteWithCoords(routes, preferredRouteId);
  if (selected) {
    const routeId = selected.route.id || selected.route.route_id || selected.route.routeId || selected.routeKey;
    demoRouteCoords = selected.normalized.coords;
    _demoRouteCoordFormat = selected.normalized.format;
    _demoRouteCoordSource = 'firebase';
    _demoRouteId = routeId;
  } else {
    const fallback = buildDemoRoutePath({ coords: DEMO_FALLBACK_COORDS });
    demoRouteCoords = fallback.coords;
    _demoRouteCoordFormat = fallback.format;
    _demoRouteCoordSource = 'fallback';
    _demoRouteId = preferredRouteId || _demoRouteId;
    console.error('[DEMO] Using fallback hardcoded route');
    console.log(`[DEMO] selected fallback routeId=${_demoRouteId} coordCount=${demoRouteCoords.length} firstCoord=${JSON.stringify(demoRouteCoords[0])}`);
    console.log(`[DEMO] normalized first3=${demoRouteCoords.slice(0, 3).map(point => `${point.lat},${point.lng}`).join(' | ')}`);
  }
  console.log(`[DEMO] route=${_demoRouteId} coords=${demoRouteCoords.length} source=${_demoRouteCoordSource} format=${_demoRouteCoordFormat}`);
  await db.ref('system/config').update({ demoMode: true, demoVehicles: 3, demoRouteId: _demoRouteId, demoSpeed: _demoSpeedMultiplier, updatedAt: Date.now() });
  initializeDemoFleet();
  scheduleDemoFleetTick();
  await demoFleetTick();
}

app.post('/api/demo/start', authMiddleware, async (req,res)=>{
  try {
    const requestedRoute = req.body?.routeId || req.body?.route_id || '';
    console.log(`[DEMO] POST /api/demo/start requestedRoute=${requestedRoute || '-'}`);
    await startDemoFleet({ routeId: requestedRoute });
    return res.json({ ok: true, vehicles: 3, routeId: _demoRouteId, ids: DEMO_IDS, coords: demoRouteCoords.length, coordFormat: _demoRouteCoordFormat, coordSource: _demoRouteCoordSource });
  } catch (error) {
    console.error('[DEMO] start failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/demo/speed', authMiddleware, async (req,res)=>{
  const requestedSpeed = parseFloat(req.body.speed);
  if(!isNaN(requestedSpeed)&&requestedSpeed>0&&requestedSpeed<=DEMO_SPEED_MULTIPLIER_MAX){
    const speed = clampDemoSpeedMultiplier(requestedSpeed);
    _demoSpeedMultiplier=speed;
    await db.ref('system/config').update({demoSpeed:speed,updatedAt:Date.now()});
    return res.json({ok:true,speed});
  }
  res.status(400).json({error:`Invalid speed; use ${DEMO_SPEED_MULTIPLIER_MIN}-${DEMO_SPEED_MULTIPLIER_MAX}x`});
});

app.post('/api/demo/stop', authMiddleware, async (req,res)=>{
  await db.ref('system/config').update({demoMode:false,updatedAt:Date.now()});
  await stopDemoFleet();
  return res.json({ok:true});
});

app.get('/api/demo/status', async (req,res)=>{
  try {
    const watchdog = await ensureDemoFleetRunning('status');
    const demoMode = watchdog.demoMode;
    return res.json({
      running: demoMode && _demoTimer !== null,
      demoMode,
      vehicles: DEMO_IDS,
      ids: DEMO_IDS,
      routeId: _demoRouteId,
      coords: demoRouteCoords.length,
      coordFormat: _demoRouteCoordFormat,
      coordSource: _demoRouteCoordSource,
      demoSpeed: _demoSpeedMultiplier,
      lastTickAt: _demoLastTickAt,
      lastTickAgeMs: _demoLastTickAt ? Date.now() - _demoLastTickAt : null,
      lastError: _demoLastError,
      restarted: watchdog.started === true,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read demo status' });
  }
});

app.get('/api/demo/debug', async (_req, res) => {
  try {
    const [demoMode, fleetSnap] = await Promise.all([
      getDemoMode(),
      db.ref('fleet').once('value'),
    ]);
    const fleet = fleetSnap.val() || {};
    const vehicles = {};
    DEMO_IDS.forEach(id => {
      const memory = _demoVehicles.get(id);
      const current = fleet[id]?.current || {};
      vehicles[id] = {
        lat: Number.isFinite(Number(current.lat)) ? Number(current.lat) : null,
        lng: Number.isFinite(Number(current.lng)) ? Number(current.lng) : null,
        coordIndex: memory?.coordIndex ?? null,
        distanceM: Number.isFinite(Number(memory?.distanceM)) ? Number(memory.distanceM.toFixed(1)) : null,
        speed: Number.isFinite(Number(current.speed)) ? Number(current.speed) : null,
        direction: memory?.direction ?? null,
        forward: memory?.forward ?? null,
      };
    });
    return res.json({
      demoMode,
      coordCount: demoRouteCoords.length,
      coordSource: _demoRouteCoordSource,
      vehicles,
      intervals: activeDemoIntervalCount(),
    });
  } catch (error) {
    console.error('[DEMO] debug failed:', error);
    return res.status(500).json({ error: 'Failed to read demo debug state' });
  }
});

// ============================================================
//  AUTHENTICATION APIs
// ============================================================

// POST /api/auth/login
function loginAttemptRef(req, username) {
  return db.ref(`security/login_attempts/${hashKey(`${req.ip || 'unknown'}:${String(username || '').toLowerCase()}`)}`);
}

async function loginIsLocked(req, username) {
  const value = (await loginAttemptRef(req, username).once('value')).val() || {};
  return Number(value.lockedUntil || 0) > Date.now();
}

async function recordLoginFailure(req, username) {
  const ref = loginAttemptRef(req, username);
  const now = Date.now();
  await ref.transaction(current => {
    const recent = current && now - Number(current.startedAt || 0) < LOGIN_LOCK_MS;
    const failures = recent ? Number(current.failures || 0) + 1 : 1;
    return { startedAt: recent ? current.startedAt : now, failures, lockedUntil: failures >= LOGIN_MAX_FAILURES ? now + LOGIN_LOCK_MS : 0, updatedAt: now };
  });
}

app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  try {
    if (!authConfigured()) return res.status(503).json({ error: 'Admin authentication is not configured' });
    if (await loginIsLocked(req, username)) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    const valid = username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!valid) {
      await recordLoginFailure(req, username);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Generate JWT
    const token = jwt.sign(
      { username: ADMIN_USERNAME, role: 'admin' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );
    
    await loginAttemptRef(req, username).remove();
    res.set('Set-Cookie', sessionCookie(token));
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, user: { username: ADMIN_USERNAME, role: 'admin' } });
  } catch (e) {
    console.error('[Auth Login Error]', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  res.set('Set-Cookie', sessionCookie('', 0));
  res.set('Cache-Control', 'no-store');
  res.status(204).end();
});

// GET /api/auth/verify - Check if token is still valid
app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, user: req.user });
});

// ============================================================
//  ROUTE MANAGEMENT APIs (Protected)
// ============================================================

// GET /api/routes - List all routes with full Firebase schema
app.get('/api/routes', async (req, res) => {
  try {
    const [routesSnap, fleetSnap] = await Promise.all([
      db.ref('routes').once('value'),
      db.ref('fleet').once('value'),
    ]);
    const routes = routesSnap.val() || {};
    const fleet = fleetSnap.val() || {};
    const activeOnly = String(req.query.active || '').toLowerCase() === 'true';
    const result = {};
    for (const [id, route] of Object.entries(routes)) {
      const normalized = normalizeRouteForApi(route, id, routeVehicleCount(fleet, id));
      if (activeOnly && normalized.active === false) continue;
      result[id] = normalized;
    }
    res.json(result);
  } catch (e) {
    console.error('[ROUTE] Failed to fetch routes:', e);
    res.status(500).json({ error: 'Failed to fetch routes' });
  }
});

// GET /api/routes/:id - Get one route with directions and stops
app.get('/api/routes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [routeSnap, fleetSnap] = await Promise.all([
      db.ref(`routes/${id}`).once('value'),
      db.ref('fleet').once('value'),
    ]);
    if (!routeSnap.exists()) return res.status(404).json({ error: 'Route not found' });
    res.json(normalizeRouteForApi(routeSnap.val(), id, routeVehicleCount(fleetSnap.val() || {}, id)));
  } catch (e) {
    console.error(`[ROUTE] Failed to fetch route ${id}:`, e);
    res.status(500).json({ error: 'Failed to fetch route' });
  }
});

// POST /api/routes - Create new route (admin only)
app.post('/api/routes', authMiddleware, async (req, res) => {
  try {
    if (!req.body?.name) return res.status(400).json({ error: 'name required' });
    const routeId = sanitizeRouteId(req.body.id || req.body.routeId || req.body.route_id || `route_${Date.now()}`);
    const existingSnap = await db.ref(`routes/${routeId}`).once('value');
    if (existingSnap.exists()) return res.status(409).json({ error: 'Route id already exists' });
    const route = buildRouteForWrite(req.body, routeId);
    await db.ref(`routes/${routeId}`).set(route);
    console.log(`[ROUTE] Created ${routeId}`);
    res.status(201).json({ ok: true, routeId, route: normalizeRouteForApi(route, routeId) });
  } catch (e) {
    console.error('[ROUTE] Failed to create route:', e);
    res.status(500).json({ error: 'Failed to create route' });
  }
});

// PATCH /api/routes/:id - Edit route (admin only, partial merge)
app.patch('/api/routes/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const ref = db.ref(`routes/${id}`);
    const snap = await ref.once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'Route not found' });
    const patch = buildRoutePatch(req.body || {});
    await ref.update(patch);
    const updatedSnap = await ref.once('value');
    console.log(`[ROUTE] Updated ${id}:`, Object.keys(patch));
    res.json({ ok: true, routeId: id, route: normalizeRouteForApi(updatedSnap.val(), id) });
  } catch (e) {
    console.error(`[ROUTE] Failed to update route ${id}:`, e);
    res.status(500).json({ error: 'Failed to update route' });
  }
});

// DELETE /api/routes/:id - Delete route and unassign all vehicles (admin only)
app.delete('/api/routes/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const fleetSnap = await db.ref('fleet').once('value');
    const fleet = fleetSnap.val() || {};
    const updates = {};
    for (const [vid, v] of Object.entries(fleet)) {
      if ((v?.routeId || v?.route_id) === id) {
        updates[`fleet/${vid}/routeId`] = 'unassigned';
      }
    }
    updates[`routes/${id}`] = null;
    await db.ref().update(updates);
    console.log(`[ROUTE] Deleted route ${id}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(`[ROUTE] Failed to delete route ${id}:`, e);
    res.status(500).json({ error: 'Failed to delete route' });
  }
});

// POST /api/routes/:id/directions/:dir/coords - Replace direction coords (admin only)
app.post('/api/routes/:id/directions/:dir/coords', authMiddleware, async (req, res) => {
  const { id, dir } = req.params;
  if (!validRouteDir(dir)) return res.status(400).json({ error: 'Direction must be outbound or inbound' });
  if (!Array.isArray(req.body?.coords)) return res.status(400).json({ error: 'coords array required' });
  try {
    const ref = db.ref(`routes/${id}`);
    const snap = await ref.once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'Route not found' });
    const coords = normalizeCoordsList(req.body.coords);
    await ref.update({ [`directions/${dir}/coords`]: coords, updatedAt: Date.now() });
    res.json({ ok: true, routeId: id, direction: dir, coords });
  } catch (e) {
    console.error(`[ROUTE] Failed to replace coords for ${id}/${dir}:`, e);
    res.status(500).json({ error: 'Failed to replace coords' });
  }
});

// POST /api/routes/:id/directions/:dir/stops - Replace direction stops (admin only)
app.post('/api/routes/:id/directions/:dir/stops', authMiddleware, async (req, res) => {
  const { id, dir } = req.params;
  if (!validRouteDir(dir)) return res.status(400).json({ error: 'Direction must be outbound or inbound' });
  if (!Array.isArray(req.body?.stops)) return res.status(400).json({ error: 'stops array required' });
  try {
    const ref = db.ref(`routes/${id}`);
    const snap = await ref.once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'Route not found' });
    const stops = normalizeStopList(req.body.stops, id, dir);
    await ref.update({ [`directions/${dir}/stops`]: stops, updatedAt: Date.now() });
    res.json({ ok: true, routeId: id, direction: dir, stops });
  } catch (e) {
    console.error(`[ROUTE] Failed to replace stops for ${id}/${dir}:`, e);
    res.status(500).json({ error: 'Failed to replace stops' });
  }
});

// DELETE /api/admin/all-routes - Delete ALL routes (admin only, for full reset)
app.delete('/api/admin/all-routes', authMiddleware, async (req, res) => {
  try {
    // Unassign all fleet vehicles
    const fleetSnap = await db.ref('fleet').once('value');
    const fleet = fleetSnap.val() || {};
    const updates = {};
    for (const vid of Object.keys(fleet)) {
      updates[`fleet/${vid}/routeId`] = 'unassigned';
    }
    updates['routes'] = null;
    await db.ref().update(updates);
    console.log('[ROUTE] Deleted ALL routes');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete all routes' });
  }
});

// POST /api/routes/:id/vehicles - Add vehicle to route (admin only)
app.post('/api/routes/:id/vehicles', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { vehicleId, type = 'real' } = req.body;

  if (!vehicleId) {
    return res.status(400).json({ error: 'vehicleId required' });
  }

  try {
    const routeSnap = await db.ref(`routes/${id}`).once('value');
    if (!routeSnap.exists()) {
      return res.status(404).json({ error: 'Route not found' });
    }

    await db.ref(`fleet/${vehicleId}`).update({
      routeId:    id,
      type:       type,
      assignedAt: Date.now()
    });

    console.log(`[FLEET] Assigned ${vehicleId} → route ${id}`);
    res.json({ ok: true, vehicleId, routeId: id });
  } catch (e) {
    res.status(500).json({ error: 'Failed to add vehicle' });
  }
});

// DELETE /api/routes/:id/vehicles/:vid - Remove vehicle from route (admin only)
app.delete('/api/routes/:id/vehicles/:vid', authMiddleware, async (req, res) => {
  const { vid } = req.params;

  try {
    await db.ref(`fleet/${vid}`).update({ routeId: 'unassigned', type: null });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to remove vehicle' });
  }
});

// GET /api/routes/:id/vehicles - Get vehicles in route
app.get('/api/routes/:id/vehicles', async (req, res) => {
  const { id } = req.params;

  try {
    const fleetSnap = await db.ref('fleet').once('value');
    const fleet = fleetSnap.val() || {};

    const vehicles = {};
    for (const [vid, v] of Object.entries(fleet)) {
      if (v.routeId === id) {
        vehicles[vid] = v;
      }
    }

    res.json(vehicles);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch vehicles' });
  }
});

// ============================================================
//  FLEET MANAGEMENT
//  GET  /api/fleet              ← รายชื่อรถทั้งหมดใน Firebase
//  POST /api/fleet/register     ← ลงทะเบียนรถใหม่
//  DELETE /api/fleet/:id        ← ลบรถออกจากระบบ
//  PATCH /api/fleet/:id         ← แก้ไขรถ (เปลี่ยน routeId)
// ============================================================
app.get('/api/fleet', authMiddleware, async (req, res) => {
  try {
    await ensureDemoFleetRunning('fleet');
    const [fleetSnap, demoMode] = await Promise.all([db.ref('fleet').once('value'), getDemoMode()]);
    const fleet = fleetSnap.val() || {};
    const result = {};
    for (const [id, v] of Object.entries(fleet)) {
      if (!demoMode && isDemoVehicle(id, v)) continue;
      const current = currentForFleetResponse(id, v, demoMode);
      const routeId = v.routeId || current?.routeId || current?.route_id || 'unassigned';
      result[id] = {
        vehicleId:  id,
        routeId,
        type:       v.type || 'real',
        plate:      sanitizePlate(v.plate || current?.plate) || '',
        description:v.description || '',
        assignedAt: v.assignedAt || null,
        current,
      };
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch fleet' });
  }
});

app.post('/api/fleet/register', authMiddleware, async (req, res) => {
  const { vehicleId, routeId = 'unassigned', description = '', type = 'real' } = req.body;
  const plate = sanitizePlate(req.body.plate || req.body.license_plate || req.body.licensePlate);
  if (!vehicleId || !/^[a-zA-Z0-9_-]+$/.test(vehicleId)) {
    return res.status(400).json({ error: 'vehicleId required (a-z, 0-9, _, -)' });
  }
  try {
    const existing = await db.ref(`fleet/${vehicleId}`).once('value');
    if (existing.exists()) {
      return res.status(409).json({ error: `Vehicle "${vehicleId}" already registered` });
    }
    await db.ref(`fleet/${vehicleId}`).set({
      routeId,
      type,
      description,
      plate,
      registeredAt: Date.now(),
      assignedAt:   Date.now(),
    });
    console.log(`[FLEET] Registered new vehicle: ${vehicleId} → ${routeId}`);
    res.json({ ok: true, vehicleId, routeId });
  } catch (e) {
    res.status(500).json({ error: 'Failed to register vehicle' });
  }
});

app.delete('/api/fleet/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    await db.ref(`fleet/${id}`).remove();
    console.log(`[FLEET] Removed vehicle: ${id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete vehicle' });
  }
});

app.patch('/api/fleet/:id', authMiddleware, async (req, res) => {
  const { id }      = req.params;
  const { routeId, description, type } = req.body;
  try {
    const patch = { updatedAt: Date.now() };
    if (routeId     !== undefined) patch.routeId     = routeId;
    if (description !== undefined) patch.description = description;
    if (type        !== undefined) patch.type        = type;
    if (req.body.plate !== undefined || req.body.license_plate !== undefined || req.body.licensePlate !== undefined) {
      patch.plate = sanitizePlate(req.body.plate || req.body.license_plate || req.body.licensePlate);
    }
    await db.ref(`fleet/${id}`).update(patch);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update vehicle' });
  }
});



// ============================================================
//  POST /api/admin/purge-ghosts
//  ── ลบรถที่ข้อมูลผี (Offline > 1 ชั่วโมง หรือพิกัดนอก Thailand) ──
//  ไม่ต้อง Auth เพื่อให้ Dashboard กดได้ด้วย
//  Response: { ok, removed, ids }
// ============================================================
app.post('/api/admin/purge-ghosts', authMiddleware, async (req, res) => {
  try {
    const snap  = await db.ref('fleet').once('value');
    const fleet = snap.val() || {};
    const now   = Date.now();
    const ONE_HOUR_MS = 60 * 60 * 1000;

    const toRemove = [];
    for (const [id, v] of Object.entries(fleet)) {
      const cur = v?.current;
      if (!cur) { toRemove.push(id); continue; }

      // Offline > 1 ชั่วโมง
      const age = cur.timestamp ? (now - cur.timestamp) : Infinity;
      if (age > ONE_HOUR_MS) { toRemove.push(id); continue; }

      // พิกัดไม่ถูกต้อง (นอก Thailand)
      if (cur.lat != null && cur.lng != null && !validLatLng(cur.lat, cur.lng)) {
        toRemove.push(id); continue;
      }
    }

    if (toRemove.length) {
      const updates = {};
      toRemove.forEach(id => { updates[`fleet/${id}`] = null; });
      await db.ref().update(updates);
    }

    console.log(`[PURGE] Removed ${toRemove.length} ghost vehicles:`, toRemove);
    return res.json({ ok: true, removed: toRemove.length, ids: toRemove });
  } catch (e) {
    console.error('[PURGE]', e);
    return res.status(500).json({ error: e.message });
  }
});

// ── SPA fallback (ต้องอยู่ก่อน app.listen เสมอ) ─────────────────────────────
// [FIX] เดิมอยู่หลัง app.listen() → ไม่ register → unknown path ได้ HTML
// → frontend parse JSON ไม่ได้ → "Unexpected token '<'"
app.post('/api/admin/command', authMiddleware, async (req, res) => {
  try {
    const vehicleId = String(req.body.vehicleId || req.body.vehicle_id || '').trim();
    const cmd = String(req.body.cmd || '').trim();
    const val = Number(req.body.val || 0);

    if (!vehicleId || (vehicleId !== 'all' && !/^[A-Z0-9_]{3,16}$/.test(vehicleId))) {
      return res.status(400).json({ error: 'vehicleId must be BUS_01 or all' });
    }
    if (!['set_interval', 'reboot'].includes(cmd)) {
      return res.status(400).json({ error: 'unsupported command' });
    }
    if (cmd === 'set_interval' && (!Number.isFinite(val) || val < 1000 || val > 60000)) {
      return res.status(400).json({ error: 'val must be 1000..60000 for set_interval' });
    }

    const command = {
      commandId: crypto.randomUUID(),
      vehicleId,
      cmd,
      val: cmd === 'reboot' ? 0 : Math.round(val),
      ts: Date.now(),
      status: 'pending',
    };
    await db.ref('system/pending_command').set(command);
    return res.json({ ok: true, command });
  } catch (error) {
    console.error('[POST /api/admin/command]', error);
    return res.status(500).json({ error: 'command_failed' });
  }
});

app.get('/api/ground/command', async (req, res) => {
  const groundId = firebaseKeyPart(req.query.ground_id || req.get('X-Ground-Id'));
  if (!groundId || !await verifyGroundKey(groundId, req.get('X-Ground-Key'))) {
    return res.status(403).json({ error: 'Ground key is not authorized' });
  }
  try {
    const ref = db.ref('system/pending_command');
    const snap = await ref.once('value');
    const command = snap.val();
    if (!command || command.status !== 'pending') {
      return res.json({ ok: true, command: null });
    }

    return res.json({ ok: true, command: { ...command, commandId: command.commandId || String(command.ts || Date.now()) } });
  } catch (error) {
    console.error('[GET /api/ground/command]', error);
    return res.status(500).json({ error: 'command_poll_failed' });
  }
});

app.post('/api/ground/command/:commandId/ack', async (req, res) => {
  const groundId = firebaseKeyPart(req.body?.ground_id || req.get('X-Ground-Id'));
  if (!groundId || !await verifyGroundKey(groundId, req.get('X-Ground-Key'))) {
    return res.status(403).json({ error: 'Ground key is not authorized' });
  }
  const ref = db.ref('system/pending_command');
  const snap = await ref.once('value');
  const command = snap.val();
  const commandId = String(req.params.commandId || '');
  if (!command || String(command.commandId || command.ts) !== commandId) return res.status(404).json({ error: 'Command not found' });
  await ref.update({ status: 'acknowledged', acknowledgedAt: Date.now(), groundId });
  return res.json({ ok: true });
});

app.get('/api/v1/network', async (req, res) => {
  try {
    const { route_id, direction, online_only } = req.query;
    const cacheKey = JSON.stringify({
      route_id: route_id || '',
      direction: direction || '',
      online_only: online_only || '',
    });
    const now = Date.now();
    if (networkCache.key === cacheKey && networkCache.payload && now < networkCache.expiresAt) {
      return res.json(networkCache.payload);
    }

    await ensureDemoFleetRunning('network');
    const [fleetSnap, configSnap] = await Promise.all([
      db.ref('fleet').once('value'),
      db.ref('system/config').once('value')
    ]);
    const fleetData = fleetSnap.val() || {};
    const sysConfig = configSnap.val() || {};
    const demoMode = sysConfig.demoMode === true;
    const gs = sysConfig.groundStation || {};
    const groundStation = {
      id: gs.id || 'GROUND_01',
      type: 'ground_station',
      lat: typeof gs.lat === 'number' ? gs.lat : 8.4304,
      lng: typeof gs.lng === 'number' ? gs.lng : 99.9631,
      status: 'online',
      label: gs.label || 'สถานีภาคพื้น'
    };
    const offlineTimeoutMs = Math.max(90, Number(sysConfig.offlineTimeout) || 90) * 1000;
    const nodes = Object.entries(fleetData)
      .filter(([vehicleId, vehicleData]) => demoMode || !isDemoVehicle(vehicleId, vehicleData))
      .map(([vehicleId, vehicleData]) => normalizeNetworkNode(
        vehicleId,
        vehicleData.current || {},
        vehicleData,
        offlineTimeoutMs,
        demoMode,
        sysConfig.batteryCalibration || {}
      ))
      .filter(node => {
        if (demoMode && node.demo) {
          console.log(`[demo] including demo vehicle ${node.id}`);
          return true;
        }
        return !route_id || route_id === 'all' || node.route_id === canonicalRouteId(route_id);
      })
      .filter(node => !direction || direction === 'all' || node.direction === direction)
      .filter(node => online_only !== 'true' || node.status === 'online');

    const hasRealMesh = nodes.some(node => node.relay_from !== null || node.hop !== null);
    const links = hasRealMesh ? buildRealTelemetryLinks(nodes, groundStation) : demoMode ? buildEstimatedLinks(nodes, groundStation) : [];
    if (demoMode && !hasRealMesh) {
      links.forEach(link => {
        const node = nodes.find(item => item.id === link.from);
        if (node) node.hop = link.hop;
      });
      nodes.forEach(node => { delete node._hop; });
    }

    const vehiclePairs = buildVehiclePairs(nodes);
    const payload = {
      server_time: now,
      mode: hasRealMesh ? 'telemetry' : demoMode ? 'estimated' : 'waiting',
      health: calculateMeshHealth([groundStation, ...nodes], links),
      nodes: [groundStation, ...nodes],
      links,
      vehicle_pairs: vehiclePairs,
      meta: {
        total_vehicles: nodes.length,
        online_vehicles: nodes.filter(node => node.status === 'online').length,
        direct_links: links.filter(link => link.type === 'direct').length,
        relay_links: links.filter(link => link.type === 'relay').length,
        ground_station: groundStation.id
      }
    };
    networkCache = { key: cacheKey, expiresAt: Date.now() + NETWORK_CACHE_MS, payload };
    res.json(payload);
  } catch (error) {
    console.error('[/api/v1/network]', error);
    res.status(500).json({ error: 'network_error' });
  }
});

// ============================================================
//  FIELD TEST SESSIONS (admin only)
//  Firebase path: network/fieldtest/{sessionId}
// ============================================================
app.post('/api/v1/fieldtest/session', authMiddleware, async (req, res) => {
  try {
    const sessionId = `field_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const nodes = Array.isArray(req.body?.nodes) ? req.body.nodes : [];
    const links = Array.isArray(req.body?.links) ? req.body.links : [];
    if (nodes.length > 50) return res.status(400).json({ error: 'Too many nodes (max 50)' });
    if (links.length > 200) return res.status(400).json({ error: 'Too many links (max 200)' });
    const rawSessionName = String(req.body?.sessionName || '').trim();
    const sessionName = (rawSessionName || `Field test ${new Date().toISOString()}`).slice(0, 120);
    const notes = String(req.body?.notes || '').slice(0, 5000);
    const now = Date.now();
    const session = {
      sessionId,
      sessionName,
      nodes,
      links,
      notes,
      createdAt: now,
      updatedAt: now,
      createdBy: req.user?.username || req.user?.sub || 'admin'
    };
    await db.ref(`network/fieldtest/${sessionId}`).set(session);
    res.status(201).json({ ok: true, sessionId, session });
  } catch (error) {
    console.error('[FIELDTEST] save failed:', error);
    res.status(500).json({ error: 'Failed to save field test session' });
  }
});

app.get('/api/v1/fieldtest/session/:id', authMiddleware, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '').replace(/[^\w-]/g, '');
    if (!sessionId) return res.status(400).json({ error: 'Invalid field test session id' });
    const snap = await db.ref(`network/fieldtest/${sessionId}`).once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'Field test session not found' });
    res.json(snap.val());
  } catch (error) {
    console.error('[FIELDTEST] load failed:', error);
    res.status(500).json({ error: 'Failed to load field test session' });
  }
});

app.get('/api/v1/fieldtest/sessions', authMiddleware, async (_req, res) => {
  try {
    const snap = await db.ref('network/fieldtest').once('value');
    const sessions = Object.entries(snap.val() || {})
      .map(([sessionId, session]) => ({
        sessionId,
        sessionName: session?.sessionName || sessionId,
        createdAt: session?.createdAt || null,
        updatedAt: session?.updatedAt || null,
        nodeCount: Array.isArray(session?.nodes) ? session.nodes.length : 0,
        linkCount: Array.isArray(session?.links) ? session.links.length : 0
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json({ ok: true, sessions });
  } catch (error) {
    console.error('[FIELDTEST] list failed:', error);
    res.status(500).json({ error: 'Failed to list field test sessions' });
  }
});

// ============================================================
//  FIELD TEST & DIAGNOSTICS (admin only)
// ============================================================
app.get('/api/diagnostics/battery-log', authMiddleware, async (req, res) => {
  const vehicleId = sanitizeHistoryVehicleId(req.query.vehicleId || req.query.vehicle_id);
  const range = normalizeDiagnosticsDateRange(req.query, 120);
  const intervalMin = Math.max(1, Math.min(1440, Number.parseInt(req.query.interval || '60', 10) || 60));
  if (!vehicleId) return res.status(400).json({ error: 'vehicleId is required' });
  if (range.tooLong) return res.status(400).json({ error: `Battery diagnostics range is limited to ${range.maxDays} days` });

  try {
    const rowsByDate = await Promise.all(range.dates.map(date => loadDiagnosticRows(vehicleId, date)));
    const rows = rowsByDate.flat();
    const multiDay = range.dates.length > 1;
    const bucketMs = intervalMin * 60 * 1000;
    const buckets = new Map();
    rows.forEach(row => {
      const battery = normalizeBatteryPercent(row.record);
      const battVoltage = normalizeBatteryVoltage(row.record);
      if (battery === null && battVoltage === null) return;
      const bucket = Math.floor((row.ts * 1000) / bucketMs) * bucketMs;
      buckets.set(bucket, {
        ts: row.ts,
        date: row.date,
        time: multiDay ? `${row.date} ${row.time.slice(0, 5)}` : row.time,
        battery,
        battVoltage,
      });
    });

    const samples = [...buckets.values()].sort((a, b) => a.ts - b.ts);
    const batteries = samples.filter(sample => sample.battery !== null);
    const startPct = batteries[0]?.battery ?? null;
    const endPct = batteries[batteries.length - 1]?.battery ?? null;
    const durationHours = batteries.length > 1
      ? Math.max(0, (batteries[batteries.length - 1].ts - batteries[0].ts) / 3600)
      : 0;
    const dropPerHour = startPct !== null && endPct !== null && durationHours > 0
      ? Math.max(0, (startPct - endPct) / durationHours)
      : null;

    return res.json({
      vehicleId,
      date: range.startDate === range.endDate ? range.startDate : `${range.startDate}..${range.endDate}`,
      startDate: range.startDate,
      endDate: range.endDate,
      days: range.dates.length,
      interval_min: intervalMin,
      samples,
      summary: {
        startPct,
        endPct,
        durationHours: Number(durationHours.toFixed(2)),
        durationDays: Number((durationHours / 24).toFixed(2)),
        dropPerHour: dropPerHour === null ? null : Number(dropPerHour.toFixed(2)),
        dropPerDay: dropPerHour === null ? null : Number((dropPerHour * 24).toFixed(2)),
        estimatedFullHours: dropPerHour && startPct !== null ? Number((startPct / dropPerHour).toFixed(1)) : null,
        estimatedFullDays: dropPerHour && startPct !== null ? Number((startPct / dropPerHour / 24).toFixed(1)) : null,
        sampleCount: samples.length,
      },
    });
  } catch (error) {
    console.error('[GET /api/diagnostics/battery-log]', error);
    return res.status(500).json({ error: 'Failed to fetch battery diagnostics' });
  }
});

app.get('/api/diagnostics/lora-signal', authMiddleware, async (req, res) => {
  const vehicleId = sanitizeHistoryVehicleId(req.query.vehicleId || req.query.vehicle_id);
  const date = normalizeHistoryDate(req.query.date);
  if (!vehicleId) return res.status(400).json({ error: 'vehicleId is required' });

  try {
    const [rows, configSnap] = await Promise.all([
      loadDiagnosticRows(vehicleId, date),
      db.ref('system/config/groundStation').once('value'),
    ]);
    const groundStation = normalizeGroundStationConfig(configSnap.val() || {});
    const samples = rows
      .map(row => {
        const rssi = finiteNumberOrNull(row.record.rssi ?? row.record.received_rssi);
        if (rssi === null) return null;
        const lat = finiteNumberOrNull(row.record.lat);
        const lng = finiteNumberOrNull(row.record.lng);
        const distanceFromGround = validLatLng(lat, lng)
          ? Math.round(haversineDistanceMeters({ lat, lng }, groundStation))
          : null;
        return {
          ts: row.ts,
          time: row.time,
          rssi,
          snr: finiteNumberOrNull(row.record.snr ?? row.record.received_snr),
          distanceFromGround_m: distanceFromGround,
          hop: finiteNumberOrNull(row.record.hop) ?? 0,
        };
      })
      .filter(Boolean);

    const rssiValues = samples.map(sample => sample.rssi).filter(Number.isFinite);
    const snrValues = samples.map(sample => sample.snr).filter(Number.isFinite);
    const worst = samples.reduce((current, sample) => !current || sample.rssi < current.rssi ? sample : current, null);
    const farthest = samples
      .filter(sample => Number.isFinite(sample.distanceFromGround_m))
      .reduce((current, sample) => !current || sample.distanceFromGround_m > current.distanceFromGround_m ? sample : current, null);

    return res.json({
      vehicleId,
      date,
      groundStation,
      samples,
      summary: {
        totalPackets: rows.length,
        packetsWithRSSI: samples.length,
        pdr: rows.length ? Number(((samples.length / rows.length) * 100).toFixed(1)) : 0,
        avgRSSI: average(rssiValues, 1),
        minRSSI: rssiValues.length ? Math.min(...rssiValues) : null,
        maxRSSI: rssiValues.length ? Math.max(...rssiValues) : null,
        avgSNR: average(snrValues, 1),
        bestDistance_m: farthest?.distanceFromGround_m ?? null,
        worstRSSIDistance_m: worst?.distanceFromGround_m ?? null,
      },
    });
  } catch (error) {
    console.error('[GET /api/diagnostics/lora-signal]', error);
    return res.status(500).json({ error: 'Failed to fetch LoRa diagnostics' });
  }
});

app.post('/api/diagnostics/pdr-test', authMiddleware, async (req, res) => {
  const vehicleId = sanitizeHistoryVehicleId(req.body?.vehicleId || req.body?.vehicle_id);
  const targetPackets = Math.max(1, Math.min(5000, Number.parseInt(req.body?.targetPackets || '100', 10) || 100));
  if (!vehicleId) return res.status(400).json({ error: 'vehicleId is required' });

  try {
    const sessionId = `pdr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const session = {
      sessionId,
      vehicleId,
      label: String(req.body?.label || `PDR ${vehicleId}`).trim().slice(0, 120),
      targetPackets,
      status: 'running',
      startTime: now,
      received: 0,
      pdr: 0,
      pdrSource: 'live_packets',
      createdBy: req.user?.username || req.user?.sub || 'admin',
      createdAt: now,
      updatedAt: now,
    };
    await db.ref(`diagnostics/pdrTests/${sessionId}`).set(session);
    clearPdrSessionCache(vehicleId);
    return res.status(201).json(session);
  } catch (error) {
    console.error('[POST /api/diagnostics/pdr-test]', error);
    return res.status(500).json({ error: 'Failed to start PDR test' });
  }
});

app.get('/api/diagnostics/pdr-test/:sessionId', authMiddleware, async (req, res) => {
  const sessionId = String(req.params.sessionId || '').replace(/[^\w-]/g, '');
  if (!sessionId) return res.status(400).json({ error: 'Invalid session id' });

  try {
    const ref = db.ref(`diagnostics/pdrTests/${sessionId}`);
    const snap = await ref.once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'PDR test session not found' });
    const session = snap.val() || {};
    const progress = await calculatePdrSessionProgress(session);
    const { samples: _samples, ...sessionPublic } = session;
    const payload = {
      ...sessionPublic,
      ...progress,
      updatedAt: Date.now(),
    };
    if (session.status === 'running') {
      await ref.update({
        received: progress.received,
        pdr: progress.pdr,
        avgRSSI: progress.avgRSSI,
        avgSNR: progress.avgSNR,
        elapsed_s: progress.elapsed_s,
        updatedAt: payload.updatedAt,
      });
    }
    return res.json(payload);
  } catch (error) {
    console.error('[GET /api/diagnostics/pdr-test/:sessionId]', error);
    return res.status(500).json({ error: 'Failed to fetch PDR test' });
  }
});

app.post('/api/diagnostics/pdr-test/:sessionId/stop', authMiddleware, async (req, res) => {
  const sessionId = String(req.params.sessionId || '').replace(/[^\w-]/g, '');
  if (!sessionId) return res.status(400).json({ error: 'Invalid session id' });

  try {
    const ref = db.ref(`diagnostics/pdrTests/${sessionId}`);
    const snap = await ref.once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'PDR test session not found' });
    const session = snap.val() || {};
    const endTime = Date.now();
    const progress = await calculatePdrSessionProgress({ ...session, status: 'stopped', endTime });
    const { samples: _samples, ...sessionPublic } = session;
    const update = {
      status: 'stopped',
      endTime,
      ...progress,
      updatedAt: endTime,
    };
    await ref.update(update);
    clearPdrSessionCache(session.vehicleId);
    return res.json({ ...sessionPublic, ...update });
  } catch (error) {
    console.error('[POST /api/diagnostics/pdr-test/:sessionId/stop]', error);
    return res.status(500).json({ error: 'Failed to stop PDR test' });
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'api_not_found' }));
app.use((_req, res) => res.status(404).send('Not found'));

// ── Start ─────────────────────────────────────────────────────────────────────
if (require.main === module) app.listen(PORT, async () => {
  // Seeding is intentionally disabled; use an explicit migration instead.

  // If demoMode is enabled in config, auto-start the simulator
  if (process.env.ENABLE_LEGACY_DEMO_BOOT === 'true') try {
    const demoMode = await getDemoMode();
    if (demoMode && activeDemoIntervalCount() === 0) {
      console.log('🧬 [Boot] Demo Mode is enabled in Firebase and no demo interval is active. Starting simulator...');
      await startDemoFleet();
    } else {
      console.log(`🧬 [Boot] Demo mode=${demoMode} activeIntervals=${activeDemoIntervalCount()}`);
    }
  } catch (err) {
    console.error('🧬 [Boot] Failed to check demo mode on startup:', err);
  }
  
  console.log('\n🚐  Smart Songthaew Tracker — Server Ready');
  console.log(`    User:       http://localhost:${PORT}/`);
  console.log(`    Dashboard:  http://localhost:${PORT}/dashboard.html`);
  console.log(`    Admin:      http://localhost:${PORT}/admin.html`);
  console.log(`    Login:      http://localhost:${PORT}/login.html`);
  console.log(`    Demo start: POST http://localhost:${PORT}/api/demo/start`);
  console.log(`    Config:     GET  http://localhost:${PORT}/api/config\n`);
});

module.exports = app;
