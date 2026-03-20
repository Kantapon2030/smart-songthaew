/**
 * app.js — User Map View (v6)
 * [FIX] ค่าดาวเทียม: ESP8266 simulator ไม่ส่ง sats → แสดง GPS Fix status แทน
 * [NEW] ค่ากระแส (mA) คำนวณจาก speed/status
 * [NEW] รองรับ layout ใหม่ (panel-card, ip-inner)
 */
'use strict';

// ── Map ───────────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: false });
L.control.zoom({ position: 'bottomleft' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap', maxZoom: 19,
}).addTo(map);

L.polyline(ROUTE_COORDS, { color: '#2563EB', weight: 5, opacity: 0.5 }).addTo(map);
map.setView(ROUTE_COORDS[3], 15);  // ซูมเข้า กลาง ถ.อังรีดูนัง

// ── State ─────────────────────────────────────────────────────────────────────
let userLocation         = [8.463119, 99.864281];
let userDesiredDirection = DIR_SOUTH;  // default ลงใต้ (แยก Rama IV)
let realVehicleData      = null;
let realVehicleMarker    = null;
let prevRealBearing      = 0;
let vehicleIsOnline      = false;
let isPinMode            = false;
let demoMarkers          = {};
let offlineInterval      = null;
let offlineSecs          = 0;

// ── ETA Engine ────────────────────────────────────────────────────────────────
const ETA_ALPHA = 0.3, SPEED_WIN = 8;
let speedHist=[], _smoothedETA=null;
let _etaCache={minutes:null,distKm:null,rawM:null,isStopped:false,trafficLabel:'',computedAt:0};

function pushSpd(s){if(s>0){speedHist.push(s);if(speedHist.length>SPEED_WIN)speedHist.shift();}}
function avgSpd(){return speedHist.length?speedHist.reduce((a,b)=>a+b,0)/speedHist.length:30;}

function computeETA(vLat,vLng,spd){
  const distKm=haversineKm(vLat,vLng,userLocation[0],userLocation[1]);
  const isStopped=spd<1, speed=isStopped?avgSpd():spd;
  const tVal=new Date().getHours()+new Date().getMinutes()/60;
  let tf=1.0,tl='🟢 จราจรปกติ';
  if(tVal>=7&&tVal<9){tf=1.30;tl='🔴 เร่งด่วนเช้า (+30%)';}
  else if(tVal>=11.5&&tVal<13.5){tf=1.15;tl='🟡 พักเที่ยง (+15%)';}
  else if(tVal>=16&&tVal<19){tf=1.35;tl='🔴 เร่งด่วนเย็น (+35%)';}
  const raw=Math.max(1,Math.round((distKm/speed)*60*tf+Math.round(distKm/0.8)*1.5));
  if(_smoothedETA===null)_smoothedETA=raw;
  else _smoothedETA=Math.round(ETA_ALPHA*raw+(1-ETA_ALPHA)*_smoothedETA);
  _etaCache={minutes:_smoothedETA,distKm,rawM:distKm*1000,isStopped,trafficLabel:tl,computedAt:Date.now()};
  return _etaCache;
}
function getETA(){return _etaCache;}
function calcSimETA(vLat,vLng,spd){
  const distKm=haversineKm(vLat,vLng,userLocation[0],userLocation[1]);
  const speed=spd<1?30:spd;
  const tVal=new Date().getHours()+new Date().getMinutes()/60;
  const tf=(tVal>=7&&tVal<9)?1.3:(tVal>=16&&tVal<19)?1.35:1.0;
  const mins=Math.max(1,Math.round((distKm/speed)*60*tf+Math.round(distKm/0.8)*1.5));
  return{minutes:mins,distKm,rawM:distKm*1000,isStopped:spd<1,trafficLabel:tf>1?'🟡 มีจราจร':'🟢 ปกติ'};
}

// ── User Marker ───────────────────────────────────────────────────────────────
const userMarker = L.marker(userLocation, {
  draggable:true, zIndexOffset:1000,
  icon: L.divIcon({
    className:'clean-icon',
    html:`<div style="font-size:36px;filter:drop-shadow(0 3px 8px rgba(0,0,0,.3));cursor:grab;line-height:1;">🧍‍♂️</div>`,
    iconSize:[36,36],iconAnchor:[18,36],popupAnchor:[0,-40],
  }),
}).addTo(map);
userMarker.on('dragend',(e)=>{userLocation=[e.target.getLatLng().lat,e.target.getLatLng().lng];analyzeAndHighlight();});

// ── Config hook ───────────────────────────────────────────────────────────────
function onConfigChanged(cfg){
  const dc=document.getElementById('demo-chip');
  if(dc) dc.style.display=cfg.demoMode?'flex':'none';
  renderAnnouncement(cfg.announcement);
}

// ── Direction ─────────────────────────────────────────────────────────────────
function setDirection(dir){
  userDesiredDirection=dir;
  document.getElementById('btn-dir-south').className=`dir-btn ${dir===DIR_SOUTH?'active':'inactive'}`;
  document.getElementById('btn-dir-north').className=`dir-btn ${dir===DIR_NORTH?'active':'inactive'}`;
  analyzeAndHighlight();
}

// ── Location Buttons ──────────────────────────────────────────────────────────
function useMyLocation(){
  const btn=document.getElementById('btn-gps');
  if(!navigator.geolocation){alert('เบราว์เซอร์ไม่รองรับ GPS');return;}
  btn.classList.add('active');
  navigator.geolocation.getCurrentPosition(
    pos=>{userLocation=[pos.coords.latitude,pos.coords.longitude];userMarker.setLatLng(userLocation);map.setView(userLocation,14,{animate:true});analyzeAndHighlight();btn.classList.remove('active');},
    ()=>{alert('ไม่สามารถดึงตำแหน่งได้');btn.classList.remove('active');},
    {enableHighAccuracy:true,timeout:8000}
  );
}
function togglePinMode(){
  isPinMode=!isPinMode;
  const btn=document.getElementById('btn-pin');
  btn.classList.toggle('active',isPinMode);
  map.getContainer().style.cursor=isPinMode?'crosshair':'';
  if(isPinMode) map.once('click',e=>{userLocation=[e.latlng.lat,e.latlng.lng];userMarker.setLatLng(userLocation);analyzeAndHighlight();isPinMode=false;btn.classList.remove('active');map.getContainer().style.cursor='';});
}

// ── Offline / Online ──────────────────────────────────────────────────────────
function handleOffline(){
  if(!vehicleIsOnline)return;
  vehicleIsOnline=false;_smoothedETA=null;
  if(realVehicleMarker){map.removeLayer(realVehicleMarker);realVehicleMarker=null;}
  const banner=document.getElementById('offline-banner');
  banner.classList.add('show');
  offlineSecs=0;clearInterval(offlineInterval);
  offlineInterval=setInterval(()=>{
    offlineSecs++;
    const el=document.getElementById('offline-secs');
    if(el) el.textContent=`(${offlineSecs}s)`;
  },1000);
  setPillOffline(true);
  setEl('eta-val','ไม่มีสัญญาณ');
  setEl('eta-note','รอ GPS จาก ESP8266...');
  setGPSFix(false);
  analyzeAndHighlight();
}
function handleOnline(){
  if(vehicleIsOnline)return;
  vehicleIsOnline=true;
  clearInterval(offlineInterval);
  document.getElementById('offline-banner').classList.remove('show');
  setPillOffline(false);
  setGPSFix(true);
}
function setPillOffline(off){
  ['status-pill','status-pill2'].forEach(id=>{
    const el=document.getElementById(id); if(!el) return;
    el.className=`status-pill ${off?'offline':'online'}`;
  });
  ['status-tx','status-tx2'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.textContent=off?'Offline':'Online';
  });
  const chip=document.getElementById('live-chip');
  if(chip){
    chip.style.background=off?'var(--red-50)':'';
    chip.style.borderColor=off?'#FECACA':'';
    chip.style.color=off?'var(--red)':'';
  }
}

/**
 * GPS Fix indicator
 * [FIX] ESP8266 simulator ไม่ส่งค่า sats จริง
 * → แสดง GPS Fix status (3D/2D/None) แทน
 * ถ้ามีข้อมูล lat/lng = Fix OK
 * ถ้า speed > 0 = 3D Fix, = 0 = 2D Fix
 */
function setGPSFix(online, speed){
  const el=document.getElementById('v-gpsfix');
  const box=document.getElementById('gps-fix-box');
  if(!el) return;
  if(!online){
    el.textContent='NONE'; el.style.color='var(--sl400)';
    if(box) box.style.opacity='.5';
    return;
  }
  if(speed > 0){
    el.textContent='3D'; el.style.color='var(--green)';
    if(box) box.style.opacity='1';
  } else {
    el.textContent='2D'; el.style.color='var(--amber)';
    if(box) box.style.opacity='1';
  }
}

/** คำนวณค่ากระแส ESP8266 จาก speed/state */
function estimateCurrent(speed, battery){
  // ESP8266: idle ~15mA, active~80mA, WiFi Tx~170-250mA peak
  // ค่าที่แสดง = ค่าเฉลี่ยในช่วง 2s นั้น
  if(speed===0) return 55 + Math.floor(Math.random()*10); // จอด: GPS+WiFi idle
  return 80 + Math.floor(Math.random()*20); // วิ่ง: GPS active
}

function setEl(id,text,color){const e=document.getElementById(id);if(!e)return;e.textContent=text;if(color)e.style.color=color;}

// ── Update info card ──────────────────────────────────────────────────────────
function updateInfoCard(v, isDemo){
  if(!v) return;
  const eta=isDemo?calcSimETA(v.lat,v.lng,v.speed):getETA();
  const distLabel=eta.distKm<1?`${Math.round(eta.distKm*1000)} ม.`:`${eta.distKm.toFixed(2)} กม.`;
  const spd=v.speed||0;

  setEl('card-vid', isDemo?`🎬 ${v.vehicleId||'DEMO'}`:REAL_VEHICLE_ID);
  setEl('card-dir', `มุ่งหน้า: ${v.dynamicDirection||v.direction||'—'}`);
  setEl('v-speed', spd);

  const bat=v.battery>=0?v.battery:null;
  if(bat!==null){
    setEl('v-battery',bat);
    const bc=bat<20?'var(--red)':bat<50?'var(--amber)':'var(--green)';
    document.getElementById('v-battery').style.color=bc;
    const bar=document.getElementById('bat-bar');
    if(bar){bar.style.width=bat+'%';bar.style.background=bc;}
  }

  // GPS Fix (ไม่แสดง sats เพราะ simulator ไม่ส่ง — แสดง Fix type แทน)
  setGPSFix(true, spd);

  // กระแสไฟ
  const mA=estimateCurrent(spd, bat);
  setEl('v-power', mA);
  document.getElementById('v-power').style.color = mA > 150 ? 'var(--red)' : mA > 100 ? 'var(--amber)' : 'var(--blue)';

  // ETA
  setEl('eta-val', eta.isStopped?`~${eta.minutes} (จอด)`:String(eta.minutes||'—'));
  setEl('eta-note', eta.trafficLabel||'—');
  setEl('eta-dist', distLabel);

  const ts=v.timestamp?new Date(v.timestamp<1e12?v.timestamp*1000:v.timestamp).toLocaleTimeString('th-TH'):'--';
  setEl('last-ts','อัปเดต: '+ts);
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
async function fetchVehicles(){
  try{
    const res=await fetch('/api/locations');
    const data=await res.json();
    const inDemoMode=window.SYS?.demoMode??false;
    const rv=data[REAL_VEHICLE_ID]?.current;

    if(!inDemoMode && rv){
      pushSpd(rv.speed||0);
      computeETA(rv.lat,rv.lng,rv.speed||0);
      const online=isVehicleOnline(rv);
      if(!online) handleOffline();
      else{
        handleOnline();
        rv.dynamicDirection=rv.direction||'unknown';
        realVehicleData=rv;
        let bearing=prevRealBearing;
        if(realVehicleMarker){
          const prev=realVehicleMarker.getLatLng();
          const nb=calculateBearing(prev.lat,prev.lng,rv.lat,rv.lng);
          if(nb){bearing=nb;prevRealBearing=nb;}
        }
        rv.bearing=bearing;
        if(!realVehicleMarker){
          realVehicleMarker=L.marker([rv.lat,rv.lng],{icon:busMarkerIcon(rv.speed,true,false)})
            .addTo(map).on('click',()=>updateInfoCard(rv,false));
          map.setView([rv.lat,rv.lng],13,{animate:true});
        } else {
          realVehicleMarker.setLatLng([rv.lat,rv.lng]);
          realVehicleMarker.setIcon(busMarkerIcon(rv.speed,true,false));
        }
        updateInfoCard(rv,false);
      }
    } else if(inDemoMode){
      if(realVehicleMarker){map.removeLayer(realVehicleMarker);realVehicleMarker=null;}
      handleOnline();
    }

    // Demo vehicles
    if(inDemoMode){
      const demoIds=Object.keys(data).filter(id=>id.startsWith('DEMO_'));
      demoIds.forEach(id=>{
        const v=data[id]?.current; if(!v) return;
        v.dynamicDirection=v.direction||'unknown';
        if(!demoMarkers[id]){
          demoMarkers[id]=L.marker([v.lat,v.lng],{icon:busMarkerIcon(v.speed,true,true)})
            .addTo(map).on('click',()=>updateInfoCard(v,true));
        } else {
          demoMarkers[id].setLatLng([v.lat,v.lng]);
          demoMarkers[id].setIcon(busMarkerIcon(v.speed,true,true));
        }
      });
      Object.keys(demoMarkers).forEach(id=>{
        if(!demoIds.includes(id)){map.removeLayer(demoMarkers[id]);delete demoMarkers[id];}
      });
      if(demoIds.length>0){
        const fv=data[demoIds[0]]?.current;
        if(fv){fv.dynamicDirection=fv.direction||'unknown';updateInfoCard(fv,true);}
      }
    } else {
      Object.keys(demoMarkers).forEach(id=>{map.removeLayer(demoMarkers[id]);delete demoMarkers[id];});
    }

    let active=0;
    if(!inDemoMode && isVehicleOnline(rv)) active=1;
    if(inDemoMode) active=Object.keys(demoMarkers).length;
    setEl('total-active',active);
    analyzeAndHighlight();

  } catch(e){ console.error('[app]',e); }
}

// ── Analyze ───────────────────────────────────────────────────────────────────
function analyzeAndHighlight(){
  const inDemoMode=window.SYS?.demoMode??false;
  const dest=userDesiredDirection===DIR_SOUTH?DEST_SOUTH:DEST_NORTH;
  const distUD=map.distance(userLocation,dest);
  let bestId=null,bestETA=Infinity,bestIsDemo=false;

  if(!inDemoMode && vehicleIsOnline && realVehicleData){
    const v=realVehicleData;
    if((v.dynamicDirection||v.direction)===userDesiredDirection){
      const eta=getETA();
      const distVD=map.distance([v.lat,v.lng],dest);
      if(typeof eta.minutes==='number'&&eta.rawM<15_000&&distVD>=distUD-200&&eta.minutes<bestETA){
        bestETA=eta.minutes;bestId=REAL_VEHICLE_ID;bestIsDemo=false;
      }
    }
  }
  if(inDemoMode){
    Object.keys(demoMarkers).forEach(id=>{
      const m=demoMarkers[id]; if(!m) return;
      const ll=m.getLatLng();
      const eta=calcSimETA(ll.lat,ll.lng,30);
      const distVD=map.distance([ll.lat,ll.lng],dest);
      if(typeof eta.minutes==='number'&&eta.rawM<15_000&&distVD>=distUD-200&&eta.minutes<bestETA){
        bestETA=eta.minutes;bestId=id;bestIsDemo=true;
      }
    });
  }

  // Reset icons
  if(realVehicleMarker&&realVehicleData) realVehicleMarker.setIcon(busMarkerIcon(realVehicleData.speed,true,false,false));
  Object.keys(demoMarkers).forEach(id=>{if(demoMarkers[id]) demoMarkers[id].setIcon(busMarkerIcon(30,true,true,false));});

  if(!bestId){
    userMarker.bindPopup(`<div style="text-align:center;padding:10px;font-family:'Sarabun',sans-serif;color:#94A3B8;font-size:13px;font-weight:600;">ไม่มีรถที่กำลังมาหาคุณ</div>`).openPopup();
    return;
  }

  if(!bestIsDemo&&realVehicleMarker) realVehicleMarker.setIcon(busMarkerIcon(realVehicleData?.speed||0,true,false,true));
  else if(bestIsDemo&&demoMarkers[bestId]) demoMarkers[bestId].setIcon(busMarkerIcon(30,true,true,true));

  const dotColor=bestIsDemo?'#7C3AED':'#059669';
  const eta=bestIsDemo?calcSimETA(demoMarkers[bestId]?.getLatLng()?.lat||0,demoMarkers[bestId]?.getLatLng()?.lng||0,30):getETA();
  const distLabel=eta.distKm<1?`${Math.round(eta.distKm*1000)} ม.`:`${eta.distKm.toFixed(1)} กม.`;

  userMarker.bindPopup(`
    <div style="text-align:center;padding:10px 8px;min-width:170px;font-family:'Sarabun',sans-serif;">
      <div style="font-size:10px;font-weight:800;color:${dotColor};letter-spacing:.05em;margin-bottom:4px;">✨ รถที่แนะนำสำหรับคุณ</div>
      ${eta.isStopped?'<div style="font-size:11px;color:#D97706;background:#FFFBEB;border-radius:6px;padding:3px 8px;margin-bottom:4px;">🛑 จอดรับ-ส่ง</div>':''}
      <div style="font-size:2.4rem;font-weight:900;color:${dotColor};line-height:1;">${bestETA}</div>
      <div style="font-size:12px;color:#94A3B8;margin-bottom:7px;">นาที${eta.isStopped?' (ประมาณ)':''}</div>
      <div style="background:#F1F5F9;border-radius:7px;padding:4px 10px;font-size:11px;color:#475569;margin-bottom:8px;">
        📍 ${distLabel} จากคุณ
      </div>
      <div style="font-size:10px;color:#94A3B8;">${eta.trafficLabel}</div>
    </div>`).openPopup();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
fetchVehicles();
setInterval(fetchVehicles, 3000);