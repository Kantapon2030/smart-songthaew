/**
 * shared.js — Google Maps Edition
 * ค่ากลางที่ทุกหน้าใช้ร่วมกัน — โหลดก่อน page-specific script เสมอ
 */
'use strict';

// เส้นทางจริง: เซ็นทรัลนครศรีธรรมราช → โรงเรียนเตรียมอุดมศึกษาภาคใต้ (พรหมคีรี)
const ROUTE_COORDS = [
  [8.4671,99.9743],[8.4620,99.9710],[8.4555,99.9685],
  [8.4480,99.9655],[8.4390,99.9620],[8.4300,99.9590],
  [8.4200,99.9565],[8.4130,99.9545],[8.4040,99.9520],
  [8.3980,99.9500],[8.3924,99.9480],
];
const DIR_NORTH='โรงเรียนเตรียมอุดมศึกษาภาคใต้ (พรหมคีรี)';
const DIR_SOUTH='เซ็นทรัลนครศรีธรรมราช';
const DEST_NORTH=ROUTE_COORDS[ROUTE_COORDS.length-1]; // พรหมคีรี
const DEST_SOUTH=ROUTE_COORDS[0];                     // เซ็นทรัล
const DEST_PHROMKHIRI=DEST_NORTH;
const DEST_NAKHON=DEST_SOUTH;
const REAL_VEHICLE_ID='songthaew_01';

// ── Global Config ─────────────────────────────────────────────
window.SYS={demoMode:false,demoVehicles:1,routeName:'นครศรีธรรมราช ↔ พรหมคีรี',offlineTimeout:30,announcement:'',updatedAt:null};

async function syncConfig(){
  try{
    const j=await fetch('/api/config').then(r=>r.json());
    const changed=JSON.stringify(j)!==JSON.stringify(window.SYS);
    Object.assign(window.SYS,j);
    if(changed&&typeof onConfigChanged==='function') onConfigChanged(window.SYS);
  }catch(_){}
}
setInterval(syncConfig,5000); syncConfig();

// ── Google Maps API Key Loader ────────────────────────────────
let _gmapsKey='';
async function loadGoogleMapsAPI(){
  if(window.google?.maps) return;
  try{
    const r=await fetch('/api/maps/key').then(r=>r.json());
    _gmapsKey=r.key||'';
  }catch(_){}
  if(!_gmapsKey){console.warn('[MAPS] No API key');return;}
  return new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src=`https://maps.googleapis.com/maps/api/js?key=${_gmapsKey}&libraries=marker,geometry&callback=__gmapsReady&loading=async`;
    s.async=true; s.defer=true;
    window.__gmapsReady=()=>{delete window.__gmapsReady;resolve();};
    s.onerror=reject;
    document.head.appendChild(s);
  });
}

// ── Helpers ───────────────────────────────────────────────────
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

function isVehicleOnline(v){
  const timeout=(window.SYS?.offlineTimeout??30)*1000;
  return!!(v?.timestamp&&(Date.now()-v.timestamp)<timeout);
}

// ── Google Maps Vehicle Marker ────────────────────────────────
// รถ demo แสดงสีเขียวเหมือนรถจริงที่วิ่งอยู่ — ไม่มี badge พิเศษ
function createVehicleMarkerContent(speed=0,online=true,isDemo=false,isRecommended=false){
  // ทั้งรถจริงและรถ demo ใช้โลจิก color เดียวกัน
  const color=!online?'#9AA0A6':speed===0?'#EA4335':speed<20?'#FBBC04':'#34A853';
  const size=isRecommended?48:36;
  const el=document.createElement('div');
  el.style.cssText='display:flex;flex-direction:column;align-items:center;position:relative;';
  let html='';
  if(isRecommended) html+=`<div style="background:${color};color:#fff;border-radius:99px;padding:2px 8px;font-size:9px;font-weight:800;font-family:Inter,Sarabun,sans-serif;white-space:nowrap;margin-bottom:2px;">✨ แนะนำ</div>`;
  html+=`<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-size:${size>40?18:14}px;box-shadow:0 4px 14px ${color}55;${!online?'opacity:.45;':''}transition:all .3s;">🚐</div>`;
  el.innerHTML=html;
  return el;
}

// ── Announcement banner ───────────────────────────────────────
function renderAnnouncement(text){
  let el=document.getElementById('sys-announcement');
  if(!text){if(el)el.remove();return;}
  if(!el){
    el=document.createElement('div');el.id='sys-announcement';
    el.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#202124;color:#fff;padding:10px 20px;font-family:Inter,Sarabun,sans-serif;font-size:.82rem;display:flex;align-items:center;gap:10px;box-shadow:0 -2px 16px rgba(0,0,0,.2);';
    document.body.appendChild(el);
  }
  el.innerHTML=`<span style="font-size:1rem;">📢</span><span>${text}</span>`;
}

// ── JWT Auth Helpers ──────────────────────────────────────────
function getAuthToken(){return localStorage.getItem('adminToken');}
function setAuthToken(t){localStorage.setItem('adminToken',t);}
function clearAuth(){localStorage.removeItem('adminToken');localStorage.removeItem('adminUsername');}
function isLoggedIn(){return!!getAuthToken();}
function authHeaders(){const t=getAuthToken();return t?{'Authorization':'Bearer '+t}:{};}

async function authFetch(url,options={}){
  const headers={...options.headers,...authHeaders()};
  const res=await fetch(url,{...options,headers});
  if(res.status===401){clearAuth();window.location.href='/login.html';return null;}
  return res;
}

async function requireAuth(){
  const token=getAuthToken();
  if(!token){window.location.href='/login.html';return false;}
  try{
    const res=await fetch('/api/auth/verify',{headers:{'Authorization':'Bearer '+token}});
    const data=await res.json();
    if(!data.ok){clearAuth();window.location.href='/login.html';return false;}
    return true;
  }catch(e){clearAuth();window.location.href='/login.html';return false;}
}

// ── Route API Helpers ─────────────────────────────────────────
async function fetchRoutes(){try{return await fetch('/api/routes').then(r=>r.json());}catch(e){return{};}}
async function createRoute(d){return authFetch('/api/routes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});}
async function deleteRoute(id){return authFetch(`/api/routes/${id}`,{method:'DELETE'});}
async function addVehicleToRoute(rid,vid,type='real'){return authFetch(`/api/routes/${rid}/vehicles`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vehicleId:vid,type})});}
async function removeVehicleFromRoute(rid,vid){return authFetch(`/api/routes/${rid}/vehicles/${vid}`,{method:'DELETE'});}
async function fetchRouteVehicles(rid){try{return await fetch(`/api/routes/${rid}/vehicles`).then(r=>r.json());}catch(e){return{};}}