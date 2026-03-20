/**
 * shared.js v3 — Fixed Routes แถวจุฬาลงกรณ์ฯ กรุงเทพฯ
 * ไม่มีระบบ route management — 2 เส้นทางคงที่
 */
'use strict';

const REAL_VEHICLE_ID = 'songthaew_01';

// ── FIXED ROUTES ──────────────────────────────────────────────
// เส้นทางถนนอังรีดูนังต์ — Rama I → Rama IV (1.6 km)
// ต้นทาง: แยก Rama I / Siam Square (ตรงข้าม Siam Paragon)
// ปลายทาง: แยก Rama IV (สี่แยกอังรีดูนัง)
const FIXED_ROUTES = {
  route_henri_dunant: {
    id:'route_henri_dunant',
    name:'Siam ↔ Rama IV (ถ.อังรีดูนัง)',
    shortName:'สายอังรีดูนัง',
    color:'#2563EB',
    dirStart:'Siam Square',
    dirEnd:'แยก Rama IV',
    vehicles:['songthaew_01'],
    waypoints:[
      {lat:13.7451,lng:100.5358,label:'Siam Square / Rama I'},
      {lat:13.7428,lng:100.5356,label:'ร.ร.สาธิตปทุมวัน'},
      {lat:13.7407,lng:100.5350,label:'ประตูจุฬาฯ (อังรีดูนัง)'},
      {lat:13.7384,lng:100.5345,label:'คณะสัตวแพทย์ จุฬาฯ'},
      {lat:13.7360,lng:100.5340,label:'รพ.จุฬา / สภากาชาด'},
      {lat:13.7342,lng:100.5337,label:'สถานเสาวภา'},
      {lat:13.7311,lng:100.5336,label:'แยก Rama IV'},
    ],
  },
};

// ── Global State ──────────────────────────────────────────────
window.SYS={demoMode:false,demoVehicles:2,demoRouteId:'route_siam_samyan',offlineTimeout:15,announcement:'',updatedAt:null};
window.ROUTES=FIXED_ROUTES;
window.ACTIVE_ROUTE_ID='route_henri_dunant';

// ── Config sync (demo mode / announcement only) ───────────────
let _lastCfgTs=0;
async function syncConfig(){
  try{
    const j=await fetch('/api/config').then(r=>r.json());
    const changed=j.updatedAt!==_lastCfgTs; _lastCfgTs=j.updatedAt;
    Object.assign(window.SYS,j);
    if(changed&&typeof onConfigChanged==='function') onConfigChanged(window.SYS);
  }catch(_){}
}
syncConfig(); setInterval(syncConfig,5000);

// ── Route helpers ─────────────────────────────────────────────
function getActiveRoute(){return window.ROUTES[window.ACTIVE_ROUTE_ID]||Object.values(window.ROUTES)[0]||null;}
function getActiveWaypoints(){const r=getActiveRoute();if(!r?.waypoints?.length)return[];return r.waypoints.map(wp=>[wp.lat,wp.lng]);}
function getDirStartName(){return getActiveRoute()?.dirStart||'ต้นทาง';}
function getDirEndName()  {return getActiveRoute()?.dirEnd  ||'ปลายทาง';}
function getRouteColor()  {return getActiveRoute()?.color   ||'#2563EB';}

// ── Math ──────────────────────────────────────────────────────
function haversineKm(la1,lo1,la2,lo2){
  const R=6371,dL=(la2-la1)*Math.PI/180,dO=(lo2-lo1)*Math.PI/180;
  const a=Math.sin(dL/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dO/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function calculateBearing(la1,lo1,la2,lo2){
  if(la1===la2&&lo1===lo2)return 0;
  const dO=(lo2-lo1)*Math.PI/180;
  const y=Math.sin(dO)*Math.cos(la2*Math.PI/180);
  const x=Math.cos(la1*Math.PI/180)*Math.sin(la2*Math.PI/180)-Math.sin(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.cos(dO);
  return((Math.atan2(y,x)*180/Math.PI)+360)%360;
}
function isVehicleOnline(v){return!!(v?.timestamp&&(Date.now()-v.timestamp)<(window.SYS?.offlineTimeout??15)*1000);}

// ── Bus icon ──────────────────────────────────────────────────
function busMarkerIcon(speed=0,online=true,routeColor='#2563EB',isDemo=false,isRecommended=false){
  const color=!online?'#94A3B8':isRecommended?'#059669':speed===0?'#DC2626':speed<20?'#D97706':routeColor;
  const size=isRecommended?48:36,tot=size+16;
  const pulse=isRecommended?`<span style="position:absolute;inset:-4px;border-radius:50%;background:${color};opacity:.2;animation:ping 1.6s infinite;"></span>`:'';
  const badge=isRecommended?`<div style="position:absolute;top:-20px;left:50%;transform:translateX(-50%);background:${color};color:white;border-radius:99px;padding:2px 8px;font-size:9px;font-weight:800;font-family:'Sarabun',sans-serif;white-space:nowrap;">✨ แนะนำ</div>`:'';
  const demoTag=isDemo?`<div style="background:#7C3AED;color:white;border-radius:5px;font-family:'IBM Plex Mono',monospace;font-size:8px;font-weight:700;padding:1px 5px;margin-top:1px;">DEMO</div>`:'';
  return L.divIcon({
    className:'clean-icon',iconSize:[tot,tot],iconAnchor:[tot/2,tot/2],
    html:`<div style="position:relative;width:${tot}px;height:${tot}px;display:flex;flex-direction:column;align-items:center;justify-content:center;">${badge}<div style="position:relative;display:flex;align-items:center;justify-content:center;">${pulse}<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid white;display:flex;align-items:center;justify-content:center;font-size:${size>40?18:14}px;box-shadow:0 4px 14px ${color}55;${!online?'opacity:.45;':''}">🚐</div></div>${demoTag}</div>`,
  });
}
function renderAnnouncement(text){
  let el=document.getElementById('sys-announcement');
  if(!text){if(el)el.remove();return;}
  if(!el){el=document.createElement('div');el.id='sys-announcement';el.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#1E293B;color:white;padding:10px 20px;font-family:\'Sarabun\',sans-serif;font-size:.82rem;display:flex;align-items:center;gap:10px;';document.body.appendChild(el);}
  el.innerHTML=`<span>📢</span><span>${text}</span>`;
}