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
const cors       = require('cors');
const admin      = require('firebase-admin');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');

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

// ── Rate Limiting Store ───────────────────────────────────────────────────────
const rateLimitStore = new Map(); // vehicleId -> lastRequestTime
const RATE_LIMIT_MS = 2000; // 2 seconds between requests

// ── Auth Middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - No token' });
  }
  
  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized - Invalid token' });
  }
}

// ── Rate Limit Middleware ───────────────────────────────────────────────────
function rateLimitMiddleware(req, res, next) {
  const vehicleId = req.body.vehicleId || req.body.vehicle_id || req.query.vehicleId || req.query.vehicle_id;
  if (!vehicleId) return next(); // Skip if no vehicleId
  
  const now = Date.now();
  const lastRequest = rateLimitStore.get(vehicleId);
  
  if (lastRequest && (now - lastRequest) < RATE_LIMIT_MS) {
    return res.status(429).json({ 
      error: 'Too Many Requests', 
      retryAfter: Math.ceil((RATE_LIMIT_MS - (now - lastRequest)) / 1000)
    });
  }
  
  rateLimitStore.set(vehicleId, now);
  next();
}

// ── Initialize Default Data ───────────────────────────────────────────────────
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

    // Check if admin exists
    const adminSnap = await db.ref('system/admin').once('value');
    if (!adminSnap.exists()) {
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      await db.ref('system/admin').set({
        username: 'Admin123',
        passwordHash: hashedPassword,
        createdAt: Date.now()
      });
      console.log('[Init] Default admin created: Admin123 / admin123');
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
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

const LEGACY_SUNSET = '2026-09-30';
const ETA_CACHE_MS = 30 * 1000;
const ETA_SESSION_LIMIT = 10;
const ETA_IP_LIMIT = 60;
const ETA_WINDOW_MS = 60 * 1000;
const etaCache = new Map();
const etaRateLimits = new Map();
const ROUTE_ALIASES = {
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
  if (age <= 15) return 'online';
  if (age <= 60) return 'delayed';
  return 'offline';
}
function legacyHeaders(res, successor) {
  res.set('Deprecation', 'true');
  res.set('Sunset', LEGACY_SUNSET);
  res.set('Link', `<${successor}>; rel="successor-version"`);
}
function logLegacy(req, vehicleId) {
  console.warn(`[LEGACY_USED] endpoint=${req.path} vehicle_id=${vehicleId || '-'} ip=${req.ip}`);
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

function currentForLiveMode(current = {}) {
  if (hasValidGpsFix(current)) return current;
  const { lat, lng, ...withoutCoordinates } = current;
  return withoutCoordinates;
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

function isValidCoord(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number' &&
    lat >= 5.5 && lat <= 20.5 && lng >= 97.5 && lng <= 105.7;
}

function normalizeNetworkNode(vehicleId, data, vehicleMeta, offlineThresholdMs, demoMode) {
  const lat = parseFloat(data.lat);
  const lng = parseFloat(data.lng);
  const validCoord = hasValidGpsFix(data);
  const lastSeen = data.timestamp || 0;
  const routeId = canonicalRouteId(data.routeId || data.route_id || vehicleMeta?.routeId || 'unassigned');
  const isDemo = isDemoVehicle(vehicleId, vehicleMeta) || String(routeId).toLowerCase().includes('demo');
  const isOnline = validCoord && (isDemo && demoMode || Date.now() - lastSeen < offlineThresholdMs);
  const node = {
    id: vehicleId,
    type: 'vehicle',
    vehicle_id: vehicleId,
    lat: validCoord ? lat : null,
    lng: validCoord ? lng : null,
    status: isOnline ? 'online' : 'offline',
    demo: isDemo,
    route_id: routeId,
    direction: data.direction || 'unknown',
    hop: typeof data.hop === 'number' ? data.hop : null,
    last_seen: lastSeen,
    battery: typeof data.battery === 'number' ? data.battery : null,
    speed: typeof data.speed === 'number' ? data.speed : null,
    relay_from: data.relay_from || null,
    relay_chain: Array.isArray(data.relay_chain) ? data.relay_chain : [],
    neighbors: Array.isArray(data.neighbors) ? data.neighbors : [],
    link_quality: typeof data.link_quality === 'number' ? data.link_quality : null,
    rssi: typeof data.rssi === 'number' ? data.rssi : null,
    snr: typeof data.snr === 'number' ? data.snr : null
  };
  if (!demoMode && !validCoord) {
    delete node.lat;
    delete node.lng;
  }
  return node;
}

function buildEstimatedLinks(nodes, groundStation) {
  const links = [];
  const onlineNodes = nodes.filter(n => n.status === 'online' && Number.isFinite(n.lat) && Number.isFinite(n.lng));
  if (onlineNodes.length === 0) return links;

  const sorted = [...onlineNodes].sort((a, b) => {
    const da = haversineDistanceMeters(a, groundStation);
    const db = haversineDistanceMeters(b, groundStation);
    return da - db;
  });

  sorted.forEach((node, idx) => {
    const distToGround = haversineDistanceMeters(node, groundStation);
    if (distToGround <= 15000 || idx === 0) {
      links.push({
        from: node.id,
        to: groundStation.id,
        type: 'direct',
        distance_m: Math.round(distToGround),
        hop: 0,
        status: distToGround < 8000 ? 'good' : distToGround < 12000 ? 'fair' : 'poor',
        source: 'estimated',
        rssi: null, snr: null, latency_ms: null,
        last_seen: node.last_seen
      });
      node._hop = 0;
    } else {
      const nearest = sorted.slice(0, idx).find(n => n._hop !== undefined);
      if (nearest) {
        const distToNearest = haversineDistanceMeters(node, nearest);
        links.push({
          from: node.id,
          to: nearest.id,
          type: 'relay',
          distance_m: Math.round(distToNearest),
          hop: (nearest._hop || 0) + 1,
          status: distToNearest < 8000 ? 'fair' : 'poor',
          source: 'estimated',
          rssi: null, snr: null, latency_ms: null,
          last_seen: node.last_seen
        });
        node._hop = (nearest._hop || 0) + 1;
      }
    }
  });
  return links;
}

function buildRealTelemetryLinks(nodes, groundStation) {
  const links = [];
  nodes.forEach(node => {
    if (node.status !== 'online') return;
    if (node.relay_from) {
      const dist = Number.isFinite(node.lat) && Number.isFinite(node.lng)
        ? haversineDistanceMeters(node, groundStation)
        : null;
      links.push({
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
    } else if (Number.isFinite(node.lat) && Number.isFinite(node.lng)) {
      const distToGround = haversineDistanceMeters(node, groundStation);
      links.push({
        from: node.id,
        to: groundStation.id,
        type: 'direct',
        distance_m: Math.round(distToGround),
        hop: 0,
        status: 'good',
        source: 'telemetry',
        rssi: node.rssi, snr: node.snr, latency_ms: null,
        last_seen: node.last_seen
      });
    }
  });
  return links;
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
  } = req.body;

  // Optional VIBE Mesh fields (backward-compatible)
  const hop = typeof req.body.hop === 'number' ? req.body.hop : null;
  const relay_from = req.body.relay_from || null;
  const relay_chain = Array.isArray(req.body.relay_chain) ? req.body.relay_chain : [];
  const neighbors = Array.isArray(req.body.neighbors) ? req.body.neighbors : [];
  const link_quality = typeof req.body.link_quality === 'number' ? req.body.link_quality : null;
  const snr = typeof req.body.snr === 'number' ? req.body.snr : null;
  const seq = typeof req.body.seq === 'number' ? req.body.seq : null;
  const boot_id = req.body.boot_id || null;
  const packet_id = req.body.packet_id || null;

  if (!vehicleId) {
    return res.status(400).json({ error: 'vehicleId is required' });
  }

  const latF = parseFloat(lat);
  const lngF = parseFloat(lng);

  const hasValidGPS = validLatLng(latF, lngF);
  // ถ้า lat/lng ไม่ valid (เช่น 0,0 ตอนยังไม่ fix)
  // ยังรับ packet ได้ แต่ไม่อัปเดตพิกัด — เพื่อให้ timestamp + battery อัปเดต
  // frontend จะรู้ว่า online อยู่แต่ยังไม่มี GPS fix

  const spdF  = parseFloat(speed)  || 0;
  const batI  = parseInt(battery, 10) ?? -1;
  const ts    = Date.now();
  const today = todayStr();
  const hour  = new Date().getHours();

  // Power fields
  const batVF  = parseFloat(battVoltage) || -1;
  const currF  = parseFloat(currentMa)   || -1;
  const powF   = parseFloat(powerMw)     || (currF > 0 && batVF > 0 ? parseFloat((currF * batVF / 1000).toFixed(0)) : -1);
  const txI    = parseInt(txCount,   10) || -1;
  const satsI  = parseInt(sats,      10) ?? -1;  // จำนวนดาวเทียมจริง
  const hdopF  = parseFloat(hdop)        || -1;  // HDOP จริง
  const rssiI  = rssi !== null ? parseInt(rssi, 10) : null; // RSSI dBm จริง

  const data = {
    // ถ้าไม่มี GPS fix ยังคง lat/lng เดิมใน Firebase (ไม่ส่ง 0,0 ทับ)
    ...(hasValidGPS ? { lat: latF, lng: lngF } : {}),
    speed:       hasValidGPS ? parseFloat(spdF.toFixed(1)) : 0,
    battery:     batI,
    battVoltage: batVF,    // mV
    currentMa:   currF,    // mA
    powerMw:     powF,     // mW
    txCount:     txI,
    sats:        satsI,   // จำนวนดาวเทียมจริงจาก GPS
    hdop:        hdopF,   // HDOP จริงจาก GPS
    rssi:        rssiI,   // WiFi RSSI dBm จริง
    timestamp:   ts,
    routeId:     routeId   || 'unassigned',
    direction:   direction || 'unknown',
  };

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

  try {
    const updates = {};

    // 1. Live current position (overwrite)
    updates[`fleet/${vehicleId}/current`] = data;

    // 2. History แยกตามวัน — เก็บเฉพาะเมื่อมี GPS fix จริง
    if (hasValidGPS) updates[`history/${today}/${vehicleId}/${ts}`] = data;

    // 3. Routes active
    if (routeId && routeId !== 'unassigned') {
      updates[`routes_active/${today}/${routeId}/${vehicleId}`] = {
        lastActive: ts, lat: latF, lng: lngF,
      };
    }

    // 4. Peak-hours counter (atomic increment)
    updates[`analytics/peak_hours/${today}/${vehicleId}/${hour}`] =
      admin.database.ServerValue.increment(1);

    await db.ref().update(updates);

    const gpsStatus = hasValidGPS ? `${latF},${lngF}` : 'no-fix';
  console.log(`[GPS] ${vehicleId} | ${gpsStatus} | ${spdF}km/h | bat:${batI}% | ${batVF}mV | ${currF}mA | sats:${satsI} | hdop:${hdopF} | rssi:${rssiI} | ${direction}`);

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
    const [fleetSnap, demoMode] = await Promise.all([db.ref('fleet').once('value'), getDemoMode()]);
    const raw = fleetSnap.val() || {};

    const result = {};
    for (const [id, val] of Object.entries(raw)) {
      // TWIN_ / DEMO_ เสมอส่ง — ไม่ต้อง filter ด้วย routeId
      if (!demoMode && isDemoVehicle(id, val)) continue;
      if (routeId && canonicalRouteId(val.routeId) !== canonicalRouteId(routeId) && !isDemoVehicle(id, val)) continue;
      if (val?.current) {
        result[id] = { current: demoMode ? val.current : currentForLiveMode(val.current), routeId: val.routeId, type: val.type };
      }
    }

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
    const lat = Number(req.body.lat), lng = Number(req.body.lng);
    const hasCoordinates = gpsFix && validLatLng(lat, lng);
    const currentRef = db.ref(`fleet/${vehicleId}/current`);
    const previous = (await currentRef.once('value')).val();
    const packet = { boot_id: bootId, seq, gps_time: validGpsTime(gpsTime, receivedAt) ? gpsTime : null, gps_fix: gpsFix };
    const decision = telemetryDecision(previous, packet);
    if (!decision.accepted) return res.json({ ok: true, status: 'ignored', reason: decision.reason });

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
    };
    const updates = { [`fleet/${vehicleId}/current`]: current, [`fleet/${vehicleId}/routeId`]: routeId };
    if (hasCoordinates) {
      const historyKey = Date.now();
      updates[`history/${todayStr()}/${vehicleId}/${historyKey}`] = current;
      updates[`routes_active/${todayStr()}/${routeId}/${vehicleId}`] = { lastActive: receivedAt * 1000, lat, lng };
      updates[`analytics/peak_hours/${todayStr()}/${vehicleId}/${new Date().getHours()}`] = admin.database.ServerValue.increment(1);
    }
    await db.ref().update(updates);
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
          const h = new Date(rec.timestamp).getHours();
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
          if (rec?.timestamp) totals[new Date(rec.timestamp).getHours()]++;
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
      offlineTimeout: (cfg.offlineTimeout && cfg.offlineTimeout >= 30) ? cfg.offlineTimeout : 30,
      announcement:   cfg.announcement  ?? '',
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
    patch.updatedAt = Date.now();
    await db.ref('system/config').update(patch);
    console.log('[CONFIG]', patch);
    return res.json({ ok: true, config: patch });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Demo fleet simulation
function bearingCalc(la1,lo1,la2,lo2){
  const dO=(lo2-lo1)*Math.PI/180;
  const y=Math.sin(dO)*Math.cos(la2*Math.PI/180);
  const x=Math.cos(la1*Math.PI/180)*Math.sin(la2*Math.PI/180)-Math.sin(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.cos(dO);
  return((Math.atan2(y,x)*180/Math.PI)+360)%360;
}
const DEMO_IDS = ['DEMO_1', 'DEMO_2', 'DEMO_3'];
let _demoTimer = null;
let _demoRouteId = 'route_nakhon_phromkhiri';
let demoRouteCoords = [];
let _demoRouteCoordFormat = 'unknown';
let _demoSpeedMultiplier = 1;
let _demoVehicles = new Map();

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

function initializeDemoFleet() {
  const len = demoRouteCoords.length;
  const indices = [
    0,
    Math.floor(len / 3),
    Math.floor((2 * len) / 3)
  ];
  _demoVehicles = new Map(indices.map((idx, index) => [
    DEMO_IDS[index],
    {
      id: DEMO_IDS[index],
      segmentIndex: Math.max(0, Math.min(len - 1, idx)),
      speed: [34, 43, 55][index],
      battery: [93, 86, 79][index],
    }
  ]));
}

function moveDemoVehicle(vehicleId, timestamp, updates) {
  const vehicle = _demoVehicles.get(vehicleId);
  if (!vehicle || !demoRouteCoords.length) return null;
  const currentIndex = vehicle.segmentIndex;
  const coord = demoRouteCoords[currentIndex];
  const nextCoord = demoRouteCoords[(currentIndex + 1) % demoRouteCoords.length];
  const speed = Math.round((30 + Math.random() * 25) * _demoSpeedMultiplier);
  vehicle.speed = Math.max(30, Math.min(55, speed));
  vehicle.battery = Math.max(20, Number((vehicle.battery - 0.015).toFixed(2)));

  const current = {
    vehicle_id: vehicleId,
    lat: coord.lat,
    lng: coord.lng,
    speed: vehicle.speed,
    battery: Number(vehicle.battery.toFixed(1)),
    bearing: bearingCalc(coord.lat, coord.lng, nextCoord.lat, nextCoord.lng),
    timestamp,
    server_received_at: Math.floor(timestamp / 1000),
    last_seen: Math.floor(timestamp / 1000),
    gps_fix: true,
    routeId: _demoRouteId,
    route_id: _demoRouteId,
    direction: 'ตามเส้นทางเดโม',
    demo: true,
    source: 'demo',
  };

  updates[`fleet/${vehicleId}/current`] = current;
  updates[`fleet/${vehicleId}/routeId`] = _demoRouteId;
  updates[`fleet/${vehicleId}/type`] = 'demo';
  updates[`fleet/${vehicleId}/demo`] = true;
  updates[`history/${todayStr()}/${vehicleId}/${timestamp}`] = current;
  updates[`analytics/peak_hours/${todayStr()}/${vehicleId}/${new Date().getHours()}`] = admin.database.ServerValue.increment(1);
  vehicle.segmentIndex = (currentIndex + 1) % demoRouteCoords.length;
  return current;
}

async function stopDemoFleet() {
  clearInterval(_demoTimer); _demoTimer = null; _demoVehicles = new Map();
  const cleanup = { 'fleet/TWIN_01': null };
  DEMO_IDS.forEach(id => { cleanup[`fleet/${id}`] = null; });
  await db.ref().update(cleanup);
}

async function demoFleetTick() {
  if (!await getDemoMode()) { await stopDemoFleet(); return; }
  const timestamp = Date.now();
  const updates = {};
  DEMO_IDS.forEach(vehicleId => moveDemoVehicle(vehicleId, timestamp, updates));
  await db.ref().update(updates);
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

function selectDemoRoute(routes, requestedRouteId, configuredRouteId) {
  const entries = Object.entries(routes || {});
  const preferredIds = [requestedRouteId, configuredRouteId, _demoRouteId].filter(Boolean);
  for (const routeId of preferredIds) {
    const canonical = canonicalRouteId(routeId);
    const found = entries.find(([id, route]) =>
      id === routeId ||
      route.routeId === routeId ||
      route.route_id === routeId ||
      canonicalRouteId(id) === canonical ||
      canonicalRouteId(route.routeId || route.route_id) === canonical
    );
    if (found) return found;
  }
  return entries.find(([, route]) => Array.isArray(route?.coords) && route.coords.length > 0);
}

async function startDemoFleet(requestedRouteId = null) {
  const [routesSnap, configSnap] = await Promise.all([
    db.ref('routes').once('value'),
    db.ref('system/config').once('value'),
  ]);
  const routes = routesSnap.val() || {};
  const config = configSnap.val() || {};
  const selected = selectDemoRoute(routes, requestedRouteId || config.demoRouteId, config.demoRouteId);
  if (!selected) {
    console.error('[DEMO] Cannot start: no route with coords found in Firebase routes');
    throw new Error('No route with coords found for demo');
  }
  const [routeKey, route] = selected;
  const normalized = normalizeDemoRouteCoords(route.coords || []);
  if (!normalized.coords.length) {
    console.error(`[DEMO] Cannot start: route ${routeKey} has no valid coords`);
    throw new Error(`Route ${routeKey} has no valid coords`);
  }
  demoRouteCoords = normalized.coords;
  _demoRouteCoordFormat = normalized.format;
  _demoRouteId = route.route_id || route.routeId || routeKey;
  console.log(`[DEMO] route=${_demoRouteId} coords=${demoRouteCoords.length} format=${_demoRouteCoordFormat}`);
  await db.ref('system/config').update({ demoMode: true, demoVehicles: 3, demoRouteId: _demoRouteId, demoSpeed: _demoSpeedMultiplier, updatedAt: Date.now() });
  initializeDemoFleet();
  clearInterval(_demoTimer);
  _demoTimer = setInterval(demoFleetTick, 3000);
  await demoFleetTick();
}

app.post('/api/demo/start', authMiddleware, async (req,res)=>{
  try {
    await startDemoFleet(req.body?.routeId || req.body?.route_id || null);
    return res.json({ ok: true, vehicles: 3, routeId: _demoRouteId, ids: DEMO_IDS, coords: demoRouteCoords.length, coordFormat: _demoRouteCoordFormat });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/demo/speed', authMiddleware, async (req,res)=>{
  const speed=parseFloat(req.body.speed);
  if(!isNaN(speed)&&speed>0&&speed<=10){
    _demoSpeedMultiplier=speed;
    await db.ref('system/config').update({demoSpeed:speed,updatedAt:Date.now()});
    return res.json({ok:true,speed});
  }
  res.status(400).json({error:'Invalid speed'});
});

app.post('/api/demo/stop', authMiddleware, async (req,res)=>{
  await db.ref('system/config').update({demoMode:false,updatedAt:Date.now()});
  await stopDemoFleet();
  return res.json({ok:true});
});

app.get('/api/demo/status', async (req,res)=>{
  try {
    const demoMode = await getDemoMode();
    return res.json({ running: demoMode && _demoTimer !== null, demoMode, vehicles: DEMO_IDS, ids: DEMO_IDS });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read demo status' });
  }
});

// ============================================================
//  AUTHENTICATION APIs
// ============================================================

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  try {
    const adminSnap = await db.ref('system/admin').once('value');
    const admin = adminSnap.val();
    
    if (!admin) {
      return res.status(500).json({ error: 'Admin not configured' });
    }
    
    // Check username (case-insensitive for username)
    if (username.toLowerCase() !== admin.username.toLowerCase()) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Check password
    const valid = bcrypt.compareSync(password, admin.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Generate JWT
    const token = jwt.sign(
      { username: admin.username, role: 'admin' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );
    
    res.json({ ok: true, token, username: admin.username });
  } catch (e) {
    console.error('[Auth Login Error]', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/verify - Check if token is still valid
app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// ============================================================
//  ROUTE MANAGEMENT APIs (Protected)
// ============================================================

// GET /api/routes - List all routes
app.get('/api/routes', async (req, res) => {
  try {
    const snap = await db.ref('routes').once('value');
    const routes = snap.val() || {};
    
    // Add vehicle count to each route
    const fleetSnap = await db.ref('fleet').once('value');
    const fleet = fleetSnap.val() || {};
    
    const result = {};
    for (const [id, route] of Object.entries(routes)) {
      const vehicleCount = Object.values(fleet).filter(v => v.routeId === id).length;
      result[id] = { ...route, vehicleCount };
    }
    
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch routes' });
  }
});

// POST /api/routes - Create new route (admin only)
app.post('/api/routes', authMiddleware, async (req, res) => {
  const { name, description, coords, stops } = req.body;
  
  if (!name || !coords || !Array.isArray(coords)) {
    return res.status(400).json({ error: 'Name and coords array required' });
  }
  
  try {
    const routeId = 'route_' + Date.now();
    const route = {
      name,
      description: description || '',
      coords,
      stops: stops || [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    
    await db.ref(`routes/${routeId}`).set(route);
    res.json({ ok: true, routeId, route });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create route' });
  }
});

// DELETE /api/routes/:id - Delete route (admin only)
app.delete('/api/routes/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  
  try {
    // Unassign all vehicles from this route
    const fleetSnap = await db.ref('fleet').once('value');
    const fleet = fleetSnap.val() || {};
    
    const updates = {};
    for (const [vid, v] of Object.entries(fleet)) {
      if (v.routeId === id) {
        updates[`fleet/${vid}/routeId`] = null;
      }
    }
    
    // Delete route
    updates[`routes/${id}`] = null;
    
    await db.ref().update(updates);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete route' });
  }
});

// PATCH /api/routes/:id - Edit route (admin only)
app.patch('/api/routes/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { name, description, coords, stops } = req.body;

  try {
    const snap = await db.ref(`routes/${id}`).once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'Route not found' });

    const patch = { updatedAt: Date.now() };
    if (name)        patch.name        = name;
    if (description !== undefined) patch.description = description;
    if (coords)      patch.coords      = coords;
    if (stops)       patch.stops       = stops;

    await db.ref(`routes/${id}`).update(patch);
    console.log(`[ROUTE] Updated ${id}:`, Object.keys(patch));
    res.json({ ok: true, routeId: id });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update route' });
  }
});

// DELETE /api/routes/:id - Delete route (admin only)
app.delete('/api/routes/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    // Unassign all vehicles from this route
    const fleetSnap = await db.ref('fleet').once('value');
    const fleet = fleetSnap.val() || {};

    const updates = {};
    for (const [vid, v] of Object.entries(fleet)) {
      if (v.routeId === id) {
        updates[`fleet/${vid}/routeId`] = 'unassigned';
      }
    }

    // Delete route
    updates[`routes/${id}`] = null;

    await db.ref().update(updates);
    console.log(`[ROUTE] Deleted route ${id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete route' });
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
app.get('/api/fleet', async (req, res) => {
  try {
    const [fleetSnap, demoMode] = await Promise.all([db.ref('fleet').once('value'), getDemoMode()]);
    const fleet = fleetSnap.val() || {};
    const result = {};
    for (const [id, v] of Object.entries(fleet)) {
      if (!demoMode && isDemoVehicle(id, v)) continue;
      const current = v.current && !demoMode ? currentForLiveMode(v.current) : v.current;
      result[id] = {
        vehicleId:  id,
        routeId:    v.routeId || 'unassigned',
        type:       v.type || 'real',
        assignedAt: v.assignedAt || null,
        current: current ? {
          ...(current.lat !== undefined ? { lat: current.lat } : {}),
          ...(current.lng !== undefined ? { lng: current.lng } : {}),
          speed:     current.speed,
          battery:   current.battery,
          timestamp: current.timestamp,
        } : null,
      };
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch fleet' });
  }
});

app.post('/api/fleet/register', authMiddleware, async (req, res) => {
  const { vehicleId, routeId = 'unassigned', description = '', type = 'real' } = req.body;
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
app.get('/api/v1/network', async (req, res) => {
  try {
    const { route_id, direction, online_only } = req.query;
    const [fleetSnap, configSnap] = await Promise.all([
      db.ref('fleet').once('value'),
      db.ref('system/config').once('value')
    ]);
    const fleetData = fleetSnap.val() || {};
    const sysConfig = configSnap.val() || {};
    const demoMode = sysConfig.demoMode === true;
    const configuredGroundStation = sysConfig.groundStation || {};
    const configuredLat = Number(configuredGroundStation.lat);
    const configuredLng = Number(configuredGroundStation.lng);
    const groundStation = {
      id: 'GROUND_01',
      type: 'ground_station',
      lat: configuredGroundStation.lat != null && configuredGroundStation.lat !== '' && Number.isFinite(configuredLat) ? configuredLat : 8.4304,
      lng: configuredGroundStation.lng != null && configuredGroundStation.lng !== '' && Number.isFinite(configuredLng) ? configuredLng : 99.9631,
      status: 'online',
      label: configuredGroundStation.label || 'Ground Station'
    };
    const offlineTimeoutMs = (sysConfig.offlineTimeout || 300) * 1000;
    const nodes = Object.entries(fleetData)
      .filter(([vehicleId, vehicleData]) => demoMode || !isDemoVehicle(vehicleId, vehicleData))
      .map(([vehicleId, vehicleData]) => normalizeNetworkNode(vehicleId, vehicleData.current || {}, vehicleData, offlineTimeoutMs, demoMode))
      .filter(node => !route_id || route_id === 'all' || node.route_id === canonicalRouteId(route_id))
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
    res.json({
      server_time: Date.now(),
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
    });
  } catch (error) {
    console.error('[/api/v1/network]', error);
    res.status(500).json({ error: 'network_error' });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  // Initialize default data
  await initializeDefaultData();

  // If demoMode is enabled in config, auto-start the simulator
  try {
    const demoMode = await getDemoMode();
    if (demoMode) {
      console.log('🧬 [Boot] Demo Mode is enabled in Firebase. Starting simulator...');
      await startDemoFleet();
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
