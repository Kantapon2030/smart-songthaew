'use strict';

let routeList = [];
let activeStop = null;
let activeRouteId = '';
let activeDirection = 'all';
let userPosition = null;
let routePageReady = false;

document.addEventListener('DOMContentLoaded', initRoutesPage);

async function initRoutesPage() {
  renderSharedNavbar({
    active: 'routes',
    onRouteChange(routeId) {
      activeRouteId = routeId || activeRouteId;
      if (routePageReady) {
        ensureActiveStopForRoute();
        renderStopList();
        renderStopDetail();
      }
    },
  });
  document.getElementById('location-icon').innerHTML = pinSvg(16, '#334155');
  document.getElementById('stop-search').addEventListener('input', renderStopList);
  document.getElementById('use-location-btn').addEventListener('click', useMyLocationForStops);
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab));
    });
  });
  await loadRouteStops();
  await renderStopDetail();
}

async function loadRouteStops() {
  try {
    const payload = await fetchPassengerRoutes();
    routeList = normalizeRouteList(payload);
    activeRouteId = document.getElementById('shared-route-select')?.value || routeList[0]?.route_id || '';
    ensureActiveStopForRoute();
  } catch (error) {
    console.error('[routes-page]', error);
    routeList = [];
    activeStop = null;
    activeRouteId = '';
  }
  routePageReady = true;
  renderStopList();
}

function ensureActiveStopForRoute() {
  const stops = allStops();
  if (!stops.length) {
    activeStop = null;
    activeRouteId = '';
    return;
  }
  if (!activeRouteId || !routeList.some(route => route.route_id === activeRouteId)) {
    activeRouteId = routeList[0]?.route_id || stops[0].routes[0]?.route_id || '';
  }
  const routeHasStop = stop => stop.routes.some(route => route.route_id === activeRouteId);
  if (!activeStop || !routeHasStop(activeStop)) {
    activeStop = stops.find(routeHasStop) || stops[0];
  }
}

function allStops() {
  const map = new Map();
  routeList.forEach(route => {
    routeStops(route).forEach(stop => {
      const key = `${stop.name}:${Number(stop.lat).toFixed(5)}:${Number(stop.lng).toFixed(5)}`;
      const existing = map.get(key) || { ...stop, routes: [] };
      existing.routes.push(route);
      map.set(key, existing);
    });
  });
  return [...map.values()];
}

function renderStopList() {
  const query = document.getElementById('stop-search').value.trim().toLowerCase();
  let stops = allStops();
  if (userPosition) {
    stops = stops.map(stop => ({ ...stop, userDistance: haversineKm(userPosition.lat, userPosition.lng, stop.lat, stop.lng) }))
      .sort((a, b) => a.userDistance - b.userDistance);
  }
  stops = stops.filter(stop => !query || stop.name.toLowerCase().includes(query)).slice(0, 10);
  const root = document.getElementById('popular-stops');
  root.innerHTML = stops.length ? stops.map(stop => `
    <button class="list-item ${activeStop?.name === stop.name ? 'active' : ''}" type="button" data-key="${stop.name}">
      <span class="item-icon" aria-hidden="true">${pinSvg(17, '#2563EB')}</span>
      <span>
        <span class="item-title">${stop.name}</span>
        <span class="item-meta">${stop.routes.length} สายรถ${stop.userDistance != null ? ` • ${formatDistanceKm(stop.userDistance)}` : ''}</span>
      </span>
      <span class="small-badge status-online">${stop.routes.length}</span>
    </button>`).join('') : '<div class="empty-state">ไม่พบจุดจอด</div>';
  [...root.querySelectorAll('button')].forEach((button, index) => {
    button.addEventListener('click', () => {
      activeStop = stops[index];
      activeRouteId = activeStop.routes[0]?.route_id || activeRouteId;
      renderStopList();
      renderStopDetail();
    });
  });
}

async function renderStopDetail() {
  const root = document.getElementById('stop-detail');
  if (!activeStop) {
    root.innerHTML = '<div class="empty-state">เลือกจุดจอดเพื่อดูรถที่กำลังจะถึง</div>';
    return;
  }

  if (!activeStop.routes.some(route => route.route_id === activeRouteId)) {
    activeRouteId = activeStop.routes[0]?.route_id || activeRouteId;
  }
  const routeOptions = activeStop.routes.map(route => `<option value="${route.route_id}" ${route.route_id === activeRouteId ? 'selected' : ''}>${route.name}</option>`).join('');
  root.innerHTML = `
    <div class="card-header">
      <div>
        <h1 class="card-title">${activeStop.name}</h1>
        <div class="card-subtitle">${Number(activeStop.lat).toFixed(5)}, ${Number(activeStop.lng).toFixed(5)}</div>
      </div>
    </div>
    <div class="card-body stop-detail-grid">
      <div>
        <div class="section-block">
          <div class="metric-label">สายรถที่ผ่าน</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
            ${activeStop.routes.map(route => `<span class="route-badge" style="background:${routeColor(route)}">${route.name}</span>`).join('')}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr auto;gap:10px;margin-top:16px;">
          <select id="detail-route-select" class="select-control">${routeOptions}</select>
          <select id="detail-direction-select" class="select-control">
            <option value="all">ทุกทิศทาง</option>
            <option value="outbound">ขาไป</option>
            <option value="inbound">ขากลับ</option>
          </select>
        </div>
        <h2 class="card-title" style="margin-top:20px;">รถที่กำลังจะถึง</h2>
        <div id="arrival-list" class="arrival-list"><div class="empty-state">กำลังโหลดรถ...</div></div>
      </div>
      <aside class="card" style="box-shadow:none;">
        <div class="card-header"><h2 class="card-title" id="route-stop-heading">เส้นทางสาย ${activeRouteId || '—'}</h2></div>
        <div class="card-body"><div id="route-stop-list" class="vertical-stops"></div></div>
      </aside>
    </div>`;

  document.getElementById('detail-route-select').addEventListener('change', event => {
    activeRouteId = event.target.value;
    renderStopTimeline();
    renderArrivals();
  });
  document.getElementById('detail-direction-select').addEventListener('change', event => {
    activeDirection = event.target.value;
    renderStopTimeline();
    renderArrivals();
  });
  document.getElementById('detail-direction-select').value = activeDirection;
  renderStopTimeline();
  renderArrivals();
}

function renderStopTimeline() {
  const route = routeList.find(item => item.route_id === activeRouteId) || activeStop?.routes[0];
  if (!route) {
    document.getElementById('route-stop-heading').textContent = 'Route';
    document.getElementById('route-stop-list').innerHTML = '<div class="empty-state">No route data</div>';
    return;
  }
  const stops = activeDirection === 'inbound' ? [...routeStops(route)].reverse() : routeStops(route);
  document.getElementById('route-stop-heading').textContent = `เส้นทางสาย ${route?.name || '—'}`;
  document.getElementById('route-stop-list').innerHTML = stops.map(stop => `
    <div class="vertical-stop ${stop.name === activeStop.name ? 'current' : ''}">${stop.name}</div>`).join('');
}

async function renderArrivals() {
  const root = document.getElementById('arrival-list');
  if (!root || !activeStop || !activeRouteId) return;
  try {
    const payload = await fetchLegacyLocations(activeRouteId);
    const vehicles = Object.entries(payload || {})
      .map(([id, entry]) => ({
        id,
        routeId: entry.routeId,
        current: entry.current || {},
      }))
      .filter(vehicle => Number.isFinite(Number(vehicle.current.lat)) && Number.isFinite(Number(vehicle.current.lng)))
      .map(vehicle => ({
        ...vehicle,
        distanceKm: haversineKm(vehicle.current.lat, vehicle.current.lng, activeStop.lat, activeStop.lng),
      }))
      .filter(vehicle => vehicle.distanceKm <= 12)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 6);

    if (!vehicles.length) {
      root.innerHTML = '<div class="empty-state">ยังไม่มีรถใกล้จุดจอดนี้</div>';
      return;
    }

    root.innerHTML = vehicles.map(vehicle => {
      const route = routeList.find(item => item.route_id === vehicle.routeId) || routeList.find(item => item.route_id === activeRouteId);
      const eta = Math.max(1, Math.round(vehicle.distanceKm / 0.45));
      const seats = vehicle.current.seats_available ?? vehicle.current.seat_count;
      return `
        <div class="arrival-card">
          <span class="route-badge" style="background:${routeColor(route)}">${route?.name || vehicle.routeId || '—'}</span>
          <div>
            <div class="item-title">${vehicle.current.plate || vehicle.id}</div>
            <div class="item-meta">${formatDistanceKm(vehicle.distanceKm)} • ${formatTime(vehicle.current.timestamp)}</div>
          </div>
          <div class="status-badge status-online">${eta} นาที</div>
          <div style="display:flex;align-items:center;gap:8px;color:var(--color-muted);">
            <span>${seats != null ? `${seats} ที่นั่ง` : '—'}</span>
            <span aria-hidden="true">${bellSvg(18, '#64748B')}</span>
          </div>
        </div>`;
    }).join('');
  } catch (error) {
    console.error('[arrivals]', error);
    root.innerHTML = '<div class="empty-state">โหลดข้อมูลรถไม่สำเร็จ</div>';
  }
}

function useMyLocationForStops() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(position => {
    userPosition = { lat: position.coords.latitude, lng: position.coords.longitude };
    renderStopList();
  }, () => {}, { enableHighAccuracy: true, timeout: 8000 });
}
