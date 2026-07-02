'use strict';

let historyMap;
let historyInfoWindow;
let speedChart;
let batteryChart;
let historyVehicles = [];
let trailSets = [];
let tablePage = 0;
const HISTORY_PAGE_SIZE = 20;
const HISTORY_COLORS = ['#2563EB', '#16A34A', '#D97706', '#7C3AED', '#DC2626', '#0891B2', '#4F46E5'];
const mapObjects = [];

document.addEventListener('DOMContentLoaded', initHistoryPage);

async function initHistoryPage() {
  if (!await requireAuth()) return;
  renderSharedNavbar({ active: 'history' });
  bindHistoryControls();
  const params = new URLSearchParams(location.search);
  document.getElementById('history-date').value = params.get('date') || todayInputValue();
  await initHistoryMap();
  await loadHistoryVehicles(params.get('vehicleId'));
  await loadHistoryTrail();
}

function bindHistoryControls() {
  document.getElementById('history-date').addEventListener('change', async () => {
    await loadHistoryVehicles();
  });
  document.getElementById('history-search').addEventListener('click', loadHistoryTrail);
  document.getElementById('history-export').addEventListener('click', exportHistoryCsv);
  document.getElementById('history-filter').addEventListener('input', () => {
    tablePage = 0;
    renderHistoryTable();
  });
  document.getElementById('history-prev').addEventListener('click', () => {
    tablePage = Math.max(0, tablePage - 1);
    renderHistoryTable();
  });
  document.getElementById('history-next').addEventListener('click', () => {
    tablePage += 1;
    renderHistoryTable();
  });
}

function todayInputValue() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

async function historyGet(path) {
  const response = await authFetch(path);
  if (!response) throw new Error('auth');
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return response.json();
}

async function loadHistoryVehicles(preferredVehicleId = '') {
  const date = document.getElementById('history-date').value || todayInputValue();
  setHistoryStatus('กำลังโหลดรายการรถ...');
  try {
    const payload = await historyGet(`/api/history/vehicles?date=${encodeURIComponent(date)}`);
    historyVehicles = payload.vehicles || [];
    const select = document.getElementById('history-vehicle');
    select.innerHTML = [
      historyVehicles.length > 1 ? '<option value="all">รถทุกคัน</option>' : '',
      ...historyVehicles.map(id => `<option value="${id}">${id}</option>`),
    ].join('');
    select.value = preferredVehicleId && historyVehicles.includes(preferredVehicleId)
      ? preferredVehicleId
      : historyVehicles[0] || (historyVehicles.length ? 'all' : '');
    setHistoryStatus(historyVehicles.length ? `${historyVehicles.length} คัน • ${payload.totalRecords || 0} records` : 'ยังไม่มีประวัติในวันนี้');
  } catch (error) {
    console.error('[history vehicles]', error);
    setHistoryStatus('โหลดรายการรถไม่สำเร็จ');
  }
}

async function initHistoryMap() {
  await loadGoogleMapsAPI();
  const mapEl = document.getElementById('history-map');
  if (!window.google?.maps) {
    mapEl.textContent = 'ไม่สามารถโหลดแผนที่ได้';
    return;
  }
  historyMap = new google.maps.Map(mapEl, {
    center: { lat: 8.50, lng: 99.89 },
    zoom: 11,
    mapId: 'smart_songthaew_history',
    disableDefaultUI: true,
    zoomControl: true,
  });
  historyInfoWindow = new google.maps.InfoWindow();
}

async function loadHistoryTrail() {
  const date = document.getElementById('history-date').value || todayInputValue();
  const selected = document.getElementById('history-vehicle').value;
  if (!selected) {
    trailSets = [];
    renderHistory();
    setHistoryStatus('ไม่มีรถให้เลือก');
    return;
  }
  const from = document.getElementById('history-from').value;
  const to = document.getElementById('history-to').value;
  const ids = selected === 'all' ? historyVehicles : [selected];
  setHistoryStatus('กำลังโหลด trail...');
  try {
    trailSets = await Promise.all(ids.map(vehicleId => {
      const params = new URLSearchParams({ vehicleId, date });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      return historyGet(`/api/history/trail?${params}`).then(payload => ({
        vehicleId,
        points: payload.points || [],
        summary: payload.summary || {},
      }));
    }));
    tablePage = 0;
    renderHistory();
    const total = allHistoryPoints().length;
    setHistoryStatus(total ? `${total} จุดจาก ${ids.length} คัน` : 'ไม่พบข้อมูลในช่วงเวลานี้');
  } catch (error) {
    console.error('[history trail]', error);
    setHistoryStatus('โหลดประวัติไม่สำเร็จ');
  }
}

function renderHistory() {
  renderSummaryCards();
  renderTrailMap();
  renderHistoryCharts();
  renderHistoryTable();
}

function allHistoryPoints() {
  return trailSets.flatMap(set => set.points.map(point => ({ ...point, vehicleId: set.vehicleId })))
    .sort((a, b) => a.ts - b.ts);
}

function renderSummaryCards() {
  const sets = trailSets.filter(set => set.points.length);
  const totalPoints = sets.reduce((sum, set) => sum + (set.summary.totalPoints || 0), 0);
  const distanceKm = sets.reduce((sum, set) => sum + Number(set.summary.distanceKm || 0), 0);
  const speedWeighted = sets.reduce((sum, set) => sum + Number(set.summary.avgSpeed || 0) * Number(set.summary.totalPoints || 0), 0);
  const activeHours = sets.reduce((sum, set) => sum + Number(set.summary.activeHours || 0), 0);
  const lastBattery = [...allHistoryPoints()].reverse().find(point => Number.isFinite(Number(point.battery)))?.battery;
  setText('summary-distance', `${distanceKm.toFixed(1)} กม.`);
  setText('summary-speed', totalPoints ? `${(speedWeighted / totalPoints).toFixed(1)} กม./ชม.` : '—');
  setText('summary-online', formatHours(activeHours));
  setText('summary-battery', lastBattery != null ? `${lastBattery}%` : '—');
}

function renderTrailMap() {
  clearMapObjects();
  if (!historyMap || !window.google?.maps) return;
  const bounds = new google.maps.LatLngBounds();
  const multiVehicle = trailSets.filter(set => set.points.length).length > 1;
  trailSets.forEach((set, setIndex) => {
    const points = set.points.filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
    if (!points.length) return;
    const vehicleColor = HISTORY_COLORS[setIndex % HISTORY_COLORS.length];
    points.forEach(point => bounds.extend({ lat: point.lat, lng: point.lng }));
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const point = points[i];
      const color = multiVehicle ? vehicleColor : speedColor((Number(prev.speed || 0) + Number(point.speed || 0)) / 2);
      const line = new google.maps.Polyline({
        map: historyMap,
        path: [{ lat: prev.lat, lng: prev.lng }, { lat: point.lat, lng: point.lng }],
        strokeColor: color,
        strokeOpacity: 0.9,
        strokeWeight: 4,
        icons: i % Math.max(2, Math.round(points.length / 10)) === 0 ? [{
          icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 2.8, strokeColor: color, fillColor: color, fillOpacity: 0.9 },
          offset: '55%',
        }] : [],
      });
      line.addListener('click', event => showPointInfo(point, event.latLng));
      mapObjects.push(line);
    }
    addHistoryMarker(points[0], vehicleColor, 'start', set.vehicleId);
    addHistoryMarker(points[points.length - 1], '#DC2626', 'end', set.vehicleId);
    const sampleStep = Math.max(1, Math.ceil(points.length / 500));
    points.filter((_, index) => index % sampleStep === 0).forEach(point => addPointDot(point, vehicleColor));
  });
  if (!bounds.isEmpty()) historyMap.fitBounds(bounds, 42);
}

function clearMapObjects() {
  mapObjects.splice(0).forEach(item => {
    if (item.setMap) item.setMap(null);
    else item.map = null;
  });
}

function addHistoryMarker(point, color, kind, vehicleId) {
  const marker = new google.maps.marker.AdvancedMarkerElement({
    map: historyMap,
    position: { lat: point.lat, lng: point.lng },
    title: `${vehicleId} ${kind}`,
    content: markerContent(color, kind === 'start' ? 'S' : 'E', 26),
    zIndex: kind === 'start' ? 600 : 650,
  });
  marker.addListener('click', () => showPointInfo({ ...point, vehicleId }, marker.position));
  mapObjects.push(marker);
}

function addPointDot(point, color) {
  const marker = new google.maps.marker.AdvancedMarkerElement({
    map: historyMap,
    position: { lat: point.lat, lng: point.lng },
    title: `${point.time} ${point.speed} km/h`,
    content: markerContent(color, '', 8),
    zIndex: 500,
  });
  marker.addListener('click', () => showPointInfo(point, marker.position));
  mapObjects.push(marker);
}

function markerContent(color, label = '', size = 12) {
  const el = document.createElement('div');
  el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 2px 8px ${color}55;display:grid;place-items:center;color:#fff;font-size:10px;font-weight:800;`;
  el.textContent = label;
  return el;
}

function showPointInfo(point, position) {
  if (!historyInfoWindow) return;
  historyInfoWindow.setContent(`
    <div style="font-size:12px;line-height:1.5;min-width:160px;">
      <strong>${point.vehicleId || ''} ${point.time || ''}</strong><br/>
      Speed: ${point.speed ?? '—'} km/h<br/>
      Battery: ${point.battery ?? '—'}%<br/>
      RSSI: ${point.rssi ?? '—'}<br/>
      Hop: ${point.hop ?? '—'}<br/>
      Direction: ${point.direction || '—'}
    </div>`);
  historyInfoWindow.setPosition(position);
  historyInfoWindow.open(historyMap);
}

function renderHistoryCharts() {
  const labels = [...new Set(allHistoryPoints().map(point => point.time))].sort();
  const speedDatasets = trailSets.map((set, index) => buildDataset(set, labels, 'speed', HISTORY_COLORS[index % HISTORY_COLORS.length], ' km/h'));
  const batteryDatasets = trailSets.map((set, index) => buildDataset(set, labels, 'battery', HISTORY_COLORS[index % HISTORY_COLORS.length], '%'));
  speedChart = renderLineChart(speedChart, 'speed-chart', labels, speedDatasets, 'km/h');
  batteryChart = renderLineChart(batteryChart, 'battery-chart', labels, batteryDatasets, '%');
}

function buildDataset(set, labels, field, color) {
  const byTime = new Map(set.points.map(point => [point.time, Number(point[field])]));
  return {
    label: set.vehicleId,
    data: labels.map(label => Number.isFinite(byTime.get(label)) ? byTime.get(label) : null),
    borderColor: color,
    backgroundColor: `${color}22`,
    borderWidth: 2,
    tension: 0.28,
    pointRadius: 0,
    spanGaps: true,
  };
}

function renderLineChart(existingChart, canvasId, labels, datasets, unit) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !window.Chart) return existingChart;
  if (existingChart) existingChart.destroy();
  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: datasets.length > 1, labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: item => `${item.dataset.label}: ${item.formattedValue}${unit}` } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } },
        y: { beginAtZero: true, grid: { color: '#E2E8F0' } },
      },
    },
  });
}

function renderHistoryTable() {
  const query = (document.getElementById('history-filter').value || '').trim().toLowerCase();
  let rows = allHistoryPoints();
  if (query) {
    rows = rows.filter(point => `${point.vehicleId} ${point.time} ${point.speed} ${point.battery} ${point.rssi} ${point.hop} ${point.direction} ${point.lat},${point.lng}`.toLowerCase().includes(query));
  }
  const start = tablePage * HISTORY_PAGE_SIZE;
  if (start >= rows.length && tablePage > 0) {
    tablePage -= 1;
    return renderHistoryTable();
  }
  const pageRows = rows.slice(start, start + HISTORY_PAGE_SIZE);
  const body = document.getElementById('history-table-body');
  body.innerHTML = pageRows.length ? pageRows.map((point, index) => `
    <tr data-index="${start + index}">
      <td>${point.vehicleId}</td>
      <td>${point.time}</td>
      <td>${formatSpeedKmh(point.speed)}</td>
      <td>${point.battery != null ? `${point.battery}%` : '—'}</td>
      <td>${point.rssi ?? '—'}</td>
      <td>${point.hop ?? '—'}</td>
      <td>${point.direction || '—'}</td>
      <td>${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty-state">ไม่พบข้อมูล</td></tr>';
  [...body.querySelectorAll('tr[data-index]')].forEach(row => {
    row.addEventListener('click', () => focusHistoryPoint(rows[Number(row.dataset.index)]));
  });
  const totalPages = Math.max(1, Math.ceil(rows.length / HISTORY_PAGE_SIZE));
  document.getElementById('history-page-label').textContent = `หน้า ${Math.min(tablePage + 1, totalPages)} / ${totalPages} • ${rows.length} records`;
}

function focusHistoryPoint(point) {
  if (!point || !historyMap) return;
  const pos = { lat: point.lat, lng: point.lng };
  historyMap.panTo(pos);
  historyMap.setZoom(Math.max(historyMap.getZoom() || 14, 15));
  showPointInfo(point, pos);
}

function exportHistoryCsv() {
  const rows = allHistoryPoints();
  if (!rows.length) return;
  const headers = ['timestamp', 'time', 'vehicleId', 'lat', 'lng', 'speed', 'battery', 'rssi', 'hop', 'direction'];
  const csv = [
    headers.join(','),
    ...rows.map(point => headers.map(key => csvCell(point[key === 'timestamp' ? 'ts' : key])).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const vehicle = document.getElementById('history-vehicle').value || 'all';
  const date = document.getElementById('history-date').value || todayInputValue();
  const link = document.createElement('a');
  link.href = url;
  link.download = `songthaew_${vehicle}_${date}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function speedColor(speed) {
  const value = Number(speed);
  if (!Number.isFinite(value) || value < 40) return '#16A34A';
  if (value <= 60) return '#D97706';
  return '#DC2626';
}

function formatHours(hours) {
  const totalMinutes = Math.round(Number(hours || 0) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h ? `${h} ชม. ${m} นาที` : `${m} นาที`;
}

function setHistoryStatus(message) {
  const el = document.getElementById('history-status');
  if (el) el.textContent = message;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
