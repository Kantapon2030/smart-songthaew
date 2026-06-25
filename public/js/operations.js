'use strict';

let opsFleet = {};
let opsRoutes = [];
let opsMap;
let opsMarkers = [];
let peakChart;
let statusChart;
let vehiclePage = 0;
const VEHICLE_PAGE_SIZE = 10;

document.addEventListener('DOMContentLoaded', initOperations);

async function initOperations() {
  renderSharedNavbar({ active: 'operations' });
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
  await initOpsMap();
  await refreshOperations();
  setInterval(refreshOperations, 6000);
}

async function initOpsMap() {
  await loadGoogleMapsAPI();
  if (!window.google?.maps) return;
  opsMap = new google.maps.Map(document.getElementById('ops-mini-map'), {
    center: { lat: 8.50, lng: 99.89 },
    zoom: 11,
    mapId: 'smart_songthaew_operations',
    disableDefaultUI: true,
    zoomControl: true,
  });
}

async function refreshOperations() {
  try {
    const [fleet, routePayload, peakHours, config] = await Promise.all([
      fetch('/api/fleet').then(response => response.json()),
      fetchPassengerRoutes(),
      fetch('/api/analytics/peak-hours').then(response => response.ok ? response.json() : {}),
      fetch('/api/config').then(response => response.ok ? response.json() : {}),
    ]);
    opsFleet = fleet || {};
    opsRoutes = normalizeRouteList(routePayload);
    renderOpsSummary();
    renderPeakHours(peakHours);
    renderRoutePerformance();
    renderStatusChart();
    renderOpsMap();
    renderAlerts();
    renderAnnouncementPanel(config);
    renderVehicleTable();
  } catch (error) {
    console.error('[operations]', error);
  }
}

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
  const online = isVehicleOnline(current);
  if (!online) return 'offline';
  return Number(current.speed || 0) > 2 ? 'online' : 'idle';
}

function renderOpsSummary() {
  const rows = fleetRows();
  const online = rows.filter(row => row.status === 'online').length;
  const issue = rows.filter(row => row.status === 'issue').length;
  document.getElementById('ops-total').textContent = rows.length;
  document.getElementById('ops-online').textContent = online;
  const eta = rows.length ? Math.max(4, Math.round(18 - online + issue * 2)) : null;
  document.getElementById('ops-eta').textContent = eta ? `${eta} นาที` : '—';
  const onTime = rows.length ? Math.max(0, Math.min(100, Math.round(((online + rows.filter(row => row.status === 'idle').length * 0.65) / rows.length) * 100))) : 0;
  document.getElementById('ops-on-time').textContent = `${onTime}%`;
}

function renderPeakHours(payload) {
  const labels = Array.from({ length: 24 }, (_, index) => `${String(index).padStart(2, '0')}:00`);
  const values = labels.map((_, index) => payload?.[index] || payload?.data?.[index] || 0);
  const ctx = document.getElementById('peak-hours-chart')?.getContext('2d');
  if (!ctx || !window.Chart) return;
  if (peakChart) peakChart.destroy();
  peakChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: values.map(value => value > Math.max(...values) * 0.7 ? '#2563EB' : '#CBD5E1'),
        borderRadius: 6,
      }],
    },
    options: chartOptions(),
  });
}

function renderRoutePerformance() {
  const rows = fleetRows();
  const root = document.getElementById('route-performance');
  if (!opsRoutes.length) {
    root.innerHTML = '<div class="empty-state">ยังไม่มีเส้นทาง</div>';
    return;
  }
  root.innerHTML = opsRoutes.slice(0, 6).map(route => {
    const assigned = rows.filter(row => row.routeId === route.route_id);
    const online = assigned.filter(row => row.status === 'online').length;
    const percentage = assigned.length ? Math.round((online / assigned.length) * 100) : 0;
    return `
      <div>
        <div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:7px;">
          <strong>${route.name}</strong>
          <span class="metric-label">${percentage}%</span>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${percentage}%;background:${routeColor(route)};"></div></div>
      </div>`;
  }).join('');
}

function renderStatusChart() {
  const rows = fleetRows();
  const counts = {
    online: rows.filter(row => row.status === 'online').length,
    idle: rows.filter(row => row.status === 'idle').length,
    offline: rows.filter(row => row.status === 'offline').length,
    issue: rows.filter(row => row.status === 'issue').length,
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
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } } },
      cutout: '68%',
    },
  });
}

function chartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false }, ticks: { maxRotation: 0, callback: (_, index) => index % 3 === 0 ? `${String(index).padStart(2, '0')}:00` : '' } },
      y: { beginAtZero: true, grid: { color: '#E2E8F0' } },
    },
  };
}

function renderOpsMap() {
  if (!opsMap) return;
  opsMarkers.forEach(marker => { marker.map = null; });
  opsMarkers = [];
  const bounds = new google.maps.LatLngBounds();
  fleetRows().forEach(row => {
    const lat = Number(row.current.lat);
    const lng = Number(row.current.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const position = { lat, lng };
    bounds.extend(position);
    opsMarkers.push(new google.maps.marker.AdvancedMarkerElement({
      map: opsMap,
      position,
      title: row.id,
      content: createVehicleMarkerContent(row.current.speed || 0, row.status === 'online', false, false, 0),
    }));
  });
  if (!bounds.isEmpty()) opsMap.fitBounds(bounds, 36);
}

function renderAlerts() {
  const rows = fleetRows();
  const alerts = [];
  rows.forEach(row => {
    const battery = Number(row.current.battery);
    if (Number.isFinite(battery) && battery < 20) alerts.push({ type: 'danger', title: `${row.id} แบตเตอรี่ต่ำ`, meta: `${battery}%` });
    if (!Number.isFinite(Number(row.current.lat)) || !Number.isFinite(Number(row.current.lng))) alerts.push({ type: 'warning', title: `${row.id} GPS lost`, meta: 'ไม่มีพิกัดล่าสุด' });
    if (row.status === 'offline') alerts.push({ type: 'offline', title: `${row.id} ออฟไลน์`, meta: formatTime(row.current.timestamp) });
  });
  document.getElementById('ops-alerts').innerHTML = alerts.slice(0, 5).map(alert => `
    <div class="list-item">
      <span class="item-icon" aria-hidden="true">${signalSvg(17, alert.type === 'danger' ? '#DC2626' : '#D97706')}</span>
      <span><span class="item-title">${alert.title}</span><span class="item-meta">${alert.meta}</span></span>
      <span class="small-badge ${alert.type === 'danger' ? 'status-danger' : alert.type === 'offline' ? 'status-offline' : 'status-warning'}">${alert.type}</span>
    </div>`).join('') || '<div class="empty-state">ไม่มีการแจ้งเตือน</div>';
}

function renderAnnouncementPanel(config) {
  document.getElementById('ops-announcement').innerHTML = config?.announcement
    ? `<div class="item-title">${config.announcement}</div><div class="item-meta">อัปเดต ${formatTime(config.updatedAt)}</div>`
    : '<div class="empty-state">ยังไม่มีประกาศ</div>';
}

function renderVehicleTable() {
  const query = document.getElementById('vehicle-search').value.trim().toLowerCase();
  const filter = document.getElementById('status-filter').value;
  let rows = fleetRows();
  rows = rows.filter(row => {
    const route = opsRoutes.find(item => item.route_id === row.routeId);
    const matchesQuery = !query || row.id.toLowerCase().includes(query) || String(route?.name || row.routeId).toLowerCase().includes(query);
    const matchesFilter = filter === 'all' || row.status === filter;
    return matchesQuery && matchesFilter;
  });
  const start = vehiclePage * VEHICLE_PAGE_SIZE;
  const page = rows.slice(start, start + VEHICLE_PAGE_SIZE);
  if (start >= rows.length && vehiclePage > 0) {
    vehiclePage = Math.max(0, vehiclePage - 1);
    return renderVehicleTable();
  }
  const body = document.getElementById('vehicle-table-body');
  body.innerHTML = page.length ? page.map(row => {
    const route = opsRoutes.find(item => item.route_id === row.routeId);
    const battery = Number(row.current.battery);
    const batteryValue = Number.isFinite(battery) ? battery : 0;
    return `
      <tr>
        <td><strong>${row.id}</strong></td>
        <td>${statusBadge(row.status)}</td>
        <td>${route?.name || row.routeId}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="progress-track" style="height:7px;min-width:90px;"><div class="progress-fill" style="width:${batteryValue}%;background:${batteryValue < 20 ? '#DC2626' : batteryValue < 50 ? '#D97706' : '#16A34A'};"></div></div>
            <span>${Number.isFinite(battery) ? `${battery}%` : '—'}</span>
          </div>
        </td>
        <td>${formatTime(row.current.timestamp)}</td>
        <td>${row.type}</td>
      </tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-state">ไม่พบยานพาหนะ</td></tr>';
}

function statusBadge(status) {
  const map = {
    online: ['ใช้งานอยู่', 'status-online'],
    idle: ['จอด/ไม่ให้บริการ', 'status-warning'],
    offline: ['ออฟไลน์', 'status-offline'],
    issue: ['มีปัญหา', 'status-danger'],
  };
  const [label, cls] = map[status] || map.offline;
  return `<span class="small-badge ${cls}">${label}</span>`;
}
