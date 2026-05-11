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

// [FIX] ไม่วาด polyline hardcoded อีกต่อไป — ใช้ changeRoute() แทน
// เริ่มที่ตำแหน่งกลางของเส้นทาง default ก่อนโหลดเสร็จ
map.setView([8.432450, 99.959129], 13);

// ── State ─────────────────────────────────────────────────────────────────────
let userLocation = [8.445000, 99.965000];  // Default
try {
  const saved = localStorage.getItem('userPinLocation');
  if (saved) {
    const parsed = JSON.parse(saved);
    if (parsed && parsed.length === 2) userLocation = parsed;
  }
} catch (e) {}

let userDesiredDirection = null; // จะตั้งค่าอัตโนมัติตาม ต้นทาง/ปลายทาง ที่เลือก
let userOriginIdx        = 0;
let userDestIdx          = 1;

let realVehicleData      = null;
let realVehicleMarker    = null;
let prevRealBearing      = 0;
let vehicleIsOnline      = false;
let isPinMode            = false;
let demoMarkers          = {};
let offlineInterval      = null;
let offlineSecs          = 0;
let isBottomPanelExpanded= false;
let currentRouteId       = null;
let allRoutes            = {};
let routePolyline        = null;  // [FIX] เก็บ reference เพื่อลบได้ถูกต้อง
let _initialPolylineDone = false; // กันไม่ให้ fitBounds ทุกครั้งที่ fetch

// ── Bottom Panel Toggle ─────────────────────────────────────────────────────
function toggleBottomPanel() {
  isBottomPanelExpanded = !isBottomPanelExpanded;
  const panel = document.getElementById('info-panel');
  
  if (isBottomPanelExpanded) {
    panel.classList.add('expanded');
  } else {
    panel.classList.remove('expanded');
  }
  updateBottomPanel();
}

function updateBottomPanel(vehicleData = null) {
  // Use passed data or fallback to realVehicleData. We still update ETA even without vehicle data.
  const vehicle = vehicleData || realVehicleData;
  
  const collapsedTitle = document.getElementById('collapsed-title');
  const collapsedETA = document.getElementById('collapsed-eta');
  
  if (collapsedTitle && vehicle) {
    const dir = vehicle.direction === 'เซ็นทรัลนครศรีธรรมราช' ? '→ Central' : '→ เตรียมอุดมฯ';
    const speed = vehicle.speed || 0;
    collapsedTitle.textContent = `🚐 ${speed} km/h ${dir}`;
  }
  
  if (collapsedETA) {
    // [FIX] ใช้ _etaCache เสมอ — ทั้ง real และ demo mode อัปเดต cache นี้
    const eta = _etaCache.minutes;
    if (eta !== null && eta !== undefined) {
      const dist = _etaCache.distKm;
      const distTxt = dist < 1 ? `${Math.round(dist*1000)} ม.` : `${dist.toFixed(1)} กม.`;
      collapsedETA.textContent = `⏱️ ${eta} นาที (${distTxt})`;
    } else {
      collapsedETA.textContent = 'กำลังคำนวณ ETA...';
    }
  }
}

// ── Route Management ─────────────────────────────────────────────────────────
async function loadRoutes() {
  try {
    allRoutes = await fetchRoutes();
    const select = document.getElementById('route-select');
    
    if (select) {
      select.innerHTML = Object.entries(allRoutes).map(([id, route]) => 
        `<option value="${id}">${route.name}</option>`
      ).join('');
      
      // Select first route if none selected
      if (!currentRouteId && select.options.length > 0) {
        currentRouteId = select.options[0].value;
        select.value = currentRouteId;
        changeRoute(currentRouteId);
      }
    }
  } catch (e) {
    console.error('Failed to load routes:', e);
  }
}

function changeRoute(routeId) {
  if (!routeId) return;
  // รอ allRoutes โหลดก่อน
  if (!allRoutes[routeId]) {
    // ถ้ายังไม่มีข้อมูล ลอง fetch ใหม่
    fetchRoutes().then(routes => { allRoutes = routes; changeRoute(routeId); });
    return;
  }
  
  currentRouteId = routeId;
  const route = allRoutes[routeId];

  // [FIX] ลบ polyline เดิมทุกกรณี รวมถึง polyline hardcoded
  if (routePolyline) { map.removeLayer(routePolyline); routePolyline = null; }

  if (route.coords && route.coords.length > 1) {
    routePolyline = L.polyline(route.coords, {
      color: '#2563EB', weight: 5, opacity: 0.6,
    }).addTo(map);
    // fitBounds เฉพาะครั้งแรก หรือเมื่อเปลี่ยนเส้นทาง
    map.fitBounds(routePolyline.getBounds().pad(0.12));
  }

  // Populate Origin and Destination dropdowns
  const originSelect = document.getElementById('origin-select');
  const destSelect = document.getElementById('dest-select');
  if (originSelect && destSelect && route.stops) {
    let opts = '';
    route.stops.forEach((stop, idx) => {
      opts += `<option value="${idx}">${stop.name}</option>`;
    });
    originSelect.innerHTML = opts;
    destSelect.innerHTML = opts;
    
    // Default: Origin = 0, Dest = last
    originSelect.value = 0;
    destSelect.value = route.stops.length - 1;
    
    updateOdSelection(false); // Update internal state without fetching immediately
  }

  refreshLocations();
}

function updateOdSelection(refresh = true) {
  const originSelect = document.getElementById('origin-select');
  const destSelect = document.getElementById('dest-select');
  if (!originSelect || !destSelect || !currentRouteId || !allRoutes[currentRouteId]) return;

  const oIdx = parseInt(originSelect.value);
  const dIdx = parseInt(destSelect.value);
  const route = allRoutes[currentRouteId];

  userOriginIdx = oIdx;
  userDestIdx = dIdx;

  if (oIdx === dIdx) {
    userDesiredDirection = null; // Cannot compute
  } else {
    // If destination is after origin in the stops array, direction is toward the last stop
    // If destination is before origin in the stops array, direction is toward the first stop
    if (dIdx > oIdx) {
      userDesiredDirection = route.stops[route.stops.length - 1].name;
    } else {
      userDesiredDirection = route.stops[0].name;
    }
  }

  if (refresh) analyzeAndHighlight();
}

async function refreshLocations() {
  await fetchVehicles();
}

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

function saveUserLocation() {
  localStorage.setItem('userPinLocation', JSON.stringify(userLocation));
}

userMarker.on('dragend',(e)=>{
  userLocation=[e.target.getLatLng().lat,e.target.getLatLng().lng];
  saveUserLocation();
  analyzeAndHighlight();
});

// ── Config hook ───────────────────────────────────────────────────────────────
function onConfigChanged(cfg){
  const dc=document.getElementById('demo-chip');
  if(dc) dc.style.display=cfg.demoMode?'flex':'none';
  renderAnnouncement(cfg.announcement);
}

// ── Location Buttons ──────────────────────────────────────────────────────────
function useMyLocation(){
  const btn=document.getElementById('btn-gps');
  if(!navigator.geolocation){alert('เบราว์เซอร์ไม่รองรับ GPS');return;}
  btn.classList.add('active');
  navigator.geolocation.getCurrentPosition(
    pos=>{
      userLocation=[pos.coords.latitude,pos.coords.longitude];
      userMarker.setLatLng(userLocation);
      map.setView(userLocation,14,{animate:true});
      saveUserLocation();
      analyzeAndHighlight();
      btn.classList.remove('active');
    },
    ()=>{alert('ไม่สามารถดึงตำแหน่งได้');btn.classList.remove('active');},
    {enableHighAccuracy:true,timeout:8000}
  );
}
function togglePinMode(){
  isPinMode=!isPinMode;
  const btn=document.getElementById('btn-pin');
  btn.classList.toggle('active',isPinMode);
  map.getContainer().style.cursor=isPinMode?'crosshair':'';
  if(isPinMode) map.once('click',e=>{
    userLocation=[e.latlng.lat,e.latlng.lng];
    userMarker.setLatLng(userLocation);
    saveUserLocation();
    analyzeAndHighlight();
    isPinMode=false;
    btn.classList.remove('active');
    map.getContainer().style.cursor='';
  });
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

// [REMOVED] estimateCurrent() — แสดงค่าจริงจาก Arduino เท่านั้น (currentMa field)

function setEl(id,text,color){const e=document.getElementById(id);if(!e)return;e.textContent=text;if(color)e.style.color=color;}

// ── Update info card ──────────────────────────────────────────────────────────
function updateInfoCard(v, isDemo){
  if(!v) {
    // No vehicle data - show offline state
    setEl('card-vid', 'ไม่มีรถในระบบ');
    setEl('card-dir', 'สถานะ: offline');
    setEl('v-speed', 'offline');
    setEl('v-battery', 'offline');
    setEl('v-power', 'offline');
    setEl('eta-val', 'ไม่มีรถในระบบ');
    setEl('eta-note', 'กรุณารอรถจริง');
    setEl('eta-dist', '--');
    setEl('last-ts', 'อัปเดต: offline');
    
    // Update collapsed panel
    const collapsedTitle = document.getElementById('collapsed-title');
    const collapsedETA = document.getElementById('collapsed-eta');
    if(collapsedTitle) collapsedTitle.textContent = 'ไม่มีรถในระบบ';
    if(collapsedETA) collapsedETA.textContent = 'รอข้อมูลจากบอร์ด...';
    return;
  }
  
  // [FIX] Demo mode: คำนวณ ETA และเขียนเข้า _etaCache ด้วย ไม่ใช่แค่คืนค่า local
  let eta;
  if (isDemo) {
    eta = calcSimETA(v.lat, v.lng, v.speed);
    // อัปเดต cache เพื่อให้ collapsedPanel อ่านได้
    _etaCache = { ...eta, computedAt: Date.now() };
  } else {
    eta = getETA();
  }
  const distLabel=eta.distKm<1?`${Math.round(eta.distKm*1000)} ม.`:`${eta.distKm.toFixed(2)} กม.`;
  const spd=v.speed||0;

  setEl('card-vid', isDemo?`🎬 ${v.vehicleId||'DEMO'}`:REAL_VEHICLE_ID);
  setEl('card-dir', `มุ่งหน้า: ${v.dynamicDirection||v.direction||'—'}`);
  setEl('v-speed', spd);

  // Battery % — ค่าจริงจาก Arduino เท่านั้น
  const bat = (v.battery != null && v.battery >= 0) ? v.battery : null;
  if(bat !== null){
    setEl('v-battery', bat);
    const bc = bat<20 ? 'var(--red)' : bat<50 ? 'var(--amber)' : 'var(--green)';
    document.getElementById('v-battery').style.color = bc;
    const bar = document.getElementById('bat-bar');
    if(bar){ bar.style.width = bat+'%'; bar.style.background = bc; }
  } else {
    setEl('v-battery', '--');
    document.getElementById('v-battery').style.color = 'var(--sl400)';
  }

  // GPS Fix — speed > 0 = 3D Fix, มี lat/lng ถูกต้อง = 2D Fix
  const hasGPS = v.lat && v.lng && v.lat !== 0 && v.lng !== 0;
  setGPSFix(hasGPS, spd);

  // กระแสไฟ — ใช้ค่าจริงจาก Arduino (currentMa) ไม่ประมาณ
  const mA = (v.currentMa != null && v.currentMa > 0) ? Math.round(v.currentMa) : null;
  if(mA !== null){
    setEl('v-power', mA);
    document.getElementById('v-power').style.color = mA > 150 ? 'var(--red)' : mA > 100 ? 'var(--amber)' : 'var(--blue)';
  } else {
    setEl('v-power', 'offline');
    document.getElementById('v-power').style.color = 'var(--sl400)';
  }

  // ETA
  setEl('eta-val', eta.isStopped?`~${eta.minutes} (จอด)`:String(eta.minutes||'—'));
  setEl('eta-note', eta.trafficLabel||'—');
  setEl('eta-dist', distLabel);

  const ts=v.timestamp?new Date(v.timestamp<1e12?v.timestamp*1000:v.timestamp).toLocaleTimeString('th-TH'):'--';
  setEl('last-ts','อัปเดต: '+ts);
  
  // Update collapsed bottom panel
  updateBottomPanel(v);
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
async function fetchVehicles(){
  try{
    const url = currentRouteId ? `/api/locations?routeId=${currentRouteId}` : '/api/locations';
    const res=await fetch(url);
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
        demoMarkers[id].vData = v; // Store data for analyzeAndHighlight
      });
      Object.keys(demoMarkers).forEach(id=>{
        if(!demoIds.includes(id)){map.removeLayer(demoMarkers[id]);delete demoMarkers[id];}
      });
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
  
  if (!currentRouteId || !allRoutes[currentRouteId]) return;
  const route = allRoutes[currentRouteId];
  if (!route.stops || route.stops.length === 0) return;

  let destLatLng = [route.stops[userDestIdx].lat, route.stops[userDestIdx].lng];
  const distUD = map.distance(userLocation, destLatLng);
  let bestId = null, bestETA = Infinity, bestIsDemo = false, bestVehicleData = null;

  if (!inDemoMode && vehicleIsOnline && realVehicleData){
    const v = realVehicleData;
    if ((v.dynamicDirection || v.direction) === userDesiredDirection || !userDesiredDirection){
      const eta = getETA();
      const distVD = map.distance([v.lat, v.lng], destLatLng);
      if (typeof eta.minutes==='number' && distVD >= distUD - 200 && eta.minutes < bestETA){
        bestETA = eta.minutes; bestId = REAL_VEHICLE_ID; bestIsDemo = false;
        bestVehicleData = v;
      }
    }
  }
  if (inDemoMode){
    Object.keys(demoMarkers).forEach(id => {
      const m = demoMarkers[id]; if (!m || !m.vData) return;
      const v = m.vData;
      if ((v.dynamicDirection || v.direction) === userDesiredDirection || !userDesiredDirection){
        const eta = calcSimETA(v.lat, v.lng, v.speed || 30);
        const distVD = map.distance([v.lat, v.lng], destLatLng);
        if (typeof eta.minutes==='number' && distVD >= distUD - 200 && eta.minutes < bestETA){
          bestETA = eta.minutes; bestId = id; bestIsDemo = true;
          bestVehicleData = v;
        }
      }
    });
  }

  // Reset icons
  if(realVehicleMarker && realVehicleData) realVehicleMarker.setIcon(busMarkerIcon(realVehicleData.speed,true,false,false));
  Object.keys(demoMarkers).forEach(id=>{if(demoMarkers[id]) demoMarkers[id].setIcon(busMarkerIcon(30,true,true,false));});

  if(!bestId){
    userMarker.bindPopup(`<div style="text-align:center;padding:10px;font-family:'Sarabun',sans-serif;color:#94A3B8;font-size:13px;font-weight:600;">ไม่มีรถที่กำลังมาหาคุณในเส้นทางนี้</div>`).openPopup();
    updateInfoCard(null, false); // Clear bottom panel
    return;
  }

  if(!bestIsDemo && realVehicleMarker) realVehicleMarker.setIcon(busMarkerIcon(realVehicleData?.speed||0,true,false,true));
  else if(bestIsDemo && demoMarkers[bestId]) demoMarkers[bestId].setIcon(busMarkerIcon(30,true,true,true));

  // Update Bottom Panel with best vehicle
  updateInfoCard(bestVehicleData, bestIsDemo);

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
loadRoutes();  // Load routes first
fetchVehicles();
setInterval(fetchVehicles, 3000);