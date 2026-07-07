'use strict';

let map;
let routeLine;
let destinationMarker;
let originMarker;
let originClickListener;
let currentRouteId = null;
let currentDirection = 'outbound';
let selectedOrigin = null;
let selectedDestination = null;
let selectedVehicleId = null;
let routesById = {};
let vehicleData = {};
let vehicleMarkers = {};
let vehicleSpeedDisplay = {};
let stopMarkers = [];
let etaState = { key: null, value: null, fetchedAt: 0 };
let serverClock = { serverTime: 0, perfAt: 0 };
const VEHICLE_POLL_INTERVAL_MS = 3500;
const VEHICLE_ANIMATION_DURATION_MS = VEHICLE_POLL_INTERVAL_MS - 200;

document.addEventListener('DOMContentLoaded', initPassengerPage);

async function initPassengerPage() {
  renderSharedNavbar({
    active: 'home',
    fixed: true,
    onRouteChange(routeId) {
      if (routeId && routeId !== currentRouteId) changeRoute(routeId);
    },
  });
  document.getElementById('vehicle-image').innerHTML = busSvg(34, '#2563EB');
  document.getElementById('mesh-toggle-icon').innerHTML = antennaSvg(16, '#64748B');
  document.getElementById('current-location-icon').innerHTML = pinSvg(14, '#334155');
  document.getElementById('drop-pin-icon').innerHTML = pinSvg(14, '#334155');
  bindPassengerControls();
  await initMap();
}

function bindPassengerControls() {
  document.querySelectorAll('.direction-row button').forEach(button => {
    button.addEventListener('click', () => {
      currentDirection = button.dataset.direction;
      document.querySelectorAll('.direction-row button').forEach(item => item.classList.toggle('active', item === button));
      const route = routesById[currentRouteId];
      if (route) {
        drawRoute(route);
        drawStops(route);
        selectedDestination = directionStops(route)[0] || null;
        if (selectedDestination) setDestination(selectedDestination, false);
        renderPopularDestinations();
      }
      renderRecommendedStops();
      requestSelectedEta(true);
    });
  });

  document.getElementById('destination-search').addEventListener('input', renderPopularDestinations);
  document.getElementById('use-current-location-btn').addEventListener('click', useCurrentLocationAsOrigin);
  document.getElementById('drop-origin-pin-btn').addEventListener('click', toggleOriginPinMode);
  document.getElementById('show-route-btn').addEventListener('click', () => {
    const destination = selectedDestination || directionStops(routesById[currentRouteId])[0];
    if (destination) setDestination(destination);
  });
  document.getElementById('swap-route-btn').addEventListener('click', () => {
    const ids = Object.keys(routesById);
    if (!ids.length) return;
    const index = ids.indexOf(currentRouteId);
    changeRoute(ids[(index + 1) % ids.length]);
  });
  document.getElementById('route-select').addEventListener('change', event => changeRoute(event.target.value));
  document.getElementById('mesh-toggle-wrap').addEventListener('click', toggleMeshOverlay);
}

async function initMap() {
  await loadGoogleMapsAPI();
  const mapEl = document.getElementById('map');
  if (!window.google?.maps) {
    mapEl.textContent = 'ไม่สามารถโหลดแผนที่ได้';
    return;
  }

  map = new google.maps.Map(mapEl, {
    center: { lat: 8.50, lng: 99.89 },
    zoom: 11,
    mapId: 'smart_songthaew_map',
    disableDefaultUI: true,
    zoomControl: true,
    gestureHandling: 'greedy',
  });

  if (window.MeshOverlay) window.MeshOverlay.init(map);
  await loadRoutes();
  await fetchVehicles();
  setInterval(fetchVehicles, VEHICLE_POLL_INTERVAL_MS);
  setInterval(() => renderVehicleCard(vehicleData[selectedVehicleId]), 1000);
}

async function loadRoutes() {
  try {
    const { routes } = await fetchPassengerRoutes();
    routesById = Object.fromEntries((routes || []).map(route => [route.route_id, route]));
    const localSelect = document.getElementById('route-select');
    localSelect.innerHTML = routes.map(route => `<option value="${route.route_id}">${route.name}</option>`).join('');
    const sharedValue = document.getElementById('shared-route-select')?.value;
    changeRoute(sharedValue && routesById[sharedValue] ? sharedValue : routes[0]?.route_id);
  } catch (error) {
    console.error('[routes]', error);
  }
}

function changeRoute(routeId) {
  const route = routesById[routeId];
  if (!route || !map) return;
  currentRouteId = routeId;
  const localSelect = document.getElementById('route-select');
  const sharedSelect = document.getElementById('shared-route-select');
  if (localSelect) localSelect.value = routeId;
  if (sharedSelect && sharedSelect.value !== routeId) sharedSelect.value = routeId;
  sessionStorage.setItem('smartSongthaewRoute', routeId);
  if (!directionCoords(route, currentDirection).length && directionCoords(route, 'outbound').length) {
    currentDirection = 'outbound';
  }
  renderDirectionButtons(route);

  drawRoute(route);
  drawStops(route);
  selectedDestination = directionStops(route)[0] || routeStops(route)[0] || null;
  if (selectedDestination) setDestination(selectedDestination, false);
  renderPopularDestinations();
  renderRecommendedStops();
  fetchVehicles();
}

function drawRoute(route) {
  if (routeLine) routeLine.setMap(null);
  const path = directionCoords(route, currentDirection).map(point => ({ lat: Number(point.lat), lng: Number(point.lng) }));
  routeLine = new google.maps.Polyline({
    path,
    map,
    strokeColor: routeColor(route),
    strokeWeight: 5,
    strokeOpacity: 0.9,
  });
  if (path.length) {
    const bounds = new google.maps.LatLngBounds();
    path.forEach(point => bounds.extend(point));
    map.fitBounds(bounds, 64);
  }
}

function drawStops(route) {
  stopMarkers.forEach(marker => { marker.map = null; });
  stopMarkers = [];
  directionStops(route).forEach(stop => {
    if (!Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lng))) return;
    const marker = new google.maps.marker.AdvancedMarkerElement({
      map,
      position: { lat: Number(stop.lat), lng: Number(stop.lng) },
      content: createStopMarkerContent(false),
      title: stop.name,
      zIndex: 300,
    });
    marker.addListener('click', () => setDestination(stop));
    stopMarkers.push(marker);
  });
}

function renderPopularDestinations() {
  const route = routesById[currentRouteId];
  const query = document.getElementById('destination-search').value.trim().toLowerCase();
  const stops = directionStops(route).filter(stop => !query || String(stop.name).toLowerCase().includes(query)).slice(0, 8);
  const root = document.getElementById('popular-destinations');
  root.innerHTML = stops.length ? stops.map((stop, index) => `
    <button class="destination-button ${selectedDestination?.name === stop.name ? 'active' : ''}" type="button" data-index="${index}">
      <span class="item-icon" aria-hidden="true">${pinSvg(17, '#2563EB')}</span>
      <span>${stop.name}</span>
    </button>`).join('') : '<div class="empty-state" style="grid-column:1/-1;">ไม่พบจุดหมาย</div>';
  [...root.querySelectorAll('button')].forEach((button, index) => {
    button.addEventListener('click', () => setDestination(stops[index]));
  });
}

async function renderRecommendedStops() {
  const route = routesById[currentRouteId];
  const stops = recommendedStops(route);
  const root = document.getElementById('recommended-stops');
  if (!stops.length) {
    root.innerHTML = '<div class="empty-state">ยังไม่มีจุดจอดในเส้นทางนี้</div>';
    return;
  }

  root.innerHTML = stops.map(stop => `
    <button class="recommended-item" type="button" data-name="${stop.name}">
      <div>
        <div class="recommended-name">${stop.name}</div>
        <div class="recommended-meta" id="stop-meta-${safeId(stop.name)}">กำลังคำนวณเวลา</div>
      </div>
      <span class="item-icon" aria-hidden="true">${signalSvg(18, '#2563EB')}</span>
    </button>`).join('');
  [...root.querySelectorAll('button')].forEach((button, index) => {
    button.addEventListener('click', () => setDestination(stops[index]));
  });
  updateStopEtas(stops);
}

function directionStops(route) {
  const directional = directionStopsForRoute(route, currentDirection);
  if (directional.length) return directional;
  const stops = [...routeStops(route)];
  return currentDirection === 'inbound' ? stops.reverse() : stops;
}

function recommendedStops(route) {
  const stops = directionStops(route);
  if (!selectedOrigin) return stops.slice(0, 5);
  return stops
    .map(stop => ({
      ...stop,
      originDistanceKm: haversineKm(selectedOrigin.lat, selectedOrigin.lng, stop.lat, stop.lng),
    }))
    .sort((a, b) => a.originDistanceKm - b.originDistanceKm)
    .slice(0, 5);
}

function renderDirectionButtons(route) {
  document.querySelectorAll('.direction-row button').forEach(button => {
    const dir = button.dataset.direction;
    const direction = routeDirection(route, dir);
    const hasData = directionCoords(route, dir).length || directionStopsForRoute(route, dir).length;
    button.textContent = direction?.label || (dir === 'inbound' ? 'ขากลับ' : 'ขาไป');
    button.disabled = !hasData;
    button.classList.toggle('active', dir === currentDirection);
  });
}

async function updateStopEtas(stops) {
  const origin = selectedOrigin
    ? `${selectedOrigin.lat},${selectedOrigin.lng}`
    : selectedVehicleId && vehicleData[selectedVehicleId]
      ? `${vehicleData[selectedVehicleId].lat},${vehicleData[selectedVehicleId].lng}`
      : selectedDestination
        ? `${selectedDestination.lat},${selectedDestination.lng}`
        : null;
  if (!origin) return;
  for (const stop of stops) {
    const meta = document.getElementById(`stop-meta-${safeId(stop.name)}`);
    if (!meta || !Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lng))) continue;
    const distanceBase = selectedOrigin || selectedDestination;
    const distance = distanceBase ? haversineKm(distanceBase.lat, distanceBase.lng, stop.lat, stop.lng) : null;
    try {
      const data = await fetchMapsEta(origin, `${stop.lat},${stop.lng}`);
      meta.textContent = `${formatDistanceKm(distance)} • ${formatMinutes(data.eta_min)}`;
    } catch (_) {
      meta.textContent = `${formatDistanceKm(distance)} • ETA —`;
    }
  }
}

function setDestination(stop, refresh = true) {
  if (!stop) return;
  selectedDestination = stop;
  const position = { lat: Number(stop.lat), lng: Number(stop.lng) };
  if (!destinationMarker) {
    destinationMarker = new google.maps.marker.AdvancedMarkerElement({
      map,
      position,
      content: destinationMarkerContent(),
      title: stop.name,
      zIndex: 900,
    });
  } else {
    destinationMarker.position = position;
    destinationMarker.title = stop.name;
  }
  if (refresh) {
    map.panTo(position);
    chooseNearestVehicle();
    requestSelectedEta(true);
  }
  renderPopularDestinations();
  renderRecommendedStops();
}

function destinationMarkerContent() {
  const el = document.createElement('div');
  el.style.cssText = 'width:34px;height:34px;border-radius:50%;background:#2563EB;color:#fff;display:flex;align-items:center;justify-content:center;border:3px solid #fff;box-shadow:0 8px 22px rgba(37,99,235,.35);';
  el.innerHTML = pinSvg(18, '#fff');
  return el;
}

function useCurrentLocationAsOrigin() {
  if (!navigator.geolocation) {
    updateOriginStatus('เบราว์เซอร์นี้ไม่รองรับการอ่านตำแหน่ง');
    return;
  }
  setOriginPickMode(false);
  updateOriginStatus('กำลังขอตำแหน่งปัจจุบัน...');
  navigator.geolocation.getCurrentPosition(position => {
    setOrigin({
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      name: 'ตำแหน่งปัจจุบัน',
    }, { pan: true });
  }, () => {
    updateOriginStatus('ไม่สามารถอ่านตำแหน่งได้ กรุณาอนุญาตตำแหน่งหรือใช้วางหมุด');
  }, { enableHighAccuracy: true, timeout: 9000, maximumAge: 30000 });
}

function toggleOriginPinMode() {
  if (!map || !window.google?.maps) {
    updateOriginStatus('ยังไม่สามารถใช้แผนที่เพื่อวางหมุดได้');
    return;
  }
  setOriginPickMode(!originClickListener);
}

function setOriginPickMode(enabled) {
  const button = document.getElementById('drop-origin-pin-btn');
  if (!map || !window.google?.maps) return;
  if (!enabled) {
    if (originClickListener) {
      google.maps.event.removeListener(originClickListener);
      originClickListener = null;
    }
    document.body.classList.remove('origin-pick-mode');
    if (button) button.className = 'button ghost';
    return;
  }
  if (originClickListener) return;
  document.body.classList.add('origin-pick-mode');
  if (button) button.className = 'button primary';
  updateOriginStatus('คลิกบนแผนที่เพื่อวางหมุดตำแหน่งของคุณ');
  originClickListener = map.addListener('click', event => {
    setOrigin({
      lat: event.latLng.lat(),
      lng: event.latLng.lng(),
      name: 'ตำแหน่งที่เลือก',
    }, { pan: false });
    setOriginPickMode(false);
  });
}

function setOrigin(point, options = {}) {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  selectedOrigin = { lat, lng, name: point.name || 'ตำแหน่งของคุณ' };
  const position = { lat, lng };
  if (!originMarker) {
    originMarker = new google.maps.marker.AdvancedMarkerElement({
      map,
      position,
      content: originMarkerContent(),
      title: selectedOrigin.name,
      zIndex: 950,
    });
  } else {
    originMarker.position = position;
    originMarker.title = selectedOrigin.name;
  }
  if (options.pan) map.panTo(position);
  updateOriginStatus(`${selectedOrigin.name}: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  chooseNearestVehicle();
  requestSelectedEta(true);
  renderVehicleCard(vehicleData[selectedVehicleId]);
  renderRecommendedStops();
}

function originMarkerContent() {
  const el = document.createElement('div');
  el.style.cssText = 'width:34px;height:34px;border-radius:50%;background:#16A34A;color:#fff;display:flex;align-items:center;justify-content:center;border:3px solid #fff;box-shadow:0 8px 22px rgba(22,163,74,.35);';
  el.innerHTML = pinSvg(18, '#fff');
  return el;
}

function updateOriginStatus(message) {
  const el = document.getElementById('origin-status');
  if (el) el.textContent = message || '';
}

async function fetchVehicles() {
  if (!currentRouteId || !map) return;
  try {
    const data = await fetchVehicleLocations(currentRouteId);
    serverClock = { serverTime: data.server_time || Date.now() / 1000, perfAt: performance.now() };
    const visibleVehicles = (data.vehicles || []).filter(vehicle => window.SYS?.demoMode || !isDemoVehicle(vehicle));
    vehicleData = Object.fromEntries(visibleVehicles.map(vehicle => [vehicle.vehicle_id, vehicle]));
    renderVehicleMarkers(visibleVehicles);
    if (!selectedVehicleId || !vehicleData[selectedVehicleId]) chooseNearestVehicle();
    requestSelectedEta();
    renderVehicleCard(vehicleData[selectedVehicleId]);
    renderRecommendedStops();
    updateVehicleNotice(selectedVehicleId ? '' : (visibleVehicles.some(vehicle => vehicle.status === 'online') ? 'ไม่มีรถที่กำลังมาถึงจุดนี้' : ''));
  } catch (error) {
    console.error('[vehicles]', error);
  }
}

function renderVehicleMarkers(vehicles) {
  const ids = new Set();
  vehicles.forEach(vehicle => {
    ids.add(vehicle.vehicle_id);
    const position = { lat: vehicle.lat, lng: vehicle.lng };
    const online = vehicle.status === 'online' && vehicle.speed > 0;
    const selected = vehicle.vehicle_id === selectedVehicleId;
    if (!vehicleMarkers[vehicle.vehicle_id]) {
      vehicleMarkers[vehicle.vehicle_id] = new google.maps.marker.AdvancedMarkerElement({
        map,
        position,
        content: createVehicleMarkerContent(vehicle.speed, online, false, selected, vehicle.heading),
        title: vehicle.vehicle_id,
        zIndex: selected ? 600 : 500,
      });
      vehicleMarkers[vehicle.vehicle_id].addListener('click', () => selectVehicle(vehicle.vehicle_id));
    } else {
      smoothMoveMarker(vehicleMarkers[vehicle.vehicle_id], position.lat, position.lng, VEHICLE_ANIMATION_DURATION_MS);
      vehicleMarkers[vehicle.vehicle_id].content = createVehicleMarkerContent(vehicle.speed, online, false, selected, vehicle.heading);
      vehicleMarkers[vehicle.vehicle_id].zIndex = selected ? 600 : 500;
    }
  });
  Object.keys(vehicleMarkers).forEach(id => {
    if (!ids.has(id)) {
      if (vehicleMarkers[id]._animFrame) cancelAnimationFrame(vehicleMarkers[id]._animFrame);
      vehicleMarkers[id].map = null;
      delete vehicleMarkers[id];
      delete vehicleSpeedDisplay[id];
    }
  });
}

function setVehicleMotionTarget(vehicleId, target) {
  const marker = vehicleMarkers[vehicleId];
  if (!marker) return;
  smoothMoveMarker(marker, target.lat, target.lng, VEHICLE_ANIMATION_DURATION_MS);
}

function setMarkerPosition(marker, lat, lng) {
  const pos = new google.maps.LatLng(Number(lat), Number(lng));
  if (typeof marker.setPosition === 'function') {
    marker.setPosition(pos);
  } else {
    marker.position = pos;
  }
}

function smoothMoveMarker(marker, newLat, newLng, durationMs = VEHICLE_ANIMATION_DURATION_MS) {
  if (!marker || !window.google?.maps) return;
  const targetLat = Number(newLat);
  const targetLng = Number(newLng);
  if (!Number.isFinite(targetLat) || !Number.isFinite(targetLng)) return;
  if (marker._animFrame) cancelAnimationFrame(marker._animFrame);

  const start = markerPosition(marker) || { lat: targetLat, lng: targetLng };
  const startTime = performance.now();
  const distanceM = haversineKm(start.lat, start.lng, targetLat, targetLng) * 1000;
  if (!Number.isFinite(distanceM) || distanceM > 500 || durationMs <= 0) {
    setMarkerPosition(marker, targetLat, targetLng);
    return;
  }

  const step = now => {
    const elapsed = now - startTime;
    const t = Math.min(elapsed / durationMs, 1);
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const lat = start.lat + (targetLat - start.lat) * ease;
    const lng = start.lng + (targetLng - start.lng) * ease;
    setMarkerPosition(marker, lat, lng);
    if (t < 1) {
      marker._animFrame = requestAnimationFrame(step);
    } else {
      marker._animFrame = null;
    }
  };
  marker._animFrame = requestAnimationFrame(step);
}

function markerPosition(marker) {
  const position = marker?.position;
  if (!position) return null;
  const lat = typeof position.lat === 'function' ? position.lat() : position.lat;
  const lng = typeof position.lng === 'function' ? position.lng() : position.lng;
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) ? { lat: Number(lat), lng: Number(lng) } : null;
}

function routeCoordsForEta() {
  const route = routesById[currentRouteId];
  const outbound = directionCoords(route, 'outbound');
  if (outbound.length) return outbound;
  return directionCoords(route, currentDirection);
}

function snapToRoute(lat, lng, routeCoords) {
  const targetLat = Number(lat);
  const targetLng = Number(lng);
  if (!Number.isFinite(targetLat) || !Number.isFinite(targetLng) || !Array.isArray(routeCoords) || !routeCoords.length) return -1;
  let bestIndex = -1;
  let bestDistance = Infinity;
  routeCoords.forEach((point, index) => {
    const distance = haversineKm(targetLat, targetLng, point.lat, point.lng);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function routeDistanceKm(routeCoords, fromIdx, toIdx) {
  if (!Array.isArray(routeCoords) || routeCoords.length < 2) return 0;
  const start = Math.max(0, Math.min(routeCoords.length - 1, Math.min(fromIdx, toIdx)));
  const end = Math.max(0, Math.min(routeCoords.length - 1, Math.max(fromIdx, toIdx)));
  let distance = 0;
  for (let index = start; index < end; index += 1) {
    const from = routeCoords[index];
    const to = routeCoords[index + 1];
    distance += haversineKm(from.lat, from.lng, to.lat, to.lng);
  }
  return distance;
}

function canonicalVehicleDirection(vehicle) {
  const raw = String(vehicle?.direction || vehicle?.route_direction || '').toLowerCase();
  if (raw.includes('inbound') || raw.includes('กลับ')) return 'inbound';
  if (raw.includes('outbound') || raw.includes('ไป')) return 'outbound';
  return raw || 'unknown';
}

function routeEtaCandidate(vehicle, target, routeCoords) {
  const vehicleIndex = snapToRoute(vehicle.lat, vehicle.lng, routeCoords);
  const targetIndex = snapToRoute(target.lat, target.lng, routeCoords);
  if (vehicleIndex < 0 || targetIndex < 0) return null;
  const delta = currentDirection === 'inbound'
    ? vehicleIndex - targetIndex
    : targetIndex - vehicleIndex;
  if (delta <= 0) return null;
  const distanceKm = routeDistanceKm(routeCoords, vehicleIndex, targetIndex);
  const speedKmh = Number(vehicle.speed) > 0 ? Number(vehicle.speed) : 30;
  return {
    vehicle,
    vehicleIndex,
    targetIndex,
    delta,
    distanceKm,
    etaMin: Math.max(1, Math.round((distanceKm / speedKmh) * 60)),
  };
}

function updateVehicleNotice(message = '') {
  const notice = document.getElementById('no-vehicles-notice');
  if (!notice) return;
  const hasOnlineVehicles = Object.values(vehicleData).some(vehicle => vehicle.status === 'online');
  if (message) {
    notice.textContent = message;
    notice.style.display = 'block';
    return;
  }
  notice.textContent = 'ยังไม่มีรถออนไลน์ในเส้นทางนี้';
  notice.style.display = hasOnlineVehicles ? 'none' : 'block';
}

function selectApproachingVehicle(target) {
  if (!target) return null;
  const routeCoords = routeCoordsForEta();
  const onlineVehicles = Object.values(vehicleData).filter(vehicle => (
    vehicle.status === 'online'
    && vehicle.gps_fix !== false
    && sameRouteId(vehicle.route_id || vehicle.routeId || currentRouteId, currentRouteId)
  ));
  if (!onlineVehicles.length) {
    selectedVehicleId = null;
    etaState = { key: null, value: null, fetchedAt: Date.now() };
    updateVehicleNotice();
    return null;
  }
  if (!routeCoords.length) {
    onlineVehicles.sort((a, b) => haversineKm(a.lat, a.lng, target.lat, target.lng) - haversineKm(b.lat, b.lng, target.lat, target.lng));
    const vehicle = onlineVehicles[0];
    selectedVehicleId = vehicle.vehicle_id;
    etaState = { key: `fallback:${vehicle.vehicle_id}`, value: null, fetchedAt: Date.now() };
    updateVehicleNotice();
    return vehicle;
  }
  const candidates = onlineVehicles
    .filter(vehicle => canonicalVehicleDirection(vehicle) === currentDirection)
    .map(vehicle => routeEtaCandidate(vehicle, target, routeCoords))
    .filter(Boolean)
    .sort((a, b) => a.delta - b.delta || a.distanceKm - b.distanceKm);
  if (!candidates.length) {
    selectedVehicleId = null;
    etaState = { key: `none:${currentRouteId}:${currentDirection}:${Date.now()}`, value: null, fetchedAt: Date.now() };
    updateVehicleNotice('ไม่มีรถที่กำลังมาถึงจุดนี้');
    if (selectedOrigin) updateOriginStatus('ไม่มีรถที่กำลังมาถึงจุดนี้');
    return null;
  }
  const best = candidates[0];
  selectedVehicleId = best.vehicle.vehicle_id;
  etaState = {
    key: `route:${selectedVehicleId}:${currentDirection}:${best.vehicleIndex}:${best.targetIndex}:${best.vehicle.last_seen || ''}`,
    value: {
      vehicle_id: selectedVehicleId,
      eta_min: best.etaMin,
      distance_m: Math.round(best.distanceKm * 1000),
      route_based: true,
    },
    fetchedAt: Date.now(),
  };
  updateVehicleNotice();
  if (selectedOrigin) updateOriginStatus(`${selectedOrigin.name}: ${Number(selectedOrigin.lat).toFixed(5)}, ${Number(selectedOrigin.lng).toFixed(5)}`);
  return best.vehicle;
}

function chooseNearestVehicle() {
  const target = selectedOrigin || selectedDestination;
  if (!target) return;
  selectApproachingVehicle(target);
}

function selectVehicle(vehicleId) {
  selectedVehicleId = vehicleId;
  etaState = { key: null, value: null, fetchedAt: 0 };
  renderVehicleMarkers(Object.values(vehicleData));
  requestSelectedEta(true);
  renderVehicleCard(vehicleData[vehicleId]);
}

async function requestSelectedEta(force = false) {
  const target = selectedOrigin || selectedDestination;
  if (!target) {
    etaState = { key: null, value: null, fetchedAt: Date.now() };
    return;
  }
  const selected = selectApproachingVehicle(target);
  renderVehicleCard(selected || null);
}

function renderVehicleCard(vehicle) {
  const card = document.getElementById('vehicle-card');
  if (!vehicle) {
    card.classList.remove('show');
    return;
  }
  card.classList.add('show');
  const route = routesById[vehicle.route_id] || routesById[currentRouteId];
  const status = vehicle.status === 'online' ? 'ออนไลน์' : 'ออฟไลน์';
  const statusEl = document.getElementById('vehicle-status');
  statusEl.textContent = status;
  statusEl.className = `status-badge ${vehicle.status === 'online' ? 'status-online' : 'status-offline'}`;
  document.getElementById('vehicle-updated').textContent = `อัปเดต ${vehicleAge(vehicle)} วินาทีที่แล้ว`;
  document.getElementById('vehicle-route').textContent = route?.name || vehicle.route_id || '—';
  document.getElementById('vehicle-plate').textContent = vehicle.plate ? `ทะเบียน ${vehicle.plate}` : vehicle.vehicle_id;

  const eta = etaState.value;
  document.getElementById('vehicle-eta').textContent = formatMinutes(eta?.eta_min);
  document.getElementById('vehicle-distance').textContent = formatDistanceMeters(eta?.distance_m);
  const speedEl = document.getElementById('vehicle-speed');
  if (speedEl) speedEl.textContent = formatSpeedKmh(smoothVehicleSpeed(vehicle));
  const seatStat = document.getElementById('vehicle-seat-stat');
  if (vehicle.seats_available != null || vehicle.seat_count != null) {
    seatStat.style.display = '';
    document.getElementById('vehicle-seats').textContent = vehicle.seats_available ?? vehicle.seat_count;
  } else {
    seatStat.style.display = 'none';
  }
  const nextStop = findNextStop(vehicle, route);
  document.getElementById('vehicle-next-stop').textContent = nextStop ? `${nextStop.name} • ${formatMinutes(eta?.eta_min)}` : '—';
}

function smoothVehicleSpeed(vehicle) {
  const target = Number(vehicle?.speed || 0);
  if (!Number.isFinite(target)) return 0;
  const id = vehicle.vehicle_id;
  const current = vehicleSpeedDisplay[id] ?? target;
  const next = Math.abs(target - current) < 0.2 ? target : current + (target - current) * 0.35;
  vehicleSpeedDisplay[id] = next;
  return next;
}

function findNextStop(vehicle, route) {
  const stops = directionStops(route);
  if (!stops.length || !vehicle) return null;
  return stops
    .map(stop => ({ stop, distance: haversineKm(vehicle.lat, vehicle.lng, stop.lat, stop.lng) }))
    .sort((a, b) => a.distance - b.distance)[0]?.stop || null;
}

function vehicleAge(vehicle) {
  const now = serverClock.serverTime + (performance.now() - serverClock.perfAt) / 1000;
  return Math.max(0, Math.floor(now - (vehicle?.last_seen || 0)));
}

function safeId(value) {
  return String(value).replace(/[^\wก-๙-]/g, '-');
}

function toggleMeshOverlay() {
  if (!window.MeshOverlay) return;
  const enabled = window.MeshOverlay.toggle();
  document.getElementById('mesh-toggle-label').textContent = enabled ? 'Mesh ON' : 'Mesh';
  if (enabled) {
    fetch('/api/v1/network').then(response => response.json()).then(data => {
      const badge = document.getElementById('mesh-mode-badge');
      badge.textContent = data.mode || 'waiting';
      badge.style.display = 'inline-flex';
    }).catch(() => {});
  } else {
    document.getElementById('mesh-mode-badge').style.display = 'none';
  }
}
