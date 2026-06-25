'use strict';

const ROUTE_COORDS = [
  [8.4325, 99.9629],
  [8.4340, 99.9430],
  [8.4370, 99.9200],
  [8.4480, 99.9000],
  [8.4680, 99.8820],
  [8.4900, 99.8680],
  [8.5120, 99.8530],
  [8.5350, 99.8380],
  [8.5580, 99.8250],
  [8.5780, 99.8160],
];
const DIR_SOUTH = 'นครศรีธรรมราช (วงเวียนนาคร)';
const DIR_NORTH = 'โรงเรียนพรหมคีรีนครศรีธรรมราช';
const DEST_SOUTH = ROUTE_COORDS[0];
const DEST_NORTH = ROUTE_COORDS[ROUTE_COORDS.length - 1];
const DEST_PHROMKHIRI = DEST_NORTH;
const DEST_NAKHON = DEST_SOUTH;
const REAL_VEHICLE_ID = 'songthaew_01';

window.SYS = {
  demoMode: false,
  demoVehicles: 1,
  routeName: 'นครศรีธรรมราช ↔ พรหมคีรี',
  offlineTimeout: 30,
  announcement: '',
  updatedAt: null,
};

let _gmapsKey = '';
let _gmapsPromise = null;

async function syncConfig() {
  try {
    const next = await fetch('/api/config').then(response => response.json());
    const changed = JSON.stringify(next) !== JSON.stringify(window.SYS);
    Object.assign(window.SYS, next);
    renderAnnouncement(window.SYS.announcement);
    if (changed && typeof onConfigChanged === 'function') onConfigChanged(window.SYS);
  } catch (_) {
    // Configuration is best-effort for public pages.
  }
}

setInterval(syncConfig, 5000);
syncConfig();

async function loadGoogleMapsAPI() {
  if (window.google?.maps) return;
  if (_gmapsPromise) return _gmapsPromise;
  _gmapsPromise = (async () => {
    try {
      const payload = await fetch('/api/maps/key').then(response => response.json());
      _gmapsKey = payload.key || '';
    } catch (_) {
      _gmapsKey = '';
    }
    if (!_gmapsKey) {
      console.warn('[MAPS] No Google Maps API key configured');
      return;
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${_gmapsKey}&libraries=marker,geometry&callback=__gmapsReady&loading=async`;
      script.async = true;
      script.defer = true;
      window.__gmapsReady = () => {
        delete window.__gmapsReady;
        resolve();
      };
      script.onerror = reject;
      document.head.appendChild(script);
    });
  })();
  return _gmapsPromise;
}

function haversineKm(la1, lo1, la2, lo2) {
  const R = 6371;
  const dLat = (la2 - la1) * Math.PI / 180;
  const dLon = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculateBearing(la1, lo1, la2, lo2) {
  if (la1 === la2 && lo1 === lo2) return 0;
  const dLon = (lo2 - lo1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(la2 * Math.PI / 180);
  const x = Math.cos(la1 * Math.PI / 180) * Math.sin(la2 * Math.PI / 180) -
    Math.sin(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function isVehicleOnline(vehicle) {
  if (vehicle?.status) return vehicle.status === 'online' || vehicle.status === 'delayed';
  if (vehicle?.last_seen) return (Date.now() / 1000 - vehicle.last_seen) <= 60;
  const timeout = (window.SYS?.offlineTimeout ?? 30) * 1000;
  return Boolean(vehicle?.timestamp && (Date.now() - vehicle.timestamp) < timeout);
}

function getClientSession() {
  let id = sessionStorage.getItem('smartSongthaewSession');
  if (!id) {
    id = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    sessionStorage.setItem('smartSongthaewSession', id);
  }
  return id;
}

async function fetchV1Vehicles(routeId) {
  const query = routeId ? `?route_id=${encodeURIComponent(routeId)}` : '';
  const response = await fetch(`/api/v1/vehicles${query}`);
  if (!response.ok) throw new Error(`vehicles ${response.status}`);
  return response.json();
}

async function fetchV1FleetForLegacyViews(routeId) {
  const payload = await fetchV1Vehicles(routeId);
  return Object.fromEntries((payload.vehicles || []).map(vehicle => [vehicle.vehicle_id, {
    current: {
      ...vehicle,
      timestamp: (vehicle.last_seen || 0) * 1000,
      routeId: vehicle.route_id,
    },
    routeId: vehicle.route_id,
    type: vehicle.source,
  }]));
}

async function fetchPassengerRoutes() {
  try {
    const response = await fetch('/api/routes');
    if (!response.ok) throw new Error(`routes ${response.status}`);
    return { routes: normalizeRouteList(await response.json()) };
  } catch (error) {
    const response = await fetch('/api/v1/routes');
    if (!response.ok) throw new Error(`routes ${response.status}`);
    return { routes: normalizeRouteList(await response.json()) };
  }
}

async function fetchLegacyLocations(routeId) {
  const query = routeId ? `?routeId=${encodeURIComponent(routeId)}` : '';
  const response = await fetch(`/api/locations${query}`);
  if (!response.ok) throw new Error(`locations ${response.status}`);
  return response.json();
}

async function fetchVehicleLocations(routeId) {
  const payload = await fetchLegacyLocations(routeId);
  const serverTime = Date.now() / 1000;
  const vehicles = Object.entries(payload || {})
    .map(([id, entry]) => normalizeLegacyVehicle(id, entry, serverTime))
    .filter(vehicle => Number.isFinite(vehicle.lat) && Number.isFinite(vehicle.lng));
  return { server_time: serverTime, vehicles };
}

function normalizeLegacyVehicle(id, entry = {}, now = Date.now() / 1000) {
  const current = entry.current || entry || {};
  const rawTimestamp = Number(current.server_received_at || current.serverReceivedAt || current.last_seen || current.lastSeen || 0);
  const timestampMs = Number(current.timestamp || 0);
  const lastSeen = rawTimestamp > 0 ? rawTimestamp : timestampMs > 10_000_000_000 ? timestampMs / 1000 : timestampMs;
  const status = current.status || (lastSeen && now - lastSeen <= 60 ? 'online' : 'offline');
  const heading = Number(current.heading ?? current.bearing ?? 0);
  return {
    vehicle_id: current.vehicle_id || current.vehicleId || id,
    lat: Number(current.lat),
    lng: Number(current.lng),
    speed: Number(current.speed || 0),
    heading,
    bearing: Number(current.bearing ?? heading),
    battery: current.battery,
    gps_fix: current.gps_fix ?? (Number.isFinite(Number(current.lat)) && Number.isFinite(Number(current.lng))),
    status,
    route_id: current.route_id || current.routeId || entry.routeId || 'unassigned',
    routeId: current.routeId || entry.routeId || current.route_id || 'unassigned',
    direction: current.direction || '',
    last_seen: lastSeen || 0,
    timestamp: timestampMs || (lastSeen ? lastSeen * 1000 : 0),
    plate: current.plate,
    seats_available: current.seats_available,
    seat_count: current.seat_count,
    source: entry.type || current.source || 'legacy',
    demo: current.demo === true || entry.demo === true,
  };
}

async function fetchMapsEta(origin, destination, vehicleId = '') {
  const params = new URLSearchParams({ origin, destination });
  const response = await fetch(`/api/maps/eta?${params}`);
  if (!response.ok) throw new Error(`eta ${response.status}`);
  return normalizeMapsEta(await response.json(), vehicleId);
}

function normalizeMapsEta(data, vehicleId = '') {
  const seconds = Number(data?.duration_in_traffic?.value ?? data?.duration?.value);
  const meters = Number(data?.distance?.value);
  return {
    vehicle_id: vehicleId,
    eta_min: Number.isFinite(seconds) ? Math.max(1, Math.round(seconds / 60)) : null,
    distance_m: Number.isFinite(meters) ? meters : null,
    raw: data,
  };
}

function createVehicleMarkerContent(speed = 0, online = true, isDemo = false, isRecommended = false, heading = 0) {
  const active = online && Number(speed) > 0;
  const color = active ? '#16A34A' : '#6B7280';
  const size = isRecommended ? 48 : 38;
  const el = document.createElement('div');
  el.className = 'vehicle-marker';
  el.style.cssText = `position:relative;display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 8px 20px ${color}55;transform:rotate(${Number(heading) || 0}deg);`;
  el.innerHTML = busSvg(size > 40 ? 24 : 19, '#fff');
  if (isRecommended) {
    const label = document.createElement('div');
    label.textContent = 'แนะนำ';
    label.style.cssText = `position:absolute;top:-26px;left:50%;transform:translateX(-50%) rotate(-${Number(heading) || 0}deg);background:${color};color:#fff;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:800;white-space:nowrap;`;
    el.appendChild(label);
  }
  return el;
}

function createStopMarkerContent(active = false) {
  const el = document.createElement('div');
  el.style.cssText = `width:${active ? 18 : 14}px;height:${active ? 18 : 14}px;border-radius:50%;background:#fff;border:3px solid #2563EB;box-shadow:0 2px 10px rgba(37,99,235,.28);`;
  return el;
}

function busSvg(size = 22, color = 'currentColor') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M6.5 3.75h11A2.75 2.75 0 0 1 20.25 6.5v8.75A2.75 2.75 0 0 1 17.5 18H17v1.25a1 1 0 0 1-1 1h-1.25a1 1 0 0 1-1-1V18h-3.5v1.25a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V18h-.5a2.75 2.75 0 0 1-2.75-2.75V6.5A2.75 2.75 0 0 1 6.5 3.75Z" stroke="${color}" stroke-width="1.8"/><path d="M5 9h14M7.25 6.5h9.5M7.5 15h.01M16.5 15h.01" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/></svg>`;
}

function antennaSvg(size = 20, color = 'currentColor') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M12 20V9M8 20h8M9 9a3 3 0 1 1 6 0M6.25 6.5a6 6 0 0 1 11.5 0M4 4a9 9 0 0 1 16 0" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/></svg>`;
}

function bellSvg(size = 18, color = 'currentColor') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M18 9.5a6 6 0 1 0-12 0c0 7-2 7-2 8.5h16c0-1.5-2-1.5-2-8.5ZM9.75 20a2.4 2.4 0 0 0 4.5 0" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function signalSvg(size = 18, color = 'currentColor') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M5 16.5a10 10 0 0 1 14 0M8.5 13a5 5 0 0 1 7 0M12 18.75h.01" stroke="${color}" stroke-width="2" stroke-linecap="round"/></svg>`;
}

function userSvg(size = 19, color = 'currentColor') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M20 20a8 8 0 0 0-16 0M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/></svg>`;
}

function pinSvg(size = 18, color = 'currentColor') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M12 21s7-5.4 7-12A7 7 0 1 0 5 9c0 6.6 7 12 7 12Z" stroke="${color}" stroke-width="1.8"/><path d="M12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" stroke="${color}" stroke-width="1.8"/></svg>`;
}

function formatDistanceMeters(meters) {
  const value = Number(meters);
  if (!Number.isFinite(value)) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)} กม.` : `${Math.round(value)} ม.`;
}

function formatDistanceKm(km) {
  const value = Number(km);
  if (!Number.isFinite(value)) return '—';
  return value >= 1 ? `${value.toFixed(1)} กม.` : `${Math.round(value * 1000)} ม.`;
}

function formatMinutes(minutes) {
  const value = Number(minutes);
  return Number.isFinite(value) ? `${Math.max(1, Math.round(value))} นาที` : '—';
}

function formatTime(value) {
  if (!value) return '—';
  const timestamp = value > 10_000_000_000 ? value : value * 1000;
  return new Date(timestamp).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function normalizeRouteList(payload) {
  if (Array.isArray(payload?.routes)) return payload.routes.map(route => normalizeRouteRecord(route));
  if (Array.isArray(payload)) return payload.map(route => normalizeRouteRecord(route));
  return Object.entries(payload || {}).map(([id, route]) => normalizeRouteRecord(route, id));
}

function normalizeRouteRecord(route = {}, id = '') {
  const routeId = id || route.route_id || route.routeId || route.id || '';
  const places = Array.isArray(route.places) && route.places.length ? route.places : route.stops || [];
  return {
    ...route,
    route_id: routeId,
    routeId: route.routeId || routeId,
    color: route.color || '#2563EB',
    places: places.map((place, index) => normalizeStopRecord(place, routeId, index)),
  };
}

function normalizeStopRecord(stop = {}, routeId = '', index = 0) {
  return {
    ...stop,
    place_id: stop.place_id || stop.id || `${routeId}-stop-${index + 1}`,
    name: stop.name || `จุดจอด ${index + 1}`,
    lat: Number(stop.lat),
    lng: Number(stop.lng),
  };
}

function routeStops(route) {
  return route?.places || route?.stops || [];
}

function routeColor(route, fallback = '#2563EB') {
  return route?.color || fallback;
}

function isDemoVehicle(vehicle) {
  const id = vehicle?.vehicle_id || vehicle?.vehicleId || '';
  return vehicle?.demo === true || id.startsWith('DEMO') || id.startsWith('TWIN');
}

function renderSharedNavbar(options = {}) {
  const active = options.active || document.body.dataset.page || 'home';
  const fixed = options.fixed === true;
  const target = options.target || document.getElementById('navbar-root');
  if (!target) return;

  target.innerHTML = `
    <nav class="app-navbar ${fixed ? 'fixed' : ''}">
      <a class="brand-link" href="/">
        <span class="brand-icon">${busSvg(24, '#fff')}</span>
        <span class="brand-text"><span class="smart">Smart</span><span class="songthaew">Songthaew</span></span>
      </a>
      <div class="nav-route">
        <select id="shared-route-select" aria-label="เลือกเส้นทาง">
          <option value="">กำลังโหลดเส้นทาง...</option>
        </select>
      </div>
      <div class="nav-links">
        ${navLink('/', 'หน้าหลัก', 'home', active)}
        ${navLink('/routes.html', 'เส้นทาง', 'routes', active)}
        ${navLink('/operations.html#announcements', 'ประกาศ', 'announcements', active)}
        ${navLink('/tracking.html', 'ประวัติการเดินทาง', 'tracking', active)}
        ${navLink('/operations.html#help', 'ช่วยเหลือ', 'help', active)}
        ${options.mesh ? navLink('/dashboard.html', 'VIBE Mesh', 'mesh', active) : ''}
      </div>
      <div class="nav-actions">
        <button class="language-pill" type="button">TH</button>
        <a class="icon-button" href="/admin.html" aria-label="ผู้ใช้งาน">${userSvg()}</a>
      </div>
    </nav>`;

  hydrateRouteSelector(options.onRouteChange);
}

function navLink(href, label, id, active) {
  return `<a class="nav-link ${active === id ? 'active' : ''}" href="${href}">${label}</a>`;
}

async function hydrateRouteSelector(onRouteChange) {
  const select = document.getElementById('shared-route-select');
  if (!select) return;
  try {
    const payload = await fetchRoutes();
    const routes = normalizeRouteList(payload);
    select.innerHTML = routes.length
      ? routes.map(route => `<option value="${route.route_id}">${route.name || route.route_id}</option>`).join('')
      : '<option value="">ไม่มีเส้นทาง</option>';
    const stored = sessionStorage.getItem('smartSongthaewRoute');
    if (stored && routes.some(route => route.route_id === stored)) select.value = stored;
    select.addEventListener('change', () => {
      sessionStorage.setItem('smartSongthaewRoute', select.value);
      if (typeof onRouteChange === 'function') onRouteChange(select.value);
      window.dispatchEvent(new CustomEvent('smart-route-change', { detail: { routeId: select.value } }));
    });
    if (typeof onRouteChange === 'function') onRouteChange(select.value);
  } catch (_) {
    select.innerHTML = '<option value="">โหลดเส้นทางไม่สำเร็จ</option>';
  }
}

function renderAnnouncement(text) {
  let el = document.getElementById('sys-announcement');
  if (!text) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'sys-announcement';
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:1200;background:#0f172a;color:#fff;padding:10px 18px;font-size:14px;box-shadow:0 -6px 24px rgba(15,23,42,.18);';
    document.body.appendChild(el);
  }
  el.textContent = text;
}

function getAuthToken() {
  return localStorage.getItem('adminToken');
}

function setAuthToken(token) {
  localStorage.setItem('adminToken', token);
}

function clearAuth() {
  localStorage.removeItem('adminToken');
  localStorage.removeItem('adminUsername');
}

function isLoggedIn() {
  return Boolean(getAuthToken());
}

function authHeaders() {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function authFetch(url, options = {}) {
  const headers = { ...options.headers, ...authHeaders() };
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    clearAuth();
    window.location.href = '/login.html';
    return null;
  }
  return response;
}

async function requireAuth() {
  const token = getAuthToken();
  if (!token) {
    window.location.href = '/login.html';
    return false;
  }
  try {
    const response = await fetch('/api/auth/verify', { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!data.ok) {
      clearAuth();
      window.location.href = '/login.html';
      return false;
    }
    return true;
  } catch (_) {
    clearAuth();
    window.location.href = '/login.html';
    return false;
  }
}

async function fetchRoutes() {
  try {
    return await fetch('/api/routes').then(response => response.json());
  } catch (_) {
    return {};
  }
}

async function createRoute(data) {
  return authFetch('/api/routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function deleteRoute(id) {
  return authFetch(`/api/routes/${id}`, { method: 'DELETE' });
}

async function addVehicleToRoute(routeId, vehicleId, type = 'real') {
  return authFetch(`/api/routes/${routeId}/vehicles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vehicleId, type }),
  });
}

async function removeVehicleFromRoute(routeId, vehicleId) {
  return authFetch(`/api/routes/${routeId}/vehicles/${vehicleId}`, { method: 'DELETE' });
}

async function fetchRouteVehicles(routeId) {
  try {
    return await fetch(`/api/routes/${routeId}/vehicles`).then(response => response.json());
  } catch (_) {
    return {};
  }
}
