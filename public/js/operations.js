'use strict';

let opsFleet = {};
let opsRoutes = [];
let opsHistoryAnalytics = { vehicles: [], fleet: {} };
let opsMap;
let opsMarkers = [];
let peakChart;
let statusChart;
let perfPeakChart;
let vehiclePage = 0;
const VEHICLE_PAGE_SIZE = 10;

// Sparkline history buffers (last 8 values)
const sparkHistory = {
  total:  [],
  online: [],
  eta:    [],
  ontime: [],
};

/* ─────────────────────────────────────────
   Section Switcher
───────────────────────────────────────── */
function switchSection(sectionId, clickedBtn) {
  // Deactivate all nav items
  document.querySelectorAll('.ops-nav-item').forEach(el => el.classList.remove('active'));
  // Activate clicked nav item
  if (clickedBtn) clickedBtn.classList.add('active');

  // Hide all sections
  document.querySelectorAll('.ops-section').forEach(el => el.classList.remove('active'));

  // Show the target section
  const target = document.getElementById(`section-${sectionId}`);
  if (target) target.classList.add('active');

  // Section-specific actions
  if (sectionId === 'live') initOpsMapIfNeeded();
  if (sectionId === 'performance') renderPerfSection();
  if (sectionId === 'routes-sec') renderRoutesSection();
  if (sectionId === 'alerts-sec') renderFullAlerts();
  if (sectionId === 'reports') {
    renderReportsSummary();
    renderReportsIllus();
  }
}

/* ─────────────────────────────────────────
   Init
───────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', initOperations);

async function initOperations() {
  renderSharedNavbar({ active: 'operations' });

  // Vehicle table listeners
  document.getElementById('vehicle-search').addEventListener('input', renderVehicleTable);
  document.getElementById('status-filter').addEventListener('change', renderVehicleTable);
  document.getElementById('ops-prev').addEventListener('click', () => {
    vehiclePage = Math.max(0, vehiclePage - 1);
    renderVehicleTable();
  });
  document.getElementById('ops-next').addEventListener('click', () => {
    vehiclePage += 1;
    renderVehicleTable();
  });

  // Inject songthaew illustration
  const illusEl = document.getElementById('overview-illus');
  if (illusEl) illusEl.innerHTML = songthaewIllusSvg(110, 55);
  const reportsIllusEl = document.getElementById('reports-illus');
  if (reportsIllusEl) reportsIllusEl.innerHTML = songthaewIllusSvg(110, 55);

  await refreshOperations();
  setInterval(refreshOperations, 6000);
}

/* ─────────────────────────────────────────
   Map Init (lazy — only when Live section shown)
───────────────────────────────────────── */
let opsMapInitialized = false;

async function initOpsMapIfNeeded() {
  if (opsMapInitialized) { renderOpsMap(); return; }
  await loadGoogleMapsAPI();
  if (!window.google?.maps) return;
  opsMap = new google.maps.Map(document.getElementById('ops-mini-map'), {
    center: { lat: 8.50, lng: 99.89 },
    zoom: 11,
    mapId: 'smart_songthaew_operations',
    disableDefaultUI: true,
    zoomControl: true,
  });
  opsMapInitialized = true;
  renderOpsMap();
}

/* ─────────────────────────────────────────
   Main Refresh Cycle
───────────────────────────────────────── */
async function refreshOperations() {
  try {
    const [fleet, routePayload, peakHours, config, historyAnalytics] = await Promise.all([
      fetch('/api/v1/vehicles').then(r => r.ok ? r.json() : { vehicles: [] }).then(payload => Object.fromEntries((payload.vehicles || []).map(vehicle => [vehicle.vehicle_id, {
        vehicleId: vehicle.vehicle_id,
        routeId: vehicle.route_id || 'unassigned',
        type: vehicle.type || 'real',
        current: { ...vehicle, timestamp: Number(vehicle.last_seen || 0) * 1000 },
      }]))),
      fetchPassengerRoutes(),
      fetch('/api/analytics/peak-hours').then(r => r.ok ? r.json() : {}),
      fetch('/api/config').then(r => r.ok ? r.json() : {}),
      fetchHistoryAnalyticsForReports(),
    ]);
    opsFleet = fleet || {};
    opsRoutes = normalizeRouteList(routePayload);
    opsHistoryAnalytics = historyAnalytics || { vehicles: [], fleet: {} };

    renderOpsSummary();
    renderPeakHours(peakHours, 'peak-hours-chart');
    renderRoutePerformance('route-performance');
    renderStatusChart();
    renderAlerts();
    renderAnnouncementPanel(config);
    renderVehicleTable();
    renderReportsSummary();

    // Refresh live map if visible
    if (document.getElementById('section-live')?.classList.contains('active')) renderOpsMap();
  } catch (error) {
    console.error('[operations]', error);
  }
}

async function fetchHistoryAnalyticsForReports() {
  try {
    const token = getAuthToken();
    if (!token) return { vehicles: [], fleet: {} };
    const response = await fetch(`/api/history/analytics?date=${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response || !response.ok) return { vehicles: [], fleet: {} };
    return response.json();
  } catch (_) {
    return { vehicles: [], fleet: {} };
  }
}

/* ─────────────────────────────────────────
   Fleet helpers
───────────────────────────────────────── */
function fleetRows() {
  return Object.entries(opsFleet || {}).map(([id, entry]) => {
    const current = entry.current || {};
    return {
      id,
      routeId: entry.routeId || current.routeId || 'unassigned',
      type: entry.type || 'real',
      current,
      status: classifyVehicle(entry),
    };
  });
}

function classifyVehicle(entry) {
  const current = entry.current || {};
  const battery = Number(current.battery);
  if (Number.isFinite(battery) && battery < 20) return 'issue';
  if (!current.timestamp) return 'offline';
  return isVehicleOnline(current)
    ? (Number(current.speed || 0) > 2 ? 'online' : 'idle')
    : 'offline';
}

/* ─────────────────────────────────────────
   Overview — Stat Cards + Sparklines
───────────────────────────────────────── */
function renderOpsSummary() {
  const rows = fleetRows();
  const online = rows.filter(r => r.status === 'online').length;
  const issue  = rows.filter(r => r.status === 'issue').length;
  const etaVal = rows.length ? Math.max(4, Math.round(18 - online + issue * 2)) : null;
  const onTime = rows.length
    ? Math.max(0, Math.min(100, Math.round(
        ((online + rows.filter(r => r.status === 'idle').length * 0.65) / rows.length) * 100
      )))
    : 0;

  setText('ops-total',   rows.length);
  setText('ops-online',  online);
  setText('ops-eta',     etaVal ? `${etaVal} นาที` : '—');
  setText('ops-on-time', `${onTime}%`);

  // Push to sparkline history (cap at 8)
  push8(sparkHistory.total,  rows.length);
  push8(sparkHistory.online, online);
  push8(sparkHistory.eta,    etaVal || 0);
  push8(sparkHistory.ontime, onTime);

  drawSparkline(document.getElementById('sparkline-total'),  sparkHistory.total,  '#2563eb');
  drawSparkline(document.getElementById('sparkline-online'), sparkHistory.online, '#16a34a');
  drawSparkline(document.getElementById('sparkline-eta'),    sparkHistory.eta,    '#7c3aed');
  drawSparkline(document.getElementById('sparkline-ontime'), sparkHistory.ontime, '#d97706');
}

function push8(arr, val) {
  arr.push(val);
  if (arr.length > 8) arr.shift();
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ─────────────────────────────────────────
   Peak Hours Chart
───────────────────────────────────────── */
function renderPeakHours(payload, canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !window.Chart) return;
  const labels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const values = labels.map((_, i) => payload?.[i] || payload?.data?.[i] || 0);

  if (canvasId === 'peak-hours-chart') {
    if (peakChart) peakChart.destroy();
    peakChart = buildBarChart(canvas, labels, values);
  } else {
    if (perfPeakChart) perfPeakChart.destroy();
    perfPeakChart = buildBarChart(canvas, labels, values);
  }
}

function buildBarChart(canvas, labels, values) {
  const max = Math.max(...values, 1);
  return new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: values.map(v => v > max * 0.7 ? '#2563EB' : '#CBD5E1'),
        borderRadius: 5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, callback: (_, i) => i % 3 === 0 ? `${String(i).padStart(2, '0')}:00` : '' } },
        y: { beginAtZero: true, grid: { color: '#E2E8F0' } },
      },
    },
  });
}

/* ─────────────────────────────────────────
   Route Performance
───────────────────────────────────────── */
function renderRoutePerformance(containerId) {
  const rows = fleetRows();
  const root = document.getElementById(containerId);
  if (!root) return;
  if (!opsRoutes.length) {
    root.innerHTML = `<div class="empty-state">${songthaewIllusSvg(80, 40)}<p style="margin-top:10px;">ยังไม่มีเส้นทาง</p></div>`;
    return;
  }
  root.innerHTML = opsRoutes.slice(0, 6).map(route => {
    const assigned = rows.filter(r => r.routeId === route.route_id);
    const online   = assigned.filter(r => r.status === 'online').length;
    const pct = assigned.length ? Math.round((online / assigned.length) * 100) : 0;
    const color = routeColor(route);
    return `
      <div>
        <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:5px;align-items:center;">
          <div style="font-size:12px;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${route.name || route.route_id}</div>
          <span class="small-badge ${pct >= 70 ? 'status-online' : pct >= 30 ? 'status-warning' : 'status-offline'}">${pct}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%;background:${color};"></div>
        </div>
      </div>`;
  }).join('');
}

/* ─────────────────────────────────────────
   Status Doughnut Chart
───────────────────────────────────────── */
function renderStatusChart() {
  const rows = fleetRows();
  const counts = {
    online:  rows.filter(r => r.status === 'online').length,
    idle:    rows.filter(r => r.status === 'idle').length,
    offline: rows.filter(r => r.status === 'offline').length,
    issue:   rows.filter(r => r.status === 'issue').length,
  };
  const ctx = document.getElementById('fleet-status-chart')?.getContext('2d');
  if (!ctx || !window.Chart) return;
  if (statusChart) statusChart.destroy();
  statusChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['ใช้งานอยู่', 'จอด/ไม่ให้บริการ', 'ออฟไลน์', 'มีปัญหา'],
      datasets: [{
        data: [counts.online, counts.idle, counts.offline, counts.issue],
        backgroundColor: ['#16A34A', '#D97706', '#6B7280', '#DC2626'],
        borderWidth: 0,
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } } },
      },
      cutout: '65%',
    },
  });
}

/* ─────────────────────────────────────────
   Live Map
───────────────────────────────────────── */
function renderOpsMap() {
  if (!opsMap) return;
  opsMarkers.forEach(m => { m.map = null; });
  opsMarkers = [];
  const bounds = new google.maps.LatLngBounds();
  fleetRows().forEach(row => {
    const lat = Number(row.current.lat);
    const lng = Number(row.current.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const pos = { lat, lng };
    bounds.extend(pos);
    opsMarkers.push(new google.maps.marker.AdvancedMarkerElement({
      map: opsMap,
      position: pos,
      title: row.id,
      content: createVehicleMarkerContent(row.current.speed || 0, row.status === 'online', false, false, 0),
    }));
  });
  if (!bounds.isEmpty()) opsMap.fitBounds(bounds, 36);
}

/* ─────────────────────────────────────────
   Alerts
───────────────────────────────────────── */
function buildAlertItems() {
  const rows = fleetRows();
  const alerts = [];
  rows.forEach(row => {
    const battery = Number(row.current.battery);
    if (Number.isFinite(battery) && battery < 20)
      alerts.push({ type: 'danger',  title: `${row.id} แบตเตอรี่ต่ำ`, meta: `${battery}%` });
    if (!Number.isFinite(Number(row.current.lat)) || !Number.isFinite(Number(row.current.lng)))
      alerts.push({ type: 'warning', title: `${row.id} GPS lost`, meta: 'ไม่มีพิกัดล่าสุด' });
    if (row.status === 'offline')
      alerts.push({ type: 'offline', title: `${row.id} ออฟไลน์`, meta: formatTime(row.current.timestamp) });
  });
  return alerts;
}

function alertItemHtml(alert) {
  return `
    <div class="list-item">
      <span class="item-icon" style="background:${alert.type === 'danger' ? 'var(--color-danger-50)' : alert.type === 'warning' ? 'var(--color-warning-50)' : 'var(--color-soft)'};color:${alert.type === 'danger' ? 'var(--color-danger)' : alert.type === 'warning' ? 'var(--color-warning)' : 'var(--color-offline)'};border-color:${alert.type === 'danger' ? 'var(--color-danger-100)' : alert.type === 'warning' ? 'var(--color-warning-100)' : 'var(--color-border)'};" aria-hidden="true">
        ${signalSvg(16, 'currentColor')}
      </span>
      <div><div class="item-title">${alert.title}</div><div class="item-meta">${alert.meta}</div></div>
      <span class="small-badge ${alert.type === 'danger' ? 'status-danger' : alert.type === 'offline' ? 'status-offline' : 'status-warning'}">${alert.type === 'danger' ? 'แบต' : alert.type === 'offline' ? 'ออฟไลน์' : 'GPS'}</span>
    </div>`;
}

function renderAlerts() {
  const alerts = buildAlertItems();
  const root = document.getElementById('ops-alerts');
  if (root) {
    root.innerHTML = alerts.slice(0, 5).map(alertItemHtml).join('')
      || '<div class="empty-state">ไม่มีการแจ้งเตือน ✓</div>';
  }
}

function renderFullAlerts() {
  const alerts = buildAlertItems();
  const root = document.getElementById('alerts-full-list');
  if (root) {
    root.innerHTML = alerts.map(alertItemHtml).join('')
      || `<div class="empty-state" style="padding:32px 16px;">
            ${songthaewIllusSvg(100, 50)}
            <p style="margin-top:12px;font-weight:600;">ไม่มีการแจ้งเตือนในขณะนี้</p>
          </div>`;
  }
}

/* ─────────────────────────────────────────
   Announcement Panel
───────────────────────────────────────── */
function renderAnnouncementPanel(config) {
  const root = document.getElementById('ops-announcement');
  if (!root) return;
  root.innerHTML = config?.announcement
    ? `<div class="item-title" style="font-size:13px;line-height:1.6;">${config.announcement}</div>
       <div class="item-meta" style="margin-top:8px;">อัปเดต ${formatTime(config.updatedAt)}</div>`
    : `<div class="empty-state">ยังไม่มีประกาศ</div>`;
}

/* ─────────────────────────────────────────
   Vehicle Table
───────────────────────────────────────── */
function renderVehicleTable() {
  const query  = (document.getElementById('vehicle-search')?.value || '').trim().toLowerCase();
  const filter = document.getElementById('status-filter')?.value || 'all';
  let rows = fleetRows().filter(row => {
    const route = opsRoutes.find(r => r.route_id === row.routeId);
    const matchesQuery  = !query || row.id.toLowerCase().includes(query) || String(route?.name || row.routeId).toLowerCase().includes(query);
    const matchesFilter = filter === 'all' || row.status === filter;
    return matchesQuery && matchesFilter;
  });

  const start = vehiclePage * VEHICLE_PAGE_SIZE;
  const page  = rows.slice(start, start + VEHICLE_PAGE_SIZE);
  if (start >= rows.length && vehiclePage > 0) { vehiclePage--; return renderVehicleTable(); }

  const body = document.getElementById('vehicle-table-body');
  if (!body) return;
  body.innerHTML = page.length ? page.map(row => {
    const route   = opsRoutes.find(r => r.route_id === row.routeId);
    const battery = Number(row.current.battery);
    const batVal  = Number.isFinite(battery) ? battery : 0;
    const plate   = row.current.plate ? `<span style="font-family:monospace;font-size:11px;background:var(--color-soft);padding:2px 6px;border-radius:4px;border:1px solid var(--color-border);">${row.current.plate}</span>` : '';
    return `
      <tr>
        <td><strong style="font-size:13px;">${row.id}</strong> ${plate}</td>
        <td>${statusBadge(row.status)}</td>
        <td style="font-size:12px;">${route?.name || row.routeId}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px;">
            <div class="progress-track" style="height:6px;min-width:72px;">
              <div class="progress-fill" style="width:${batVal}%;background:${batVal < 20 ? '#DC2626' : batVal < 50 ? '#D97706' : '#16A34A'};"></div>
            </div>
            <span style="font-size:12px;font-weight:700;">${Number.isFinite(battery) ? `${battery}%` : '—'}</span>
          </div>
        </td>
        <td style="font-size:12px;">${formatTime(row.current.timestamp)}</td>
        <td style="font-size:11px;color:var(--color-muted);">${row.type}</td>
      </tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-state">ไม่พบยานพาหนะ</td></tr>';
}

function statusBadge(status) {
  const map = {
    online:  ['ใช้งานอยู่',          'status-online'],
    idle:    ['จอด/ไม่ให้บริการ',    'status-warning'],
    offline: ['ออฟไลน์',             'status-offline'],
    issue:   ['มีปัญหา',             'status-danger'],
  };
  const [label, cls] = map[status] || map.offline;
  return `<span class="small-badge ${cls}">${label}</span>`;
}

/* ─────────────────────────────────────────
   Routes Section
───────────────────────────────────────── */
function renderRoutesSection() {
  const root = document.getElementById('routes-overview');
  if (!root) return;
  const rows = fleetRows();
  if (!opsRoutes.length) {
    root.innerHTML = `<div class="empty-state">${songthaewIllusSvg(100, 50)}<p style="margin-top:10px;">ยังไม่มีเส้นทาง</p></div>`;
    return;
  }
  root.innerHTML = opsRoutes.map(route => {
    const assigned = rows.filter(r => r.routeId === route.route_id);
    const online   = assigned.filter(r => r.status === 'online').length;
    const stops    = routeStops(route).length;
    return `
      <div class="list-item">
        <span class="item-icon" style="background:${route.color || '#2563eb'}22;color:${route.color || '#2563eb'};border-color:${route.color || '#2563eb'}44;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 17c3-3 4-7 9-7s6 4 9 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M3 7c3 3 4 7 9 7s6-4 9-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </span>
        <div>
          <div class="item-title">${route.name || route.route_id}</div>
          <div class="item-meta">${stops} จุดจอด · ${assigned.length} คัน · ออนไลน์ ${online} คัน</div>
        </div>
        <span class="small-badge ${online > 0 ? 'status-online' : 'status-offline'}">${online > 0 ? 'ACTIVE' : 'IDLE'}</span>
      </div>`;
  }).join('');
}

/* ─────────────────────────────────────────
   Performance Section (lazy clone of overview charts)
───────────────────────────────────────── */
function renderPerfSection() {
  renderRoutePerformance('perf-route-performance');
  // Fetch peak hours for perf section chart
  fetch('/api/analytics/peak-hours')
    .then(r => r.ok ? r.json() : {})
    .then(data => renderPeakHours(data, 'perf-peak-chart'))
    .catch(() => {});
}

/* ─────────────────────────────────────────
   Reports Section Illustration
───────────────────────────────────────── */
function renderReportsSummary() {
  const body = document.getElementById('reports-summary-body');
  if (!body) return;

  const rows = (opsHistoryAnalytics.vehicles || [])
    .slice()
    .sort((a, b) => Number(b.totalDistanceKm || 0) - Number(a.totalDistanceKm || 0));
  const sub = document.getElementById('reports-summary-sub');
  const fleet = opsHistoryAnalytics.fleet || {};

  if (sub) {
    sub.textContent = rows.length
      ? `${rows.length} คัน • ${Number(fleet.totalDistanceKm || 0).toFixed(1)} กม. • ออนไลน์ ${Math.round(Number(fleet.onlineRatio || 0) * 100)}%`
      : 'ยังไม่มีข้อมูลประวัติของวันนี้';
  }

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">ยังไม่มีข้อมูลประวัติของวันนี้</td></tr>';
    return;
  }

  const date = opsHistoryAnalytics.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  body.innerHTML = rows.map(row => {
    const battery = row.batteryEnd ?? row.batteryStart;
    const href = `/admin.html?tab=history&vehicleId=${encodeURIComponent(row.vehicleId)}&date=${encodeURIComponent(date)}`;
    return `
      <tr>
        <td><strong>${row.vehicleId}</strong></td>
        <td>${Number(row.totalDistanceKm || 0).toFixed(1)} กม.</td>
        <td>${Number(row.avgSpeed || 0).toFixed(1)} กม./ชม.</td>
        <td>${formatOpsHistoryHours(row.activeHours)}</td>
        <td>${battery != null ? `${battery}%` : '-'}</td>
        <td><a class="button ghost" href="${href}" style="min-height:24px;">เปิด</a></td>
      </tr>`;
  }).join('');
}

function formatOpsHistoryHours(hours) {
  const totalMinutes = Math.max(0, Math.round(Number(hours || 0) * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h ? `${h} ชม. ${m} นาที` : `${m} นาที`;
}

function renderReportsIllus() {
  const el = document.getElementById('reports-illus');
  if (el && !el.innerHTML) el.innerHTML = songthaewIllusSvg(110, 55);
}
