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
const JWT_SECRET = process.env.JWT_SECRET || 'smart-songthaew-secret-key-change-in-production';
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
  const vehicleId = req.body.vehicleId || req.query.vehicleId;
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
    // Check if admin exists
    const adminSnap = await db.ref('system/admin').once('value');
    if (!adminSnap.exists()) {
      // Create default admin
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
      // Create default route
      const defaultRoute = {
        name: 'โรงเรียนเตรียมอุดมศึกษาภาคใต้ ↔ เซ็นทรัลนครศรีธรรมราช',
        description: 'เส้นทางหลัก นครศรีธรรมราช',
        coords: [
          [8.432450, 99.959129],
          [8.435500, 99.960500],
          [8.440000, 99.962000],
          [8.445000, 99.965000],
          [8.452000, 99.968000],
          [8.460000, 99.971000],
          [8.467100, 99.974300]
        ],
        stops: [
          { name: 'โรงเรียนเตรียมอุดมศึกษาภาคใต้', lat: 8.432450, lng: 99.959129 },
          { name: 'ถนนปั้นน้ำ', lat: 8.435500, lng: 99.960500 },
          { name: 'แยกพรหมคีรี', lat: 8.440000, lng: 99.962000 },
          { name: 'ถนนราชดำเนิน', lat: 8.445000, lng: 99.965000 },
          { name: 'วงเวียนนาคร', lat: 8.452000, lng: 99.968000 },
          { name: 'ถนนมหาราช', lat: 8.460000, lng: 99.971000 },
          { name: 'เซ็นทรัลนครศรีธรรมราช', lat: 8.467100, lng: 99.974300 }
        ],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await db.ref('routes/route_nakhon_01').set(defaultRoute);
      console.log('[Init] Default route created');
    }
  } catch (e) {
    console.error('[Init] Error:', e);
  }
}

// ── Express ───────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

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

// ============================================================
//  POST /api/update-location
//  ── รับข้อมูล GPS จาก ESP8266 ──
//  [FIX] รวม 2 duplicate route เป็น 1 เดียว
//
//  Body: { vehicleId, lat, lng, speed?, battery?, routeId?, direction? }
// ============================================================
app.post('/api/update-location', rateLimitMiddleware, async (req, res) => {
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
  try {
    const { routeId } = req.query;
    const snap = await db.ref('fleet').once('value');
    const raw  = snap.val() || {};

    // ส่งโครงสร้าง { vehicleId: { current: {...} } } ตามที่ frontend expect
    const result = {};
    for (const [id, val] of Object.entries(raw)) {
      // Filter by routeId if specified
      if (routeId && val.routeId !== routeId) continue;
      
      if (val?.current) {
        result[id] = { current: val.current, routeId: val.routeId, type: val.type };
      }
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('[GET /api/locations]', err);
    return res.status(500).json({ error: 'Failed to fetch locations' });
  }
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
      demoVehicles:   cfg.demoVehicles   ?? 2,
      routeName:      cfg.routeName      ?? 'Siam Square ↔ แยก Rama IV (ถ.อังรีดูนัง)',
      offlineTimeout: (cfg.offlineTimeout && cfg.offlineTimeout >= 30) ? cfg.offlineTimeout : 30,
      announcement:   cfg.announcement  ?? '',
      updatedAt:      cfg.updatedAt      ?? null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/config', async (req, res) => {
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

// ============================================================
//  DIGITAL TWIN — Single Vehicle (TWIN_01) Simulation
//  POST /api/demo/start   ← เริ่ม Twin
//  POST /api/demo/stop    ← หยุด Twin
//  POST /api/demo/speed   ← ปรับความเร็ว
//  GET  /api/demo/status  ← สถานะ
// ============================================================
let _twinTimer = null;
let _twinSpeedMultiplier = 1;
let _twinRouteId = 'unassigned';
let _twinRoute = [
  [8.432450,99.959129],[8.435500,99.960500],[8.440000,99.962000],
  [8.445000,99.965000],[8.452000,99.968000],[8.460000,99.971000],[8.467100,99.974300],
];
const _twin = {
  lat:0, lng:0, speed:0, targetSpeed:35, bearing:0,
  segIdx:0, segProgress:0, dir:'south', battery:85, stopTicks:0,
};
let _twinActive = false;

function bearingCalc(la1,lo1,la2,lo2){
  const dO=(lo2-lo1)*Math.PI/180;
  const y=Math.sin(dO)*Math.cos(la2*Math.PI/180);
  const x=Math.cos(la1*Math.PI/180)*Math.sin(la2*Math.PI/180)-Math.sin(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.cos(dO);
  return((Math.atan2(y,x)*180/Math.PI)+360)%360;
}

function initTwin(){
  const R=_twinRoute;
  _twin.lat=R[0][0]; _twin.lng=R[0][1];
  _twin.segIdx=0; _twin.segProgress=0;
  _twin.dir='south'; _twin.speed=0; _twin.targetSpeed=35;
  _twin.battery=85; _twin.stopTicks=0;
  _twin.bearing=bearingCalc(R[0][0],R[0][1],R[1][0],R[1][1]);
  _twinActive=true;
}

async function twinTick(){
  if(!_twinActive) return;
  const R=_twinRoute;
  const v=_twin;
  const today=todayStr(), hour=new Date().getHours();

  // Speed ramp
  if(v.stopTicks>0){v.stopTicks--;v.speed=0;}
  else{
    if(Math.random()<0.008){v.stopTicks=2+Math.floor(Math.random()*3);v.targetSpeed=0;}
    else if(Math.random()<0.05) v.targetSpeed=20+Math.floor(Math.random()*30);
    if(v.speed<v.targetSpeed) v.speed=Math.min(v.speed+2,v.targetSpeed);
    else if(v.speed>v.targetSpeed) v.speed=Math.max(v.speed-2,v.targetSpeed);
  }

  // Move along segments
  if(v.speed>0 && R.length>=2){
    const stepDeg=(v.speed/3600)/111*2*_twinSpeedMultiplier;
    let remaining=stepDeg;
    while(remaining>0 && v.segIdx<R.length-1){
      const s=v.dir==='south'?v.segIdx:R.length-1-v.segIdx;
      const e=v.dir==='south'?v.segIdx+1:R.length-2-v.segIdx;
      if(s<0||s>=R.length||e<0||e>=R.length){v.segIdx=0;break;}
      const p0=R[s],p1=R[e];
      const dLat=p1[0]-p0[0],dLng=p1[1]-p0[1];
      const segLen=Math.sqrt(dLat*dLat+dLng*dLng);
      if(segLen<1e-9){v.segIdx++;continue;}
      const left=segLen*(1-v.segProgress);
      if(remaining>=left){
        remaining-=left; v.segIdx++; v.segProgress=0;
        if(v.segIdx>=R.length-1){v.segIdx=0;v.dir=v.dir==='south'?'north':'south';}
      }else{
        v.segProgress+=remaining/segLen; remaining=0;
      }
    }
    // Interpolate position
    const si=v.dir==='south'?v.segIdx:R.length-1-v.segIdx;
    const ei=v.dir==='south'?Math.min(v.segIdx+1,R.length-1):Math.max(R.length-2-v.segIdx,0);
    const t=v.segProgress;
    v.lat=R[si][0]+(R[ei][0]-R[si][0])*t;
    v.lng=R[si][1]+(R[ei][1]-R[si][1])*t;
    v.bearing=bearingCalc(R[si][0],R[si][1],R[ei][0],R[ei][1]);
  }

  if(Math.random()<0.02)v.battery--;
  if(v.battery<10)v.battery=92;

  // Direction label
  let dirLabel='ปลายทาง';
  try{
    const rSnap=await db.ref(`routes/${_twinRouteId}`).once('value');
    const rInfo=rSnap.val();
    const stops=rInfo?.stops||[];
    dirLabel=v.dir==='south'?(stops[stops.length-1]?.name||'ปลายทาง'):(stops[0]?.name||'ต้นทาง');
  }catch(_){}

  const ts=Date.now();
  const data={lat:v.lat,lng:v.lng,speed:v.speed,bearing:v.bearing,battery:v.battery,timestamp:ts,routeId:_twinRouteId,direction:dirLabel};
  const updates={};
  updates['fleet/TWIN_01/current']=data;
  updates[`history/${today}/TWIN_01/${ts}`]=data;
  updates[`analytics/peak_hours/${today}/TWIN_01/${hour}`]=admin.database.ServerValue.increment(1);
  await db.ref().update(updates);
}

app.post('/api/demo/start', async (req,res)=>{
  const routeId=req.body.routeId||null;
  try{
    if(routeId){
      const snap=await db.ref(`routes/${routeId}`).once('value');
      const r=snap.val();
      if(r?.coords?.length>=2){_twinRoute=r.coords;_twinRouteId=routeId;}
    }else{
      const snap=await db.ref('routes').limitToFirst(1).once('value');
      const routes=snap.val()||{};
      const fid=Object.keys(routes)[0];
      if(fid&&routes[fid]?.coords?.length>=2){_twinRoute=routes[fid].coords;_twinRouteId=fid;}
    }
  }catch(e){console.warn('[TWIN]',e.message);}

  initTwin();
  clearInterval(_twinTimer);
  _twinTimer=setInterval(twinTick,2000);
  await db.ref('system/config').update({demoMode:true,demoVehicles:1,demoRouteId:_twinRouteId,demoSpeed:_twinSpeedMultiplier,updatedAt:Date.now()});
  console.log(`[TWIN] started on route ${_twinRouteId}`);
  res.json({ok:true,vehicles:1,routeId:_twinRouteId,ids:['TWIN_01']});
});

app.post('/api/demo/speed', async (req,res)=>{
  const speed=parseFloat(req.body.speed);
  if(!isNaN(speed)&&speed>0&&speed<=10){
    _twinSpeedMultiplier=speed;
    await db.ref('system/config').update({demoSpeed:speed,updatedAt:Date.now()});
    res.json({ok:true,speed});
  }else res.status(400).json({error:'Invalid speed'});
});

app.post('/api/demo/stop', async (req,res)=>{
  clearInterval(_twinTimer);_twinTimer=null;_twinActive=false;
  await db.ref('fleet/TWIN_01').remove();
  await db.ref('system/config').update({demoMode:false,updatedAt:Date.now()});
  console.log('[TWIN] stopped');
  res.json({ok:true});
});

app.get('/api/demo/status', (req,res)=>{
  res.json({running:_twinTimer!==null,vehicles:_twinActive?1:0,ids:_twinActive?['TWIN_01']:[]});
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
    const snap  = await db.ref('fleet').once('value');
    const fleet = snap.val() || {};
    const result = {};
    for (const [id, v] of Object.entries(fleet)) {
      result[id] = {
        vehicleId:  id,
        routeId:    v.routeId || 'unassigned',
        type:       v.type || 'real',
        assignedAt: v.assignedAt || null,
        current: v.current ? {
          lat:       v.current.lat,
          lng:       v.current.lng,
          speed:     v.current.speed,
          battery:   v.current.battery,
          timestamp: v.current.timestamp,
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
app.post('/api/admin/purge-ghosts', async (req, res) => {
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
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  // Initialize default data
  await initializeDefaultData();
  
  console.log('\n🚐  Smart Songthaew Tracker — Server Ready');
  console.log(`    User:       http://localhost:${PORT}/`);
  console.log(`    Dashboard:  http://localhost:${PORT}/dashboard.html`);
  console.log(`    Admin:      http://localhost:${PORT}/admin.html`);
  console.log(`    Login:      http://localhost:${PORT}/login.html`);
  console.log(`    Demo start: POST http://localhost:${PORT}/api/demo/start`);
  console.log(`    Config:     GET  http://localhost:${PORT}/api/config\n`);
});