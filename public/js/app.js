'use strict';

let map;
let routeLine;
let userMarker;
let currentRouteId = null;
let currentDirection = 'outbound';
let selectedDestination = null;
let selectedVehicleId = null;
let routesById = {};
let vehicleData = {};
let vehicleMarkers = {};
let stopMarkers = [];
let etaState = { key: null, value: null, fetchedAt: 0 };
let serverClock = { serverTime: 0, perfAt: 0 };

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
  bindPassengerControls();
  await initMap();
}

function bindPassengerControls() {
  document.querySelectorAll('.direction-row button').forEach(button => {
    button.addEventListener('click', () => {
      currentDirection = button.dataset.direction;
      document.querySelectorAll('.direction-row button').forEach(item => item.classList.toggle('active', item === button));
      renderRecommendedStops();
      requestSelectedEta(true);
    });
  });

  document.getElementById('destination-search').addEventListener('input', renderPopularDestinations);
  document.getElementById('show-route-btn').addEventListener('click', () => {
    const destination = selectedDestination || routeStops(routesById[currentRouteId])[0];
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
  setInterval(fetchVehicles, 3500);
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

  drawRoute(route);
  drawStops(route);
  selectedDestination = routeStops(route)[0] || null;
  if (selectedDestination) setDestination(selectedDestination, false);
  renderPopularDestinations();
  renderRecommendedStops();
  fetchVehicles();
}

function drawRoute(route) {
  if (routeLine) routeLine.setMap(null);
  const path = (route.coords || []).map(([lat, lng]) => ({ lat, lng }));
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
  routeStops(route).forEach(stop => {
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
  const stops = routeStops(route).filter(stop => !query || String(stop.name).toLowerCase().includes(query)).slice(0, 8);
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
  const stops = directionStops(route).slice(0, 5);
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
  const stops = [...routeStops(route)];
  return currentDirection === 'inbound' ? stops.reverse() : stops;
}

async function updateStopEtas(stops) {
  const origin = selectedVehicleId && vehicleData[selectedVehicleId]
    ? `${vehicleData[selectedVehicleId].lat},${vehicleData[selectedVehicleId].lng}`
    : selectedDestination
      ? `${selectedDestination.lat},${selectedDestination.lng}`
      : null;
  if (!origin) return;
  for (const stop of stops) {
    const meta = document.getElementById(`stop-meta-${safeId(stop.name)}`);
    if (!meta || !Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lng))) continue;
    const distance = selectedDestination ? haversineKm(selectedDestination.lat, selectedDestination.lng, stop.lat, stop.lng) : null;
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
  if (!userMarker) {
    userMarker = new google.maps.marker.AdvancedMarkerElement({
      map,
      position,
      content: destinationMarkerContent(),
      title: stop.name,
      zIndex: 900,
    });
  } else {
    userMarker.position = position;
    userMarker.title = stop.name;
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
    document.getElementById('no-vehicles-notice').style.display = visibleVehicles.some(vehicle => vehicle.status === 'online') ? 'none' : 'block';
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
      vehicleMarkers[vehicle.vehicle_id].position = position;
      vehicleMarkers[vehicle.vehicle_id].content = createVehicleMarkerContent(vehicle.speed, online, false, selected, vehicle.heading);
      vehicleMarkers[vehicle.vehicle_id].zIndex = selected ? 600 : 500;
    }
  });
  Object.keys(vehicleMarkers).forEach(id => {
    if (!ids.has(id)) {
      vehicleMarkers[id].map = null;
      delete vehicleMarkers[id];
    }
  });
}

function chooseNearestVehicle() {
  if (!selectedDestination) return;
  const candidates = Object.values(vehicleData).filter(vehicle => vehicle.status === 'online' && vehicle.gps_fix !== false);
  if (!candidates.length) {
    selectedVehicleId = null;
    return;
  }
  candidates.sort((a, b) => haversineKm(a.lat, a.lng, selectedDestination.lat, selectedDestination.lng) - haversineKm(b.lat, b.lng, selectedDestination.lat, selectedDestination.lng));
  selectedVehicleId = candidates[0].vehicle_id;
}

function selectVehicle(vehicleId) {
  selectedVehicleId = vehicleId;
  etaState = { key: null, value: null, fetchedAt: 0 };
  renderVehicleMarkers(Object.values(vehicleData));
  requestSelectedEta(true);
  renderVehicleCard(vehicleData[vehicleId]);
}

async function requestSelectedEta(force = false) {
  const vehicle = vehicleData[selectedVehicleId];
  if (!vehicle || !selectedDestination) {
    etaState = { key: null, value: null, fetchedAt: Date.now() };
    return;
  }
  const key = `${vehicle.vehicle_id}:${Number(selectedDestination.lat).toFixed(5)},${Number(selectedDestination.lng).toFixed(5)}`;
  if (!force && etaState.key === key && Date.now() - etaState.fetchedAt < 30000) return;
  etaState = { key, value: null, fetchedAt: Date.now() };
  try {
    etaState.value = await fetchMapsEta(
      `${vehicle.lat},${vehicle.lng}`,
      `${selectedDestination.lat},${selectedDestination.lng}`,
      vehicle.vehicle_id
    );
  } catch (_) {
    etaState.value = null;
  }
  etaState.fetchedAt = Date.now();
  renderVehicleCard(vehicleData[selectedVehicleId]);
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
  document.getElementById('vehicle-plate').textContent = vehicle.plate || vehicle.vehicle_id;

  const eta = etaState.value;
  document.getElementById('vehicle-eta').textContent = formatMinutes(eta?.eta_min);
  document.getElementById('vehicle-distance').textContent = formatDistanceMeters(eta?.distance_m);
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
