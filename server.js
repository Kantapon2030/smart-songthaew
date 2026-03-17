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

const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');
const path    = require('path');

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
  databaseURL: 'https://smart-songthaew-50aff-default-rtdb.asia-southeast1.firebasedatabase.app',
});

const db = admin.database();

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
app.post('/api/update-location', async (req, res) => {
  const {
    vehicleId,
    lat,
    lng,
    speed       = 0,
    battery     = -1,
    routeId     = 'unassigned',
    direction   = 'unknown',
    // ── Power fields จาก Arduino (ใหม่) ──────────────
    battVoltage = -1,   // แรงดันแบต (mV) จาก ADC A0
    currentMa   = -1,   // กระแสไฟ (mA) วัดจาก INA219/คำนวณ
    powerMw     = -1,   // กำลังไฟ (mW)
    sleepMode   = 0,    // 0=active, 1=light-sleep, 2=deep-sleep cycle
    txCount     = -1,   // จำนวน packet ที่ส่งตั้งแต่ boot
  } = req.body;

  if (!vehicleId) {
    return res.status(400).json({ error: 'vehicleId is required' });
  }

  const latF = parseFloat(lat);
  const lngF = parseFloat(lng);

  if (!validLatLng(latF, lngF)) {
    return res.status(400).json({
      error: 'lat/lng missing or outside Thailand bounds',
      hint:  'lat: 5.5–20.5, lng: 97.5–105.7',
    });
  }

  const spdF  = parseFloat(speed)  || 0;
  const batI  = parseInt(battery, 10) ?? -1;
  const ts    = Date.now();
  const today = todayStr();
  const hour  = new Date().getHours();

  // Power fields
  const batVF  = parseFloat(battVoltage) || -1;
  const currF  = parseFloat(currentMa)   || -1;
  const powF   = parseFloat(powerMw)     || (currF > 0 && batVF > 0 ? parseFloat((currF * batVF / 1000).toFixed(0)) : -1);
  const sleepI = parseInt(sleepMode, 10) || 0;
  const txI    = parseInt(txCount,   10) || -1;

  const data = {
    lat: latF, lng: lngF,
    speed:       parseFloat(spdF.toFixed(1)),
    battery:     batI,
    battVoltage: batVF,    // mV
    currentMa:   currF,    // mA
    powerMw:     powF,     // mW
    sleepMode:   sleepI,
    txCount:     txI,
    timestamp:   ts,
    routeId:     routeId   || 'unassigned',
    direction:   direction || 'unknown',
  };

  try {
    const updates = {};

    // 1. Live current position (overwrite)
    updates[`fleet/${vehicleId}/current`] = data;

    // 2. History แยกตามวัน (key = timestamp ms)
    updates[`history/${today}/${vehicleId}/${ts}`] = data;

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

    console.log(`[GPS] ${vehicleId} | ${latF},${lngF} | ${spdF}km/h | bat:${batI}% | ${batVF}mV | ${currF}mA | sleep:${sleepI} | ${direction}`);

    return res.status(200).json({ message: 'Location & Route updated successfully', timestamp: ts });

  } catch (err) {
    console.error('[POST /api/update-location]', err);
    return res.status(500).json({ error: 'Database error', details: err.message });
  }
});

// ============================================================
//  GET /api/locations
//  [FIX] Endpoint ที่ frontend (app.js, admin.js) เรียกจริง
//  ── ดึงตำแหน่งปัจจุบันของรถทุกคัน พร้อม history structure ──
//  Response: { "ST-01": { current: {...} }, "ST-02": { current: {...} } }
// ============================================================
app.get('/api/locations', async (req, res) => {
  try {
    const snap = await db.ref('fleet').once('value');
    const raw  = snap.val() || {};

    // ส่งโครงสร้าง { vehicleId: { current: {...} } } ตามที่ frontend expect
    const result = {};
    for (const [id, val] of Object.entries(raw)) {
      if (val?.current) {
        result[id] = { current: val.current };
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
//  GET /api/simulate
//  ── DEV ONLY: inject mock GPS สำหรับทดสอบ ──
//  เพิ่ม 2 vehicles วิ่งบนเส้นทาง พรหมคีรี ↔ นครศรีฯ
// ============================================================
const ROUTE_COORDS = [
  [8.432450, 99.959129],
  [8.432796, 99.888032],
  [8.463119, 99.864281],
  [8.508510, 99.827826],
  [8.522536, 99.825067],
];

const SIM_FLEET = {
  'ST-01': { routeId: 'route_nakhon_main', step: 0, dir: 1 },
  'ST-02': { routeId: 'route_nakhon_main', step: 2, dir: -1 },
};

app.get('/api/simulate', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Disabled in production' });
  }

  const today = todayStr();
  const hour  = new Date().getHours();
  const results = {};

  for (const [vehicleId, state] of Object.entries(SIM_FLEET)) {
    const idx  = Math.max(0, Math.min(ROUTE_COORDS.length - 1, state.step));
    const pt   = ROUTE_COORDS[idx];

    const lat  = pt[0] + (Math.random() - 0.5) * 0.001;
    const lng  = pt[1] + (Math.random() - 0.5) * 0.001;
    const ts   = Date.now();
    const dir  = state.dir > 0 ? 'พรหมคีรี' : 'นครศรีธรรมราช';

    // advance step
    state.step += state.dir;
    if (state.step >= ROUTE_COORDS.length) { state.step = ROUTE_COORDS.length - 2; state.dir = -1; }
    if (state.step < 0)                    { state.step = 1;                        state.dir = 1;  }

    const data = {
      lat, lng,
      speed:     Math.round(15 + Math.random() * 35),
      battery:   Math.round(60 + Math.random() * 35),
      timestamp: ts,
      routeId:   state.routeId,
      direction: dir,
    };

    const updates = {};
    updates[`fleet/${vehicleId}/current`]                              = data;
    updates[`history/${today}/${vehicleId}/${ts}`]                     = data;
    updates[`routes_active/${today}/${state.routeId}/${vehicleId}`]    = { lastActive: ts, lat, lng };
    updates[`analytics/peak_hours/${today}/${vehicleId}/${hour}`]      = admin.database.ServerValue.increment(1);
    await db.ref().update(updates);

    results[vehicleId] = data;
  }

  console.log('[SIM] Injected:', Object.keys(results).join(', '));
  return res.status(200).json({ success: true, data: results });
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
      routeName:      cfg.routeName      ?? 'นครศรีธรรมราช ↔ พรหมคีรี',
      offlineTimeout: cfg.offlineTimeout ?? 15,
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
//  DEMO VEHICLES — server-side simulator ที่ Admin ควบคุม
//  POST /api/demo/start  { vehicles: N }
//  POST /api/demo/stop
//  GET  /api/demo/status
// ============================================================
let _demoTimer    = null;
let _demoVehicles = 2;

const DEMO_ROUTE = [
  [8.432450, 99.959129],[8.432796, 99.888032],[8.463119, 99.864281],
  [8.508510, 99.827826],[8.522536, 99.825067],
];
const _demoState = {}; // { id: { lat,lng,targetIdx,dir,speed,targetSpeed,stopTicks,battery } }

function initDemoVehicle(id, startIdx) {
  const t = 0.3 + Math.random() * 0.4;
  const p0 = DEMO_ROUTE[startIdx], p1 = DEMO_ROUTE[startIdx + 1];
  _demoState[id] = {
    lat:         p0[0] + (p1[0]-p0[0])*t,
    lng:         p0[1] + (p1[1]-p0[1])*t,
    targetIdx:   startIdx + 1,
    dir:         startIdx < 2 ? 'พรหมคีรี' : 'นครศรีธรรมราช',
    speed:       30, targetSpeed: 35, stopTicks: 0,
    battery:     Math.floor(70 + Math.random()*25),
  };
}

async function demoTick() {
  const today = todayStr();
  const hour  = new Date().getHours();
  const ids   = Object.keys(_demoState);
  if (!ids.length) return;

  const updates = {};
  for (const id of ids) {
    const v = _demoState[id];

    if (v.stopTicks > 0) {
      v.stopTicks--; v.speed = 0;
    } else {
      if (Math.random() < 0.05) {
        const r = Math.random();
        if (r < 0.15) { v.stopTicks = 5 + Math.floor(Math.random()*15); v.targetSpeed = 0; }
        else if (r < 0.35) v.targetSpeed = 15 + Math.floor(Math.random()*10);
        else v.targetSpeed = 30 + Math.floor(Math.random()*15);
      }
      if (v.speed < v.targetSpeed) v.speed = Math.min(v.speed+3, v.targetSpeed);
      else if (v.speed > v.targetSpeed) v.speed = Math.max(v.speed-3, v.targetSpeed);

      if (v.speed > 0) {
        const tgt = DEMO_ROUTE[v.targetIdx];
        const dLat = tgt[0]-v.lat, dLng = tgt[1]-v.lng;
        const dist = Math.sqrt(dLat*dLat+dLng*dLng);
        const step = (v.speed/3600)/111 * 2;
        if (dist <= step) {
          v.lat = tgt[0]; v.lng = tgt[1];
          v.stopTicks = 10 + Math.floor(Math.random()*20); v.speed = 0;
          if (v.dir === 'พรหมคีรี') {
            v.targetIdx++;
            if (v.targetIdx >= DEMO_ROUTE.length) { v.targetIdx = DEMO_ROUTE.length-2; v.dir = 'นครศรีธรรมราช'; }
          } else {
            v.targetIdx--;
            if (v.targetIdx < 0) { v.targetIdx = 1; v.dir = 'พรหมคีรี'; }
          }
          v.targetSpeed = 30 + Math.floor(Math.random()*15);
        } else {
          v.lat += (dLat/dist)*step; v.lng += (dLng/dist)*step;
        }
      }
    }
    if (Math.random() < 0.02) v.battery--;
    if (v.battery < 10) v.battery = 92;

    const ts = Date.now();
    const data = { lat:v.lat, lng:v.lng, speed:v.speed, battery:v.battery,
      timestamp:ts, routeId:'route_demo', direction:v.dir };

    updates[`fleet/${id}/current`]                        = data;
    updates[`history/${today}/${id}/${ts}`]               = data;
    updates[`analytics/peak_hours/${today}/${id}/${hour}`] = admin.database.ServerValue.increment(1);
  }
  await db.ref().update(updates);
}

app.post('/api/demo/start', async (req, res) => {
  const n = Math.min(Math.max(parseInt(req.body.vehicles ?? 2), 1), 8);
  _demoVehicles = n;

  // ล้าง state เดิม
  Object.keys(_demoState).forEach(k => delete _demoState[k]);
  for (let i = 0; i < n; i++) {
    initDemoVehicle(`DEMO_${i+1}`, i % (DEMO_ROUTE.length-1));
  }

  clearInterval(_demoTimer);
  _demoTimer = setInterval(demoTick, 2000);

  // บันทึก config
  await db.ref('system/config').update({ demoMode:true, demoVehicles:n, updatedAt:Date.now() });
  console.log(`[DEMO] started ${n} vehicles`);
  res.json({ ok:true, vehicles:n, ids:Object.keys(_demoState) });
});

app.post('/api/demo/stop', async (req, res) => {
  clearInterval(_demoTimer); _demoTimer = null;

  // ลบ marker demo ออกจาก Firebase
  const updates = {};
  Object.keys(_demoState).forEach(id => { updates[`fleet/${id}`] = null; });
  if (Object.keys(updates).length) await db.ref().update(updates);
  Object.keys(_demoState).forEach(k => delete _demoState[k]);

  await db.ref('system/config').update({ demoMode:false, updatedAt:Date.now() });
  console.log('[DEMO] stopped');
  res.json({ ok:true });
});

app.get('/api/demo/status', (req, res) => {
  res.json({
    running: _demoTimer !== null,
    vehicles: Object.keys(_demoState).length,
    ids: Object.keys(_demoState),
  });
});


// ── SPA fallback (ต้องอยู่ก่อน app.listen เสมอ) ─────────────────────────────
// [FIX] เดิมอยู่หลัง app.listen() → ไม่ register → unknown path ได้ HTML
// → frontend parse JSON ไม่ได้ → "Unexpected token '<'"
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🚐  Smart Songthaew Tracker — Server Ready');
  console.log(`    User:       http://localhost:${PORT}/`);
  console.log(`    Dashboard:  http://localhost:${PORT}/dashboard.html`);
  console.log(`    Admin:      http://localhost:${PORT}/admin.html`);
  console.log(`    Demo start: POST http://localhost:${PORT}/api/demo/start`);
  console.log(`    Config:     GET  http://localhost:${PORT}/api/config\n`);
});