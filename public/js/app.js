/**
 * app.js — Google Maps Edition (User Map View)
 * Google Maps JS API + Traffic Layer + DirectionsRenderer + Smooth Movement
 */
'use strict';

// ── State ─────────────────────────────────────────────────────
let map,trafficLayer,directionsService,directionsRenderer;
let userLocation=[8.445000,99.965000];
try{const s=localStorage.getItem('userPinLocation');if(s){const p=JSON.parse(s);if(p&&p.length===2)userLocation=p;}}catch(e){}

let userDesiredDirection=null,userOriginIdx=0,userDestIdx=1;
let realVehicleData=null,vehicleIsOnline=false;
let userMarker=null,vehicleMarkers={};
let isPinMode=false,offlineInterval=null,offlineSecs=0,isBottomPanelExpanded=false;
let currentRouteId=null,allRoutes={};
let _etaCache={minutes:null,distKm:null,rawM:null,isStopped:false,trafficLabel:'',computedAt:0};
let _prevPositions={};

// ── Initialize Google Maps ────────────────────────────────────
async function initMap(){
  await loadGoogleMapsAPI();
  if(!window.google?.maps){document.getElementById('map').innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;font-family:Inter,Sarabun,sans-serif;color:#5F6368;font-size:1rem;">⚠️ Google Maps API Key ไม่ได้ตั้งค่า — กรุณาตั้งค่าใน .env</div>';return;}

  const {Map}=google.maps;
  map=new Map(document.getElementById('map'),{
    center:{lat:userLocation[0],lng:userLocation[1]},zoom:14,
    mapId:'smart_songthaew_map',
    disableDefaultUI:true,zoomControl:true,zoomControlOptions:{position:google.maps.ControlPosition.LEFT_BOTTOM},
    styles:[{featureType:'poi',stylers:[{visibility:'off'}]},{featureType:'transit',stylers:[{visibility:'off'}]}],
    gestureHandling:'greedy',
  });

  trafficLayer=new google.maps.TrafficLayer();
  trafficLayer.setMap(map);

  directionsService=new google.maps.DirectionsService();
  directionsRenderer=new google.maps.DirectionsRenderer({map,suppressMarkers:true,polylineOptions:{strokeColor:'#4285F4',strokeWeight:5,strokeOpacity:0.8}});

  // User marker
  const userEl=document.createElement('div');
  userEl.innerHTML='<div style="font-size:36px;filter:drop-shadow(0 3px 8px rgba(0,0,0,.3));cursor:grab;line-height:1;">🧍‍♂️</div>';
  userMarker=new google.maps.marker.AdvancedMarkerElement({map,position:{lat:userLocation[0],lng:userLocation[1]},content:userEl,gmpDraggable:true,zIndex:1000});
  userMarker.addListener('dragend',()=>{
    const p=userMarker.position;userLocation=[p.lat,p.lng];saveUserLocation();analyzeAndHighlight();
  });

  loadRoutes();
  fetchVehicles();
  setInterval(fetchVehicles,3000);
}

// ── Bottom Panel ──────────────────────────────────────────────
function toggleBottomPanel(){
  isBottomPanelExpanded=!isBottomPanelExpanded;
  const panel=document.getElementById('info-panel');
  if(isBottomPanelExpanded)panel.classList.add('expanded');else panel.classList.remove('expanded');
  updateBottomPanel();
}

function updateBottomPanel(vehicleData=null){
  const vehicle=vehicleData||realVehicleData;
  const ct=document.getElementById('collapsed-title'),ce=document.getElementById('collapsed-eta');
  if(ct&&vehicle){const spd=vehicle.speed||0;ct.textContent=`🚐 ${spd} km/h`;}
  if(ce){
    const eta=_etaCache.minutes;
    if(eta!=null){const d=_etaCache.distKm;const dt=d<1?`${Math.round(d*1000)} ม.`:`${d.toFixed(1)} กม.`;ce.textContent=`⏱️ ${eta} นาที (${dt})`;}
    else ce.textContent='กำลังคำนวณ ETA...';
  }
}

// ── Route Management ──────────────────────────────────────────
async function loadRoutes(){
  try{
    allRoutes=await fetchRoutes();
    const select=document.getElementById('route-select');
    if(select){
      select.innerHTML=Object.entries(allRoutes).map(([id,r])=>`<option value="${id}">${r.name}</option>`).join('');
      if(!currentRouteId&&select.options.length>0){currentRouteId=select.options[0].value;select.value=currentRouteId;changeRoute(currentRouteId);}
    }
  }catch(e){console.error('Routes:',e);}
}

function changeRoute(routeId){
  if(!routeId||!allRoutes[routeId])return;
  currentRouteId=routeId;
  const route=allRoutes[routeId];

  // Render directions on real roads
  if(route.stops&&route.stops.length>=2&&directionsService&&directionsRenderer){
    const origin={lat:route.stops[0].lat,lng:route.stops[0].lng};
    const dest={lat:route.stops[route.stops.length-1].lat,lng:route.stops[route.stops.length-1].lng};
    const waypoints=route.stops.slice(1,-1).map(s=>({location:{lat:s.lat,lng:s.lng},stopover:true}));
    directionsService.route({origin,destination:dest,waypoints,travelMode:'DRIVING'},(result,status)=>{
      if(status==='OK'){directionsRenderer.setDirections(result);
        const bounds=new google.maps.LatLngBounds();
        result.routes[0].overview_path.forEach(p=>bounds.extend(p));map.fitBounds(bounds,60);
      }else{
        // Fallback: simple polyline
        if(route.coords&&route.coords.length>1){
          const path=route.coords.map(c=>({lat:c[0],lng:c[1]}));
          directionsRenderer.setDirections({routes:[]});
          new google.maps.Polyline({path,strokeColor:'#4285F4',strokeWeight:5,strokeOpacity:0.7,map});
        }
      }
    });
  }

  // Populate Origin/Destination
  const os=document.getElementById('origin-select'),ds=document.getElementById('dest-select');
  if(os&&ds&&route.stops){
    let opts='';route.stops.forEach((s,i)=>{opts+=`<option value="${i}">${s.name}</option>`;});
    os.innerHTML=opts;ds.innerHTML=opts;os.value=0;ds.value=route.stops.length-1;
    updateOdSelection(false);
  }
  refreshLocations();
}

function updateOdSelection(refresh=true){
  const os=document.getElementById('origin-select'),ds=document.getElementById('dest-select');
  if(!os||!ds||!currentRouteId||!allRoutes[currentRouteId])return;
  const oIdx=parseInt(os.value),dIdx=parseInt(ds.value);
  const route=allRoutes[currentRouteId];
  userOriginIdx=oIdx;userDestIdx=dIdx;
  if(oIdx===dIdx)userDesiredDirection=null;
  else userDesiredDirection=dIdx>oIdx?route.stops[route.stops.length-1].name:route.stops[0].name;
  if(refresh)analyzeAndHighlight();
}

async function refreshLocations(){await fetchVehicles();}

// ── ETA via Google Distance Matrix ────────────────────────────
async function fetchTrafficETA(vLat,vLng){
  try{
    const r=await fetch(`/api/maps/eta?origin=${vLat},${vLng}&destination=${userLocation[0]},${userLocation[1]}`).then(r=>r.json());
    if(r.duration_in_traffic){
      const mins=Math.round(r.duration_in_traffic.value/60);
      const distKm=(r.distance?.value||0)/1000;
      _etaCache={minutes:mins,distKm,rawM:r.distance?.value||0,isStopped:false,trafficLabel:'🟢 Google Maps Traffic ETA',computedAt:Date.now()};
    }else if(r.duration){
      const mins=Math.round(r.duration.value/60);
      const distKm=(r.distance?.value||0)/1000;
      _etaCache={minutes:mins,distKm,rawM:r.distance?.value||0,isStopped:false,trafficLabel:'🟡 ETA (ไม่มี traffic data)',computedAt:Date.now()};
    }
  }catch(e){
    // Fallback: haversine
    const distKm=haversineKm(vLat,vLng,userLocation[0],userLocation[1]);
    _etaCache={minutes:Math.max(1,Math.round(distKm/30*60)),distKm,rawM:distKm*1000,isStopped:false,trafficLabel:'🔴 Offline ETA',computedAt:Date.now()};
  }
  return _etaCache;
}

function calcLocalETA(vLat,vLng,spd){
  const distKm=haversineKm(vLat,vLng,userLocation[0],userLocation[1]);
  const speed=spd<1?30:spd;
  const mins=Math.max(1,Math.round((distKm/speed)*60));
  return{minutes:mins,distKm,rawM:distKm*1000,isStopped:spd<1,trafficLabel:'🟡 ประเมินจากความเร็ว'};
}

function saveUserLocation(){localStorage.setItem('userPinLocation',JSON.stringify(userLocation));}

// ── Config hook ───────────────────────────────────────────────
function onConfigChanged(cfg){
  const dc=document.getElementById('demo-chip');
  if(dc)dc.style.display=cfg.demoMode?'flex':'none';
  renderAnnouncement(cfg.announcement);
}

// ── Location Buttons ──────────────────────────────────────────
function useMyLocation(){
  if(!navigator.geolocation){alert('เบราว์เซอร์ไม่รองรับ GPS');return;}
  const btn=document.getElementById('btn-gps');btn?.classList.add('active');
  navigator.geolocation.getCurrentPosition(pos=>{
    userLocation=[pos.coords.latitude,pos.coords.longitude];
    userMarker.position={lat:userLocation[0],lng:userLocation[1]};
    map.panTo({lat:userLocation[0],lng:userLocation[1]});
    saveUserLocation();analyzeAndHighlight();btn?.classList.remove('active');
  },()=>{alert('ไม่สามารถดึงตำแหน่งได้');btn?.classList.remove('active');},{enableHighAccuracy:true,timeout:8000});
}

function togglePinMode(){
  isPinMode=!isPinMode;
  const btn=document.getElementById('btn-pin');btn?.classList.toggle('active',isPinMode);
  if(map)map.getDiv().style.cursor=isPinMode?'crosshair':'';
  if(isPinMode){
    const listener=map.addListener('click',e=>{
      userLocation=[e.latLng.lat(),e.latLng.lng()];
      userMarker.position={lat:userLocation[0],lng:userLocation[1]};
      saveUserLocation();analyzeAndHighlight();
      isPinMode=false;btn?.classList.remove('active');map.getDiv().style.cursor='';
      google.maps.event.removeListener(listener);
    });
  }
}

// ── Offline/Online ────────────────────────────────────────────
function handleOffline(){
  if(!vehicleIsOnline)return;vehicleIsOnline=false;
  document.getElementById('offline-banner')?.classList.add('show');
  offlineSecs=0;clearInterval(offlineInterval);
  offlineInterval=setInterval(()=>{offlineSecs++;const el=document.getElementById('offline-secs');if(el)el.textContent=`(${offlineSecs}s)`;},1000);
  setEl('eta-val','ไม่มีสัญญาณ');setEl('eta-note','รอ GPS...');
}

function handleOnline(){
  if(vehicleIsOnline)return;vehicleIsOnline=true;
  clearInterval(offlineInterval);
  document.getElementById('offline-banner')?.classList.remove('show');
}

function setEl(id,text,color){const e=document.getElementById(id);if(!e)return;e.textContent=text;if(color)e.style.color=color;}

// ── Update info card ──────────────────────────────────────────
function updateInfoCard(v,isDemo){
  if(!v){
    setEl('card-vid','ไม่มีรถในระบบ');setEl('card-dir','สถานะ: offline');
    setEl('v-speed','--');setEl('v-battery','--');setEl('eta-val','ไม่มีรถ');setEl('eta-note','กรุณารอรถจริง');setEl('eta-dist','--');setEl('last-ts','--');
    const ct=document.getElementById('collapsed-title'),ce=document.getElementById('collapsed-eta');
    if(ct)ct.textContent='ไม่มีรถในระบบ';if(ce)ce.textContent='รอข้อมูล...';
    return;
  }
  const eta=_etaCache;
  const distLabel=eta.distKm!=null?(eta.distKm<1?`${Math.round(eta.distKm*1000)} ม.`:`${eta.distKm.toFixed(2)} กม.`):'--';
  const spd=v.speed||0;

  setEl('card-vid',isDemo?`🎬 TWIN_01`:(v.vehicleId||REAL_VEHICLE_ID));
  setEl('card-dir',`มุ่งหน้า: ${v.direction||'—'}`);
  setEl('v-speed',spd);

  const bat=(v.battery!=null&&v.battery>=0)?v.battery:null;
  if(bat!==null){setEl('v-battery',bat);const bc=bat<20?'#EA4335':bat<50?'#FBBC04':'#34A853';
    const bel=document.getElementById('v-battery');if(bel)bel.style.color=bc;
    const bar=document.getElementById('bat-bar');if(bar){bar.style.width=bat+'%';bar.style.background=bc;}
  }else{setEl('v-battery','--');}

  setEl('eta-val',eta.isStopped?`~${eta.minutes} (จอด)`:String(eta.minutes||'—'));
  setEl('eta-note',eta.trafficLabel||'—');setEl('eta-dist',distLabel);

  const ts=v.timestamp?new Date(v.timestamp<1e12?v.timestamp*1000:v.timestamp).toLocaleTimeString('th-TH'):'--';
  setEl('last-ts','อัปเดต: '+ts);
  updateBottomPanel(v);
}

// ── Smooth marker movement ────────────────────────────────────
function smoothMoveMarker(marker,newPos,duration=2500){
  if(!marker||!marker.position)return;
  const start={lat:marker.position.lat,lng:marker.position.lng};
  const end=newPos;
  const startTime=performance.now();
  function animate(now){
    const elapsed=now-startTime;const t=Math.min(elapsed/duration,1);
    const lat=start.lat+(end.lat-start.lat)*t;
    const lng=start.lng+(end.lng-start.lng)*t;
    marker.position={lat,lng};
    if(t<1)requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

// ── Fetch Vehicles ────────────────────────────────────────────
let _lastEtaFetch=0;
async function fetchVehicles(){
  if(!map)return;
  try{
    const url=currentRouteId?`/api/locations?routeId=${currentRouteId}`:'/api/locations';
    const data=await fetch(url).then(r=>r.json());
    const inDemoMode=window.SYS?.demoMode??false;

    // Collect all vehicle IDs to track
    const allIds=new Set();

    for(const [id,val] of Object.entries(data)){
      if(!val?.current)continue;
      const v=val.current;
      const isDemoV=id.startsWith('TWIN_')||id.startsWith('DEMO_');
      if(!inDemoMode&&isDemoV)continue;
      if(inDemoMode&&!isDemoV)continue;

      allIds.add(id);
      const online=isVehicleOnline(v);
      const newPos={lat:v.lat,lng:v.lng};

      if(!vehicleMarkers[id]){
        const content=createVehicleMarkerContent(v.speed,online,isDemoV,false);
        vehicleMarkers[id]=new google.maps.marker.AdvancedMarkerElement({map,position:newPos,content,zIndex:500});
        vehicleMarkers[id].addListener('click',()=>updateInfoCard(v,isDemoV));
      }else{
        smoothMoveMarker(vehicleMarkers[id],newPos);
        vehicleMarkers[id].content=createVehicleMarkerContent(v.speed,online,isDemoV,false);
      }
      vehicleMarkers[id]._vData=v;
      vehicleMarkers[id]._isDemo=isDemoV;

      if(!isDemoV&&id===REAL_VEHICLE_ID){
        if(!online)handleOffline();else{handleOnline();realVehicleData=v;}
      }
      if(isDemoV&&inDemoMode){handleOnline();realVehicleData=v;}
    }

    // Remove stale markers
    for(const id of Object.keys(vehicleMarkers)){
      if(!allIds.has(id)){vehicleMarkers[id].map=null;delete vehicleMarkers[id];}
    }

    // ETA (throttled)
    if(realVehicleData&&(Date.now()-_lastEtaFetch>15000)){
      _lastEtaFetch=Date.now();
      fetchTrafficETA(realVehicleData.lat,realVehicleData.lng);
    }else if(realVehicleData){
      const e=calcLocalETA(realVehicleData.lat,realVehicleData.lng,realVehicleData.speed||0);
      if(!_etaCache.minutes)_etaCache=e;
    }

    const activeCount=Object.keys(vehicleMarkers).length;
    setEl('total-active',activeCount);
    analyzeAndHighlight();
  }catch(e){console.error('[app]',e);}
}

// ── Analyze & Highlight ───────────────────────────────────────
function analyzeAndHighlight(){
  if(!currentRouteId||!allRoutes[currentRouteId])return;
  const route=allRoutes[currentRouteId];
  if(!route.stops||!route.stops.length)return;

  const destStop=route.stops[userDestIdx];
  if(!destStop)return;
  let bestId=null,bestDist=Infinity,bestV=null,bestIsDemo=false;

  for(const [id,marker] of Object.entries(vehicleMarkers)){
    const v=marker._vData;if(!v)continue;
    const dist=haversineKm(v.lat,v.lng,userLocation[0],userLocation[1]);
    if(dist<bestDist){bestDist=dist;bestId=id;bestV=v;bestIsDemo=marker._isDemo;}
  }

  // Reset all markers
  for(const [id,marker] of Object.entries(vehicleMarkers)){
    const v=marker._vData;if(!v)continue;
    marker.content=createVehicleMarkerContent(v.speed,true,marker._isDemo,id===bestId);
  }

  if(!bestId){updateInfoCard(null,false);return;}
  updateInfoCard(bestV,bestIsDemo);
}

// ── Boot ──────────────────────────────────────────────────────
initMap();