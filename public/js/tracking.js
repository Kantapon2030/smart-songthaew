'use strict';

let trackingMap;
let trackingRouteLine;
let trackingVehicleMarker;
let trackingStopMarkers = [];
let trackingRoutes = [];
let trackingRouteId = '';
let selectedVehicle = null;
let trackingEta = null;

document.addEventListener('DOMContentLoaded', initTrackingPage);

async function initTrackingPage() {
  renderSharedNavbar({
    active: 'tracking',
    onRouteChange(routeId) {
      if (routeId) {
        trackingRouteId = routeId;
        refreshTracking();
      }
    },
  });
  await initTrackingMap();
  await loadTrackingRoutes();
  await refreshTracking();
  setInterval(refreshTracking, 5000);
}

async function initTrackingMap() {
  await loadGoogleMapsAPI();
  const mapEl = document.getElementById('tracking-map');
  if (!window.google?.maps) {
    mapEl.textContent = 'ไม่สามารถโหลดแผนที่ได้';
    return;
  }
  trackingMap = new google.maps.Map(mapEl, {
    center: { lat: 8.50, lng: 99.89 },
    zoom: 11,
    mapId: 'smart_songthaew_tracking',
    disableDefaultUI: true,
    zoomControl: true,
  });
}

async function loadTrackingRoutes() {
  const payload = await fetchPassengerRoutes();
  trackingRoutes = normalizeRouteList(payload);
  trackingRouteId = document.getElementById('shared-route-select')?.value || trackingRoutes[0]?.route_id || '';
  drawTrackingRoute();
}

async function refreshTracking() {
  if (!trackingRouteId) return;
  try {
    const data = await fetchVehicleLocations(trackingRouteId);
    selectedVehicle = (data.vehicles || []).filter(vehicle => vehicle.status === 'online')
      .sort((a, b) => (b.speed || 0) - (a.speed || 0))[0] || (data.vehicles || [])[0] || null;
    drawTrackingRoute();
    drawTrackingVehicle();
    await fetchTrackingEta();
    renderTrackingPanel(data.server_time);
  } catch (error) {
    console.error('[tracking]', error);
  }
}

function currentRoute() {
  return trackingRoutes.find(route => route.route_id === trackingRouteId) || trackingRoutes[0];
}

function drawTrackingRoute() {
  if (!trackingMap) return;
  const route = currentRoute();
  if (!route) return;
  if (trackingRouteLine) trackingRouteLine.setMap(null);
  trackingStopMarkers.forEach(marker => { marker.map = null; });
  trackingStopMarkers = [];

  const path = (route.coords || []).map(([lat, lng]) => ({ lat, lng }));
  trackingRouteLine = new google.maps.Polyline({
    map: trackingMap,
    path,
    strokeColor: routeColor(route),
    strokeOpacity: 0.9,
    strokeWeight: 5,
  });
  routeStops(route).forEach(stop => {
    trackingStopMarkers.push(new google.maps.marker.AdvancedMarkerElement({
      map: trackingMap,
      position: { lat: Number(stop.lat), lng: Number(stop.lng) },
      content: createStopMarkerContent(false),
      title: stop.name,
      zIndex: 300,
    }));
  });
  if (path.length) {
    const bounds = new google.maps.LatLngBounds();
    path.forEach(point => bounds.extend(point));
    trackingMap.fitBounds(bounds, 48);
  }
}

function drawTrackingVehicle() {
  if (!trackingMap || !selectedVehicle) return;
  const position = { lat: selectedVehicle.lat, lng: selectedVehicle.lng };
  if (!trackingVehicleMarker) {
    trackingVehicleMarker = new google.maps.marker.AdvancedMarkerElement({
      map: trackingMap,
      position,
      content: createVehicleMarkerContent(selectedVehicle.speed, selectedVehicle.status === 'online', false, true, selectedVehicle.heading),
      zIndex: 700,
    });
  } else {
    trackingVehicleMarker.position = position;
    trackingVehicleMarker.content = createVehicleMarkerContent(selectedVehicle.speed, selectedVehicle.status === 'online', false, true, selectedVehicle.heading);
  }
}

async function fetchTrackingEta() {
  const route = currentRoute();
  const stops = routeStops(route);
  if (!selectedVehicle || !stops.length) {
    trackingEta = null;
    return;
  }
  const target = findNextTrackingStop();
  if (!target) {
    trackingEta = null;
    return;
  }
  try {
    trackingEta = await fetchMapsEta(
      `${selectedVehicle.lat},${selectedVehicle.lng}`,
      `${target.lat},${target.lng}`,
      selectedVehicle.vehicle_id
    );
  } catch (_) {
    trackingEta = null;
  }
}

function renderTrackingPanel(serverTime) {
  const route = currentRoute();
  document.getElementById('tracking-updated').textContent = selectedVehicle ? `อัปเดต ${Math.max(0, Math.round((serverTime || Date.now() / 1000) - (selectedVehicle.last_seen || 0)))} วินาทีที่แล้ว` : 'ไม่มีรถในเส้นทาง';
  document.getElementById('tracking-route').textContent = route?.name || trackingRouteId || '—';
  document.getElementById('tracking-plate').textContent = selectedVehicle ? `${selectedVehicle.vehicle_id}${selectedVehicle.plate ? ` • ${selectedVehicle.plate}` : ''}` : '—';
  document.getElementById('tracking-eta').textContent = trackingEta?.eta_min != null
    ? `${trackingEta.eta_min} นาที`
    : '—';
  document.getElementById('tracking-distance').textContent = trackingEta?.distance_m != null
    ? `(${formatDistanceMeters(trackingEta.distance_m)})`
    : '—';
  const progress = calculateTripProgress();
  document.getElementById('tracking-progress-label').textContent = `${progress}%`;
  document.getElementById('tracking-progress').style.width = `${progress}%`;
  const nextStop = findNextTrackingStop();
  document.getElementById('tracking-next-stop').textContent = nextStop ? `${nextStop.name} • ${formatMinutes(trackingEta?.eta_min)}` : '—';
  document.getElementById('tracking-seats').textContent = selectedVehicle?.seats_available ?? selectedVehicle?.seat_count ?? '—';
  renderTimeline(nextStop);
}

function findNextTrackingStop() {
  const route = currentRoute();
  if (!selectedVehicle || !route) return null;
  return routeStops(route)
    .map(stop => ({ stop, distance: haversineKm(selectedVehicle.lat, selectedVehicle.lng, stop.lat, stop.lng) }))
    .sort((a, b) => a.distance - b.distance)[0]?.stop || null;
}

function calculateTripProgress() {
  const route = currentRoute();
  const stops = routeStops(route);
  if (!selectedVehicle || stops.length < 2) return 0;
  const first = stops[0];
  const last = stops[stops.length - 1];
  const total = haversineKm(first.lat, first.lng, last.lat, last.lng);
  const done = haversineKm(first.lat, first.lng, selectedVehicle.lat, selectedVehicle.lng);
  return Math.max(0, Math.min(100, Math.round((done / Math.max(total, 0.1)) * 100)));
}

function renderTimeline(nextStop) {
  const route = currentRoute();
  const stops = routeStops(route).slice(0, 8);
  const progress = calculateTripProgress();
  const currentIndex = nextStop ? stops.findIndex(stop => stop.name === nextStop.name) : 0;
  document.getElementById('tracking-timeline').innerHTML = stops.map((stop, index) => {
    const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : '';
    const eta = index === currentIndex ? formatMinutes(trackingEta?.eta_min) : `${Math.max(2, (index + 1) * 4)} นาที`;
    const label = index === 0 ? 'ออกเดินทาง' : index === currentIndex ? 'กำลังเดินทาง' : 'จุดจอดถัดไป';
    return `
      <div class="timeline-item ${state}">
        <div class="item-title">${stop.name}</div>
        <div class="item-meta">${label} • ${progress >= 100 && index === stops.length - 1 ? 'ถึงปลายทาง' : eta}</div>
      </div>`;
  }).join('');
}
