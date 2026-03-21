/**
 * shared.js — ค่ากลางที่ทุกหน้าใช้ร่วมกัน
 * โหลดไฟล์นี้ก่อนหน้า page-specific script เสมอ
 */
'use strict';

// ── Route ─────────────────────────────────────────────────────────────────────
// ── เส้นทาง: ถนนอังรีดูนังต์ Rama I ↔ Rama IV (~1.6 km) ─────
// จากเหนือ (Siam Square) ลงใต้ (แยก Rama IV)
const ROUTE_COORDS = [
  [13.7451, 100.5358],   // 0: Siam Square / Rama I
  [13.7428, 100.5356],   // 1: ร.ร.สาธิตปทุมวัน
  [13.7407, 100.5350],   // 2: ประตูจุฬาฯ (อังรีดูนัง)
  [13.7384, 100.5345],   // 3: คณะสัตวแพทย์ จุฬาฯ
  [13.7360, 100.5340],   // 4: รพ.จุฬา / สภากาชาด
  [13.7342, 100.5337],   // 5: สถานเสาวภา
  [13.7311, 100.5336],   // 6: แยก Rama IV
];
const DIR_NORTH       = 'Siam Square';   // ปลายทางเหนือ (Rama I)
const DIR_SOUTH       = 'แยก Rama IV';  // ปลายทางใต้
const DEST_NORTH      = ROUTE_COORDS[0]; // = Siam Square
const DEST_SOUTH      = ROUTE_COORDS[6]; // = แยก Rama IV
// backward-compat aliases
const DEST_PHROMKHIRI = DEST_SOUTH;
const DEST_NAKHON     = DEST_NORTH;
const REAL_VEHICLE_ID = 'songthaew_01';

// ── Global Config (อัปเดตจาก /api/config ทุก 5 วิ) ───────────────────────────
window.SYS = {
  demoMode:       false,
  demoVehicles:   2,
  routeName:      'Siam Square ↔ แยก Rama IV (ถ.อังรีดูนัง)',
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