/**
 * shared.js — ค่ากลางที่ทุกหน้าใช้ร่วมกัน
 * โหลดไฟล์นี้ก่อนหน้า page-specific script เสมอ
 */
'use strict';

// ── Route ─────────────────────────────────────────────────────────────────────
const ROUTE_COORDS = [
  [8.432450, 99.959129],
  [8.432796, 99.888032],
  [8.463119, 99.864281],
  [8.508510, 99.827826],
  [8.522536, 99.825067],
];
const DEST_PHROMKHIRI = ROUTE_COORDS[4];
const DEST_NAKHON     = ROUTE_COORDS[0];
const REAL_VEHICLE_ID = 'songthaew_01';

// ── Global Config (อัปเดตจาก /api/config ทุก 5 วิ) ───────────────────────────
window.SYS = {
  demoMode:       false,
  demoVehicles:   2,
  routeName:      'นครศรีธรรมราช ↔ พรหมคีรี',
  offlineTimeout: 15,   // วินาที
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
  const timeout = (window.SYS?.offlineTimeout ?? 15) * 1000;
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
    className: 'clean-icon',
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