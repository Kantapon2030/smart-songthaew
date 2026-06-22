'use strict';

let map, userMarker, routeLine;
let currentRouteId = null, allRoutes = {};
let userLocation = null, selectedVehicleId = null, pinMode = false;
let vehicleMarkers = {}, vehicleData = {};
let etaState = { key: null, value: null, fetchedAt: 0 };
let serverClock = { serverTime: 0, perfAt: 0 };

function serverNow(){
  return serverClock.serverTime + (performance.now() - serverClock.perfAt) / 1000;
}
function vehicleAge(v){ return Math.max(0, Math.floor(serverNow() - (v?.last_seen || 0))); }
function isUsableVehicle(v){ return v && v.status !== 'offline' && v.gps_fix && validPosition(v); }
function validPosition(v){ return Number.isFinite(v?.lat) && Number.isFinite(v?.lng); }
function setText(id, value){ const el=document.getElementById(id); if(el) el.textContent=value; }

async function initMap(){
  await loadGoogleMapsAPI();
  if(!window.google?.maps){ document.getElementById('map').textContent='ไม่สามารถโหลดแผนที่ได้'; return; }
  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 8.50, lng: 99.89 }, zoom: 11, disableDefaultUI: true,
    zoomControl: true, gestureHandling: 'greedy', mapId: 'smart_songthaew_map'
  });
  map.addListener('click', event => {
    if(pinMode) { setDestination([event.latLng.lat(), event.latLng.lng()]); pinMode=false; document.getElementById('btn-pin')?.classList.remove('active'); }
  });
  ensureAdvancedView();
  await loadRoutes();
  await fetchVehicles();
  setInterval(fetchVehicles, 3000);
  setInterval(() => { if(selectedVehicleId) renderInfoCard(vehicleData[selectedVehicleId]); }, 1000);
}

async function loadRoutes(){
  try {
    const { routes } = await fetchPassengerRoutes();
    allRoutes = Object.fromEntries((routes || []).map(route => [route.route_id, route]));
    const select = document.getElementById('route-select');
    select.innerHTML = routes.map(route => `<option value="${route.route_id}">${route.name}</option>`).join('');
    if(routes.length) changeRoute(routes[0].route_id);
  } catch(error) { console.error('[routes]', error); }
}

function changeRoute(routeId){
  const route = allRoutes[routeId]; if(!route || !map) return;
  currentRouteId = routeId;
  document.getElementById('route-select').value = routeId;
  if(routeLine) routeLine.setMap(null);
  const path = (route.coords || []).map(([lat,lng]) => ({lat,lng}));
  routeLine = new google.maps.Polyline({ path, map, strokeColor: route.color || '#1E88E5', strokeWeight: 5, strokeOpacity: .8 });
  if(path.length){ const bounds=new google.maps.LatLngBounds(); path.forEach(point=>bounds.extend(point)); map.fitBounds(bounds, 50); }
  populatePlaceControls(route);
  fetchVehicles();
}

function populatePlaceControls(route){
  const places = route.places || [];
  const options = places.map(place => `<option value="${place.lat},${place.lng}">${place.name}</option>`).join('');
  const origin = document.getElementById('origin-select');
  const destination = document.getElementById('dest-select');
  if(origin){ origin.innerHTML=options; origin.parentElement?.style.setProperty('display','none'); }
  if(destination){ destination.innerHTML=options; destination.value=destination.options[0]?.value || ''; }
  if(!userLocation && places[0]) setDestination([places[0].lat, places[0].lng], false);
}

function updateOdSelection(){
  const select=document.getElementById('dest-select');
  const [lat,lng]=(select?.value || '').split(',').map(Number);
  if(Number.isFinite(lat) && Number.isFinite(lng)) setDestination([lat,lng]);
}

function setDestination(position, refresh=true){
  userLocation=position;
  if(!userMarker){
    const content=document.createElement('div'); content.textContent='📍'; content.style.cssText='font-size:30px;filter:drop-shadow(0 2px 4px #0006);';
    userMarker=new google.maps.marker.AdvancedMarkerElement({map,position:{lat:position[0],lng:position[1]},content,gmpDraggable:true,zIndex:1000});
    userMarker.addListener('dragend',()=>{ const p=userMarker.position; setDestination([p.lat,p.lng]); });
  } else userMarker.position={lat:position[0],lng:position[1]};
  if(refresh){ map.panTo({lat:position[0],lng:position[1]}); selectedVehicleId=null; etaState={key:null,value:null,fetchedAt:0}; chooseNearestVehicle(); renderInfoCard(selectedVehicleId?vehicleData[selectedVehicleId]:null); }
}

function useMyLocation(){
  if(!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(position => {
    setDestination([position.coords.latitude, position.coords.longitude]);
    document.getElementById('btn-gps')?.classList.add('active');
  }, () => {}, {enableHighAccuracy:true,timeout:8000});
}
function togglePinMode(){ pinMode=!pinMode; document.getElementById('btn-pin')?.classList.toggle('active',pinMode); }
function toggleBottomPanel(){ document.getElementById('info-panel')?.classList.toggle('expanded'); }

async function fetchVehicles(){
  if(!map || !currentRouteId) return;
  try {
    const data=await fetchV1Vehicles(currentRouteId);
    serverClock={serverTime:data.server_time,perfAt:performance.now()};
    vehicleData=Object.fromEntries(data.vehicles.map(vehicle=>[vehicle.vehicle_id,vehicle]));
    const ids=new Set();
    for(const vehicle of data.vehicles){
      if(!validPosition(vehicle)) continue;
      ids.add(vehicle.vehicle_id);
      const position={lat:vehicle.lat,lng:vehicle.lng};
      const online=vehicle.status !== 'offline';
      if(!vehicleMarkers[vehicle.vehicle_id]){
        vehicleMarkers[vehicle.vehicle_id]=new google.maps.marker.AdvancedMarkerElement({map,position,content:createVehicleMarkerContent(vehicle.speed,online,false,vehicle.vehicle_id===selectedVehicleId,vehicle.heading),zIndex:500});
        vehicleMarkers[vehicle.vehicle_id].addListener('click',()=>selectVehicle(vehicle.vehicle_id));
      }else{
        smoothMoveMarker(vehicleMarkers[vehicle.vehicle_id],position);
        vehicleMarkers[vehicle.vehicle_id].content=createVehicleMarkerContent(vehicle.speed,online,false,vehicle.vehicle_id===selectedVehicleId,vehicle.heading);
      }
    }
    for(const id of Object.keys(vehicleMarkers)) if(!ids.has(id)){ vehicleMarkers[id].map=null; delete vehicleMarkers[id]; }
    if(!selectedVehicleId || !vehicleData[selectedVehicleId]) chooseNearestVehicle();
    updateMarkerSelection();
    renderInfoCard(selectedVehicleId?vehicleData[selectedVehicleId]:null);
    requestSelectedEta();
    setText('total-active',data.vehicles.filter(v=>v.status==='online').length);
    document.getElementById('live-chip')?.classList.remove('demo');
  } catch(error) {
    console.error('[vehicles]',error);
    setText('live-chip','CONNECTING');
  }
}

function chooseNearestVehicle(){
  if(!userLocation) return;
  const candidates=Object.values(vehicleData).filter(isUsableVehicle);
  if(!candidates.length){ selectedVehicleId=null; return; }
  candidates.sort((a,b)=>haversineKm(a.lat,a.lng,userLocation[0],userLocation[1])-haversineKm(b.lat,b.lng,userLocation[0],userLocation[1]));
  selectedVehicleId=candidates[0].vehicle_id;
}
function selectVehicle(vehicleId){
  selectedVehicleId=vehicleId; etaState={key:null,value:null,fetchedAt:0}; updateMarkerSelection(); renderInfoCard(vehicleData[vehicleId]); requestSelectedEta();
}
function updateMarkerSelection(){
  for(const [id, marker] of Object.entries(vehicleMarkers)){
    const vehicle=vehicleData[id]; if(vehicle) marker.content=createVehicleMarkerContent(vehicle.speed,vehicle.status!=='offline',false,id===selectedVehicleId,vehicle.heading);
  }
}

async function requestSelectedEta(){
  const vehicle=vehicleData[selectedVehicleId];
  if(!userLocation || !isUsableVehicle(vehicle)){ etaState={key:null,value:null,fetchedAt:Date.now()}; renderInfoCard(vehicle); return; }
  const key=`${vehicle.vehicle_id}:${userLocation[0].toFixed(5)},${userLocation[1].toFixed(5)}`;
  if(etaState.key===key && Date.now()-etaState.fetchedAt<30000) return;
  etaState={key,value:null,fetchedAt:Date.now()}; renderInfoCard(vehicle);
  try{
    const params=new URLSearchParams({vehicle_id:vehicle.vehicle_id,destination:`${userLocation[0]},${userLocation[1]}`});
    const response=await fetch(`/api/v1/eta?${params}`,{headers:{'X-Client-Session':getClientSession()}});
    etaState.value=response.ok?await response.json():null;
  }catch(_){ etaState.value=null; }
  etaState.fetchedAt=Date.now(); renderInfoCard(vehicleData[selectedVehicleId]);
}

function renderInfoCard(vehicle){
  if(!vehicle){ setText('card-vid','ยังไม่มีรถออนไลน์'); setText('eta-val','กำลังคำนวณเวลา'); return; }
  const status=vehicle.status || 'offline';
  setText('card-vid',vehicle.vehicle_id); setText('card-dir',`มุ่งหน้า: ${vehicle.direction || '—'}`);
  setText('v-speed',vehicle.speed ?? '--'); setText('v-battery',vehicle.battery ?? '--');
  setText('v-gpsfix',vehicle.gps_fix?'FIX':'NO FIX');
  setText('status-tx',status); setText('status-tx2',status);
  const timestamp=vehicleAge(vehicle); setText('last-ts',`อัปเดต ${timestamp} วินาทีที่แล้ว`);
  const eta=etaState.value;
  if(eta?.eta_min != null){ setText('eta-val',`${eta.eta_min} นาที`); setText('eta-dist',eta.distance_m<1000?`${eta.distance_m} ม.`:`${(eta.distance_m/1000).toFixed(1)} กม.`); setText('eta-note',eta.cached?'Google Maps (cached)':'Google Maps Traffic ETA'); }
  else { setText('eta-val','กำลังคำนวณเวลา'); setText('eta-dist','--'); setText('eta-note',status==='offline'||!vehicle.gps_fix?'รอสัญญาณตำแหน่งรถ':'เลือกจุดหมายเพื่อดู ETA'); }
  setText('collapsed-title',`🚐 ${vehicle.vehicle_id}`); setText('collapsed-eta',eta?.eta_min!=null?`${eta.eta_min} นาที`:'กำลังคำนวณเวลา');
  const raw=document.getElementById('advanced-data'); if(raw) raw.textContent=JSON.stringify(vehicle,null,2);
}

function smoothMoveMarker(marker,to,duration=2000){
  const from=marker.position; if(!from) { marker.position=to; return; }
  const start=performance.now();
  const frame=now=>{ const p=Math.min(1,(now-start)/duration); marker.position={lat:from.lat+(to.lat-from.lat)*p,lng:from.lng+(to.lng-from.lng)*p}; if(p<1)requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
}

function ensureAdvancedView(){
  const panel=document.createElement('aside'); panel.id='advanced-panel'; panel.style.cssText='display:none;position:absolute;z-index:700;top:60px;right:10px;width:min(340px,calc(100% - 20px));max-height:70vh;overflow:auto;background:#202124;color:#fff;border-radius:12px;padding:12px;box-shadow:0 8px 32px #0006;font:12px monospace;';
  panel.innerHTML='<button type="button" style="float:right" onclick="document.getElementById(\'advanced-panel\').style.display=\'none\'">×</button><strong>Advanced View</strong><pre id="advanced-data" style="white-space:pre-wrap;margin-top:12px"></pre>';
  document.body.appendChild(panel);
  const button=document.createElement('button'); button.type='button'; button.textContent='Advanced'; button.className='loc-btn'; button.style.marginTop='8px'; button.onclick=()=>{ panel.style.display=panel.style.display==='none'?'block':'none'; };
  document.querySelector('#left-panel .panel-card')?.appendChild(button);
}

initMap();
