/**
 * shared.js — ค่ากลางที่ทุกหน้าใช้ร่วมกัน
 * โหลดไฟล์นี้ก่อนหน้า page-specific script เสมอ
 */
'use strict';

// ── Route ─────────────────────────────────────────────────────────────────────
// ── เส้นทาง: โรงเรียนเตรียมอุดมศึกษาภาคใต้ ↔ เซ็นทรัลนครศรีธรรมราช ─────
// ต้นทาง: โรงเรียนเตรียมอุดมศึกษาภาคใต้ (พรหมคีรี) → ปลายทาง: เซ็นทรัลนครศรีธรรมราช
const ROUTE_COORDS = [
  [8.432450, 99.959129],   // 0: โรงเรียนเตรียมอุดมศึกษาภาคใต้
  [8.435500, 99.960500],   // 1: ถนนปั้นน้ำ
  [8.440000, 99.962000],   // 2: แยกพรหมคีรี
  [8.445000, 99.965000],   // 3: ถนนราชดำเนิน
  [8.452000, 99.968000],   // 4: วงเวียนนาคร
  [8.460000, 99.971000],   // 5: ถนนมหาราช
  [8.467100, 99.974300],   // 6: เซ็นทรัลนครศรีธรรมราช
];
const DIR_NORTH       = 'โรงเรียนเตรียมอุดมศึกษาภาคใต้';   // ปลายทางต้นทาง (พรหมคีรี)
const DIR_SOUTH       = 'เซ็นทรัลนครศรีธรรมราช';  // ปลายทางปลายทาง (ตัวเมือง)
const DEST_NORTH      = ROUTE_COORDS[0]; // = โรงเรียนเตรียมอุดมศึกษาภาคใต้
const DEST_SOUTH      = ROUTE_COORDS[6]; // = เซ็นทรัลนครศรีธรรมราช
// backward-compat aliases
const DEST_PHROMKHIRI = DEST_NORTH;
const DEST_NAKHON     = DEST_SOUTH;
const REAL_VEHICLE_ID = 'songthaew_01';

// ── Global Config (อัปเดตจาก /api/config ทุก 5 วิ) ───────────────────────────
window.SYS = {
  demoMode:       false,
  demoVehicles:   2,
  routeName:      'โรงเรียนเตรียมอุดมศึกษาภาคใต้ ↔ เซ็นทรัลนครศรีธรรมราช',
  offlineTimeout: 30,   // วินาที — Arduino ส่งทุก 2s, เผื่อ network latency
  announcement:   '',
  updatedAt:      null,
};

/** เรียกทุกหน้า — sync config จาก server */
async function syncConfig() {
  try {
    const j = await fetch('/api/config').then(r => r.json());
    const changed = JSON.stringify(j) !== JSON.stringify(window.SYS);
    Object.assign(window.SYS, j);
    if (changed && typeof onConfigChanged === 'function') onConfigChanged(window.SYS);
  } catch (_) {}
}

setInterval(syncConfig, 5000);
syncConfig();

// ── Helpers ───────────────────────────────────────────────────────────────────
function haversineKm(la1, lo1, la2, lo2) {
  const R=6371, dL=(la2-la1)*Math.PI/180, dO=(lo2-lo1)*Math.PI/180;
  const a=Math.sin(dL/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dO/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function calculateBearing(la1,lo1,la2,lo2) {
  if(la1===la2&&lo1===lo2) return 0;
  const dO=(lo2-lo1)*Math.PI/180;
  const y=Math.sin(dO)*Math.cos(la2*Math.PI/180);
  const x=Math.cos(la1*Math.PI/180)*Math.sin(la2*Math.PI/180)-Math.sin(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.cos(dO);
  return ((Math.atan2(y,x)*180/Math.PI)+360)%360;
}

function isVehicleOnline(v) {
  const timeout = (window.SYS?.offlineTimeout ?? 30) * 1000;
  return !!(v?.timestamp && (Date.now()-v.timestamp) < timeout);
}

/** clean Leaflet divIcon (no white bg) */
function cleanIcon(html, size=[44,44], anchor=[22,44]) {
  return L.divIcon({ className:'clean-icon', html, iconSize:size, iconAnchor:anchor });
}

/** Bus marker icon */
function busMarkerIcon(speed=0, online=true, isDemo=false, isRecommended=false) {
  const color = !online ? '#94A3B8'
    : isDemo       ? (isRecommended ? '#7C3AED' : '#A78BFA')
    : isRecommended? '#059669'
    : speed === 0  ? '#DC2626'
    : speed < 20   ? '#D97706'
    : '#2563EB';

  const size  = isRecommended ? 48 : 36;
  const pulse = isRecommended
    ? `<span style="position:absolute;inset:-4px;border-radius:50%;background:${color};opacity:.2;animation:ping 1.6s infinite;"></span>`
    : '';
  const badge = isRecommended
    ? `<div style="position:absolute;top:-20px;left:50%;transform:translateX(-50%);background:${color};color:white;border-radius:99px;padding:2px 8px;font-size:9px;font-weight:800;font-family:'Sarabun',sans-serif;white-space:nowrap;">✨ แนะนำ</div>`
    : '';
  const demoTag = isDemo
    ? `<div style="background:#7C3AED;color:white;border-radius:5px;font-family:'IBM Plex Mono',monospace;font-size:8px;font-weight:700;padding:1px 5px;margin-top:1px;">DEMO</div>`
    : '';

  const tot = size + 16;
  return L.divIcon({
    className: 'clean-icon bus-marker',
    iconSize:  [tot, tot],
    iconAnchor:[tot/2, tot/2],
    html: `<div style="position:relative;width:${tot}px;height:${tot}px;display:flex;flex-direction:column;align-items:center;justify-content:center;">
      ${badge}
      <div style="position:relative;display:flex;align-items:center;justify-content:center;">
        ${pulse}
        <div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid white;
          display:flex;align-items:center;justify-content:center;font-size:${size>40?18:14}px;
          box-shadow:0 4px 14px ${color}55;${!online?'opacity:.45;':''}">🚐</div>
      </div>
      ${demoTag}
    </div>`,
  });
}

// ── Announcement banner ───────────────────────────────────────────────────────
function renderAnnouncement(text) {
  let el = document.getElementById('sys-announcement');
  if (!text) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'sys-announcement';
    el.style.cssText = `
      position:fixed;bottom:0;left:0;right:0;z-index:9999;
      background:#1E293B;color:white;padding:10px 20px;
      font-family:'Sarabun',sans-serif;font-size:.82rem;
      display:flex;align-items:center;gap:10px;
      box-shadow:0 -2px 16px rgba(0,0,0,.2);
    `;
    document.body.appendChild(el);
  }
  el.innerHTML = `<span style="font-size:1rem;">📢</span><span>${text}</span>`;
}

// ── JWT Auth Helpers ─────────────────────────────────────────────────────────
function getAuthToken() {
  return localStorage.getItem('adminToken');
}

function setAuthToken(token) {
  localStorage.setItem('adminToken', token);
}

function clearAuth() {
  localStorage.removeItem('adminToken');
  localStorage.removeItem('adminUsername');
}

function isLoggedIn() {
  return !!getAuthToken();
}

/** Get auth headers for fetch */
function authHeaders() {
  const token = getAuthToken();
  return token ? { 'Authorization': 'Bearer ' + token } : {};
}

/** Fetch with auth */
async function authFetch(url, options = {}) {
  const headers = {
    ...options.headers,
    ...authHeaders()
  };
  const res = await fetch(url, { ...options, headers });
  
  if (res.status === 401) {
    clearAuth();
    window.location.href = '/login.html';
    return null;
  }
  
  return res;
}

/** Check auth and redirect if not logged in */
async function requireAuth() {
  const token = getAuthToken();
  if (!token) {
    window.location.href = '/login.html';
    return false;
  }
  
  try {
    const res = await fetch('/api/auth/verify', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    
    if (!data.ok) {
      clearAuth();
      window.location.href = '/login.html';
      return false;
    }
    
    return true;
  } catch (e) {
    clearAuth();
    window.location.href = '/login.html';
    return false;
  }
}

// ── Route Management Helpers ─────────────────────────────────────────────────
async function fetchRoutes() {
  try {
    const res = await fetch('/api/routes');
    return await res.json();
  } catch (e) {
    return {};
  }
}

async function createRoute(routeData) {
  return authFetch('/api/routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(routeData)
  });
}

async function deleteRoute(routeId) {
  return authFetch(`/api/routes/${routeId}`, {
    method: 'DELETE'
  });
}

async function addVehicleToRoute(routeId, vehicleId, type = 'real') {
  return authFetch(`/api/routes/${routeId}/vehicles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vehicleId, type })
  });
}

async function removeVehicleFromRoute(routeId, vehicleId) {
  return authFetch(`/api/routes/${routeId}/vehicles/${vehicleId}`, {
    method: 'DELETE'
  });
}

async function fetchRouteVehicles(routeId) {
  try {
    const res = await fetch(`/api/routes/${routeId}/vehicles`);
    return await res.json();
  } catch (e) {
    return {};
  }
}