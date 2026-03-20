/**
 * admin.js — Fleet Admin Dashboard (v5)
 * [NEW] Serial Monitor — จำลอง log จาก ESP8266
 * [NEW] Power Dashboard — battery ring, solar, current draw
 * [NEW] IoT Stats — packets, latency, HDOP, satellites, RSSI
 * [NEW] Demo Mode — simulator auto-run พร้อม overlay
 */
'use strict';

// ─────────────────────────────────────────────────────────────
// ถ.อังรีดูนัง
const ROUTE_COORDS = [
  [13.7451, 100.5358],[13.7428, 100.5356],[13.7407, 100.5350],
  [13.7384, 100.5345],[13.7360, 100.5340],[13.7342, 100.5337],[13.7311, 100.5336],
];
const ROUTE_NAMES = ['Siam Square','สาธิตปทุมวัน','ประตูจุฬาฯ','คณะสัตวแพทย์','รพ.จุฬา','สถานเสาวภา','แยก Rama IV'];
const REAL_VEHICLE_ID = 'songthaew_01';
const OFFLINE_TIMEOUT = 15_000;

// ─── State ────────────────────────────────────────────────────
let adminMap     = null;
let marker       = null;
let chartObj     = null;
let batChart     = null;
let chartMode    = 'speed';
let demoMode     = false;
let demoInterval = null;
let uptimeStart  = Date.now();

// IoT Stats counters
let pktTotal   = 0;
let pktSuccess = 0;
let latencies  = [];  // rolling 10
let batHistory = [];  // rolling 20

// Serial auto-scroll
let autoScroll = true;

// ─── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initBatteryChart();
  startClock();
  startUptimeCounter();
  fetchData();
  loadChart();
  setInterval(fetchData, 4000);
  setInterval(loadChart, 20_000);
  setInterval(updatePowerSimulation, 3000);
});

// ════════════════════════════════════════════════════════════
//  MAP
// ════════════════════════════════════════════════════════════
function initMap() {
  const el = document.getElementById('admin-map');
  if (!el) return;
  adminMap = L.map('admin-map', { zoomControl: false });
  L.control.zoom({ position: 'bottomright' }).addTo(adminMap);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19,
  }).addTo(adminMap);

  // Route polyline
  L.polyline(ROUTE_COORDS, { color: '#2563EB', weight: 5, opacity: 0.5 }).addTo(adminMap);

  // Stop markers
  ROUTE_COORDS.forEach((pos, i) => {
    L.marker(pos, {
      icon: L.divIcon({
        className: 'clean-icon',
        html: `<div style="background:white;color:#475569;border:1px solid #E2E8F0;border-radius:8px;
          padding:4px 9px;font-family:'Sarabun',sans-serif;font-size:10px;font-weight:700;
          white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          ${i === 0 || i === 4 ? '📍' : '●'} ${ROUTE_NAMES[i]}</div>`,
        iconAnchor: [0, 0],
      }),
    }).addTo(adminMap);
  });

  adminMap.fitBounds(L.latLngBounds(ROUTE_COORDS).pad(0.12));
}

function fitAll() {
  if (adminMap) adminMap.fitBounds(L.latLngBounds(ROUTE_COORDS).pad(0.1), { animate: true });
}

// ── Vehicle icon ──────────────────────────────────────────────
function vehicleIcon(speed = 0, online = true) {
  const color = !online ? '#94A3B8' : speed === 0 ? '#DC2626' : speed < 20 ? '#D97706' : '#2563EB';
  return L.divIcon({
    className: 'clean-icon', iconSize: [44, 56], iconAnchor: [22, 46],
    html: `<div style="text-align:center;${!online ? 'opacity:.45;' : ''}">
      <div style="width:40px;height:40px;border-radius:50%;background:${color};border:3px solid white;
        display:inline-flex;align-items:center;justify-content:center;font-size:18px;
        box-shadow:0 4px 14px ${color}44;">🚐</div>
      <div style="background:${color};color:white;border-radius:6px;font-family:'IBM Plex Mono',monospace;
        font-size:9px;font-weight:700;padding:1px 6px;margin-top:2px;white-space:nowrap;">
        ${REAL_VEHICLE_ID}</div>
    </div>`,
  });
}

function isOnline(v) { return !!(v?.timestamp && (Date.now() - v.timestamp) < OFFLINE_TIMEOUT); }

// ════════════════════════════════════════════════════════════
//  FETCH + UPDATE
// ════════════════════════════════════════════════════════════
async function fetchData() {
  const t0 = Date.now();
  try {
    const res = await fetch('/api/locations');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const v    = data[REAL_VEHICLE_ID]?.current;

    const latency = Date.now() - t0;
    pktTotal++;
    pktSuccess++;
    latencies.push(latency);
    if (latencies.length > 10) latencies.shift();

    updateKPI(v);
    updateDeviceHealth(v);
    updateMapMarker(v);
    updateIoTStats(v, latency);
    if (v) {
      appendSerialLog(v, latency);
      updateBatteryHistory(v.battery);
    }

  } catch (err) {
    pktTotal++;
    console.error('[admin] fetchData:', err.message);
    appendSerialLogError(err.message);
    updateKPI(null);
    updateDeviceHealth(null);
  }
}

// ── Map Marker ────────────────────────────────────────────────
function updateMapMarker(v) {
  if (!adminMap) return;
  if (!v || !isOnline(v)) {
    if (marker) { adminMap.removeLayer(marker); marker = null; }
    return;
  }
  const icon = vehicleIcon(v.speed || 0, true);
  if (!marker) {
    marker = L.marker([v.lat, v.lng], { icon }).addTo(adminMap).bindPopup(buildPopup(v));
    adminMap.setView([v.lat, v.lng], 13, { animate: true });
  } else {
    marker.setLatLng([v.lat, v.lng]);
    marker.setIcon(icon);
    marker.setPopupContent(buildPopup(v));
  }
}

function buildPopup(v) {
  const ts = v.timestamp ? new Date(v.timestamp).toLocaleTimeString('th-TH') : '—';
  return `<div style="min-width:160px;padding:4px;font-family:'Sarabun',sans-serif;">
    <div style="font-size:1rem;font-weight:800;color:#2563EB;margin-bottom:8px;">${REAL_VEHICLE_ID}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:.82rem;">
      <span>🚀 <b style="color:#D97706">${v.speed ?? '--'}</b> km/h</span>
      <span>🔋 <b style="color:#059669">${v.battery ?? '--'}</b>%</span>
    </div>
    <div style="margin-top:8px;font-size:.72rem;color:#94A3B8;">🧭 ${v.direction || '—'}<br/>🕐 ${ts}</div>
  </div>`;
}

// ── KPI ───────────────────────────────────────────────────────
function updateKPI(v) {
  const online = isOnline(v);
  const speed  = v?.speed  ?? null;
  const bat    = v?.battery >= 0 ? v.battery : null;

  setEl('kpi-active', online ? '1' : '0', online ? 'var(--blue)' : 'var(--slate-400)');
  setEl('kpi-speed',  speed !== null ? speed : '—');
  setEl('kpi-bat',    bat   !== null ? bat + '%' : '—');
  setEl('nc-online',  online ? '1' : '0');
  setEl('nc-speed',   speed !== null ? speed : '—');

  if (bat !== null) {
    const c = bat < 20 ? 'var(--red)' : bat < 50 ? 'var(--amber)' : 'var(--green)';
    const el = document.getElementById('kpi-bat');
    if (el) { el.style.color = c; }
    const bar = document.getElementById('kpi-bat-bar');
    if (bar) { bar.style.width = bat + '%'; bar.style.background = c; }
    updateBatteryRing(bat);
  }
}

function setEl(id, text, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (color) el.style.color = color;
}

// ── Device Health ─────────────────────────────────────────────
function updateDeviceHealth(v) {
  const list   = document.getElementById('device-list');
  const online = isOnline(v);

  if (!v) {
    list.innerHTML = `<div class="no-data"><div class="icon">📡</div>รอ GPS จาก ESP8266…</div>`;
    return;
  }

  const moving   = online && (v.speed || 0) > 2;
  const bat      = v.battery >= 0 ? v.battery : null;
  const batColor = bat === null ? '#94A3B8' : bat < 20 ? '#DC2626' : bat < 50 ? '#D97706' : '#059669';
  const status   = !online ? 'off' : moving ? 'on' : 'idle';
  const statusTx = { on: 'กำลังวิ่ง', idle: 'จอดอยู่', off: 'Offline' }[status];
  const badgeCls = { on: 'b-on', idle: 'b-idle', off: 'b-off' }[status];
  const ts       = v.timestamp ? new Date(v.timestamp).toLocaleTimeString('th-TH') : '—';
  const secsAgo  = v.timestamp ? Math.round((Date.now() - v.timestamp) / 1000) : null;
  const tsAgo    = secsAgo !== null ? (secsAgo < 60 ? secsAgo + 's' : Math.floor(secsAgo / 60) + 'm') + 'ที่แล้ว' : '—';

  const offlineBanner = !online ? `
    <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;padding:10px 12px;margin-top:10px;
      display:flex;align-items:center;gap:8px;font-size:.78rem;font-weight:700;color:#DC2626;">
      <span>📡</span>
      <div><div>ไม่ได้รับสัญญาณ</div><div style="font-weight:400;color:#B91C1C;font-size:.7rem;">อัปเดตล่าสุด ${tsAgo}</div></div>
    </div>` : '';

  list.innerHTML = `
    <div class="device-card">
      <div class="dc-head">
        <span class="dc-id">${REAL_VEHICLE_ID}</span>
        <span class="dc-badge ${badgeCls}">${statusTx}</span>
      </div>
      <div class="dc-stats">
        <div class="dcs"><div class="dcs-val" style="color:#D97706">${online ? (v.speed ?? '--') : '—'}</div><div class="dcs-lbl">km/h</div></div>
        <div class="dcs"><div class="dcs-val" style="color:${batColor}">${bat ?? '--'}%</div><div class="dcs-lbl">Battery</div></div>
        <div class="dcs"><div class="dcs-val" style="color:#475569;font-size:.72rem">${tsAgo}</div><div class="dcs-lbl">อัปเดต</div></div>
      </div>
      <div class="bat-row">
        <div class="bat-track"><div class="bat-fill" style="width:${bat ?? 0}%;background:${batColor}"></div></div>
        <span class="bat-pct" style="color:${batColor}">${bat ?? '--'}%</span>
      </div>
      <div class="dc-route">
        🗺 ${v.routeId && v.routeId !== 'unassigned' ? v.routeId : 'ไม่ระบุเส้นทาง'}
        &nbsp;·&nbsp;${v.direction === 'แยก Rama IV' ? '⬇️' : v.direction === 'Siam Square' ? '⬆️' : ''}
        ${v.direction || '—'}
      </div>
      <div style="font-size:.62rem;color:#94A3B8;margin-top:5px;">📍 ${v.lat?.toFixed(5) ?? '—'}, ${v.lng?.toFixed(5) ?? '—'}</div>
      <div style="font-size:.62rem;color:#94A3B8;margin-top:2px;">🕐 ${ts}</div>
      ${offlineBanner}
    </div>`;

  const upd = document.getElementById('device-last-update');
  if (upd) upd.textContent = `อัปเดต: ${ts}`;
}

// ════════════════════════════════════════════════════════════
//  SERIAL MONITOR
// ════════════════════════════════════════════════════════════
const MAX_SERIAL_LINES = 80;

function appendSerialLog(v, latency) {
  const log = document.getElementById('serial-log');
  if (!log) return;

  const now = new Date().toLocaleTimeString('th-TH', { hour12: false });
  const ts  = `${now}`;

  // สร้าง log lines เหมือน Arduino IDE จริงๆ
  const lines = [
    { cls: 'serial-ok',   text: `[WiFi] Connected | IP: 192.168.1.38` },
    { cls: 'serial-data', text: `[GPS] Fix OK | Sats:${v.sats || randomInt(6,12)} | HDOP:${(v.hdop || (1.0 + Math.random())).toFixed(1)}` },
    { cls: 'serial-data', text: `[LOC] lat:${v.lat?.toFixed(6)} lng:${v.lng?.toFixed(6)} | spd:${v.speed}km/h` },
    { cls: 'serial-data', text: `[BAT] ${v.battery}% | ${batToVolt(v.battery)}V | ${batToMa(v.speed)}mA` },
    { cls: v.speed > 0 ? 'serial-ok' : 'serial-warn',
      text: `[SEND] POST /api/update-location → HTTP 200 (${latency}ms)` },
    { cls: 'serial-info', text: `[DIR] ${v.direction || 'unknown'} | routeId:${v.routeId || 'unassigned'}` },
    { cls: 'serial-sep',  text: '─────────────────────────────────────────' },
  ];

  // เพิ่ม separator ก่อนกลุ่มใหม่ถ้ามีข้อมูลแล้ว
  const placeholder = log.querySelector('.serial-info');
  if (placeholder && placeholder.textContent.includes('รอการเชื่อมต่อ')) {
    log.innerHTML = '';
    // Boot messages
    addSerialLine(log, ts, 'serial-info', '=== Smart Songthaew Tracker v2 ===');
    addSerialLine(log, ts, 'serial-info', `[BOOT] vehicleId: ${REAL_VEHICLE_ID}`);
    addSerialLine(log, ts, 'serial-info', '[BOOT] Route: Siam Square ↔ แยก Rama IV (ถ.อังรีดูนัง) (20.1km)');
    addSerialLine(log, ts, 'serial-ok',   '[WiFi] Connected! IP: 192.168.1.38');
    addSerialLine(log, ts, 'serial-ok',   '[GPS] Waiting for fix...');
  }

  lines.forEach(l => addSerialLine(log, ts, l.cls, l.text));

  // trim ถ้าเกิน limit
  while (log.children.length > MAX_SERIAL_LINES) log.removeChild(log.firstChild);

  if (autoScroll) log.scrollTop = log.scrollHeight;

  // update serial dot
  const dot = document.getElementById('serial-dot');
  if (dot) { dot.classList.remove('off'); }
}

function appendSerialLogError(msg) {
  const log = document.getElementById('serial-log');
  if (!log) return;
  const ts = new Date().toLocaleTimeString('th-TH', { hour12: false });
  addSerialLine(log, ts, 'serial-err', `[ERROR] ${msg}`);
  if (autoScroll) log.scrollTop = log.scrollHeight;
  const dot = document.getElementById('serial-dot');
  if (dot) dot.classList.add('off');
}

function addSerialLine(container, ts, cls, text) {
  const div = document.createElement('div');
  div.className = 'serial-line';
  div.innerHTML = `<span class="serial-ts">${ts}</span><span class="${cls}">${escapeHtml(text)}</span>`;
  container.appendChild(div);
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function clearSerial() {
  const log = document.getElementById('serial-log');
  if (log) log.innerHTML = '';
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  const btn = document.getElementById('serial-scroll-btn');
  if (btn) {
    btn.textContent = autoScroll ? 'Auto ↓' : 'Manual';
    btn.style.color = autoScroll ? '#3FB950' : '#D29922';
  }
}

// ════════════════════════════════════════════════════════════
//  POWER DASHBOARD
// ════════════════════════════════════════════════════════════

// ESP8266 power model
function batToVolt(pct) { return (3.0 + (pct / 100) * 0.6).toFixed(2); }
function batToMa(speed) {
  // Active ~80mA + WiFi tx burst ~170mA = ~250mA peak
  return speed > 0 ? 80 + randomInt(0, 20) : 55 + randomInt(0, 10);
}
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function updateBatteryRing(pct) {
  const circ = 2 * Math.PI * 40; // r=40
  const fill  = document.getElementById('bat-ring-fill');
  const num   = document.getElementById('bat-ring-pct');
  if (!fill || !num) return;

  const offset = circ - (pct / 100) * circ;
  fill.setAttribute('stroke-dashoffset', offset.toFixed(1));

  const color = pct < 20 ? '#DC2626' : pct < 50 ? '#D97706' : '#059669';
  fill.setAttribute('stroke', color);
  num.textContent = pct;
  num.style.color = color;

  // update voltage & power stats
  setEl('pw-voltage', batToVolt(pct) + ' V');
}

function updatePowerSimulation() {
  // Simulate WiFi TX burst every send cycle
  const isTx = Math.random() > 0.5;
  const wifiBar = document.getElementById('wifi-bar');
  const wifiMa  = document.getElementById('wifi-ma');
  if (wifiBar && wifiMa) {
    if (isTx) {
      const ma = randomInt(150, 250);
      wifiBar.style.width = (ma / 300 * 100) + '%';
      wifiMa.textContent  = ma + ' mA';
    } else {
      wifiBar.style.width = '0%';
      wifiMa.textContent  = '0 mA';
    }
  }

  // Solar input varies with "time of day"
  const hour = new Date().getHours();
  const solar = hour >= 8 && hour <= 17
    ? (0.5 + Math.random() * 0.5).toFixed(2)
    : '0.00';
  const solarBar = document.getElementById('solar-bar');
  const solarMa  = document.getElementById('solar-ma');
  if (solarBar) solarBar.style.width = (parseFloat(solar) / 1.0 * 100) + '%';
  if (solarMa)  solarMa.textContent  = solar + ' W';
  setEl('pw-solar', solar + ' W');

  // Current draw
  const mA = isTx ? randomInt(200, 260) : randomInt(70, 100);
  setEl('pw-current', mA + ' mA');
  setEl('pw-watt', (mA * 3.3 / 1000).toFixed(2) + ' W');
}

// Battery history mini chart
function initBatteryChart() {
  const ctx = document.getElementById('battery-history-chart');
  if (!ctx) return;
  batChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels:   [],
      datasets: [{ data: [], borderColor: '#059669', backgroundColor: 'rgba(5,150,105,.08)',
        borderWidth: 1.5, fill: true, tension: 0.4, pointRadius: 0 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false, min: 0, max: 100 },
      },
    },
  });
}

function updateBatteryHistory(bat) {
  if (!batChart || bat == null) return;
  batHistory.push(bat);
  if (batHistory.length > 20) batHistory.shift();

  const labels = batHistory.map((_, i) => i.toString());
  batChart.data.labels             = labels;
  batChart.data.datasets[0].data  = batHistory;

  const color = bat < 20 ? '#DC2626' : bat < 50 ? '#D97706' : '#059669';
  batChart.data.datasets[0].borderColor      = color;
  batChart.data.datasets[0].backgroundColor  = color.replace(')', ',.08)').replace('rgb', 'rgba');
  batChart.update('none');
}

// ════════════════════════════════════════════════════════════
//  IoT STATS
// ════════════════════════════════════════════════════════════
function updateIoTStats(v, latency) {
  setEl('iot-pkts', pktTotal.toLocaleString());

  const rate = pktTotal > 0 ? Math.round((pktSuccess / pktTotal) * 100) : 0;
  const rateEl = document.getElementById('iot-rate');
  if (rateEl) {
    rateEl.textContent = rate + '%';
    rateEl.style.color = rate >= 95 ? 'var(--green)' : rate >= 80 ? 'var(--amber)' : 'var(--red)';
  }

  const avgLat = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;
  setEl('iot-lat', avgLat + ' ms');
  setEl('iot-http', '200');

  // Simulated RSSI (-50 to -80 dBm range)
  const rssi = -55 - randomInt(0, 25);
  setEl('iot-rssi', rssi.toString());
  updateSignalBars(rssi);

  if (v) {
    // Simulate HDOP and satellites
    const hdop = v.hdop || (1.0 + Math.random() * 1.5);
    const sats = v.sats || randomInt(6, 12);
    const hdopEl = document.getElementById('iot-hdop');
    if (hdopEl) {
      hdopEl.textContent = hdop.toFixed(1);
      hdopEl.style.color = hdop < 2 ? 'var(--green)' : hdop < 5 ? 'var(--amber)' : 'var(--red)';
    }
    setEl('iot-sats', sats.toString());
  }
}

function updateSignalBars(rssi) {
  const bars = document.querySelectorAll('#signal-bars .sig-b');
  if (!bars.length) return;
  // rssi: > -60 = 4 bars, > -70 = 3, > -80 = 2, else 1
  const level = rssi > -60 ? 4 : rssi > -70 ? 3 : rssi > -80 ? 2 : 1;
  bars.forEach((b, i) => {
    b.classList.toggle('active', i < level);
    b.style.background = i < level ? 'var(--green)' : 'var(--slate-300)';
  });
}

// ════════════════════════════════════════════════════════════
//  CHART
// ════════════════════════════════════════════════════════════
async function loadChart() {
  try {
    let labels, data, type, borderColor, bgColor, label;
    if (chartMode === 'speed') {
      const j = await fetch('/api/analytics/speed-by-hour').then(r => r.json());
      labels = j.labels || Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2,'0')}:00`);
      data   = j.data   || new Array(24).fill(0);
      type = 'line'; borderColor = '#2563EB'; bgColor = 'rgba(37,99,235,.08)';
      label = 'ความเร็วเฉลี่ย (km/h)';
      setEl('chart-sub', 'ค่าเฉลี่ยความเร็วต่อชั่วโมง (km/h)');
    } else {
      const j = await fetch('/api/analytics/peak-hours').then(r => r.json());
      labels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2,'0')}:00`);
      data   = labels.map((_, i) => j[i] || 0);
      type = 'bar';
      const avg = data.reduce((a, b) => a + b, 0) / 24;
      borderColor = data.map(v => v > avg * 1.4 ? '#2563EB' : '#CBD5E1');
      bgColor     = data.map(v => v > avg * 1.4 ? 'rgba(37,99,235,.75)' : 'rgba(203,213,225,.6)');
      label = 'GPS events';
      setEl('chart-sub', 'จำนวน GPS events ต่อชั่วโมง');
    }

    setEl('kpi-points', data.reduce((a, b) => a + b, 0).toLocaleString() || '—');

    const ctx = document.getElementById('activityChart')?.getContext('2d');
    if (!ctx) return;
    if (chartObj) chartObj.destroy();
    chartObj = new Chart(ctx, {
      type,
      data: { labels, datasets: [{ label, data, borderColor, backgroundColor: bgColor,
        borderWidth: 2, fill: chartMode === 'speed', tension: 0.4,
        borderRadius: chartMode === 'activity' ? 5 : 0,
        pointBackgroundColor: '#2563EB', pointRadius: chartMode === 'speed' ? 3 : 0 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
        plugins: { legend: { display: false }, tooltip: {
          backgroundColor: 'white', borderColor: '#E2E8F0', borderWidth: 1,
          titleColor: '#1E293B', bodyColor: '#64748B',
          titleFont: { family: "'IBM Plex Mono',monospace", size: 11 },
          bodyFont:  { family: "'IBM Plex Mono',monospace", size: 11 },
          padding: 10, cornerRadius: 9,
          callbacks: { label: i => ` ${i.raw} ${chartMode === 'speed' ? 'km/h' : 'events'}` },
        }},
        scales: {
          x: { ticks: { color: '#94A3B8', font: { family: "'IBM Plex Mono',monospace", size: 9 },
              maxRotation: 0, callback: (_, i) => i % 3 === 0 ? labels[i] : '' },
            grid: { color: '#F1F5F9' } },
          y: { beginAtZero: true, ...(chartMode === 'speed' ? { suggestedMax: 60 } : {}),
            ticks: { color: '#94A3B8', font: { family: "'IBM Plex Mono',monospace", size: 9 } },
            grid: { color: '#F1F5F9' } },
        },
      },
    });
  } catch (err) { console.error('[admin] loadChart:', err.message); }
}

function switchChart(mode) {
  chartMode = mode;
  document.getElementById('tab-speed')?.classList.toggle('active', mode === 'speed');
  document.getElementById('tab-activity')?.classList.toggle('active', mode === 'activity');
  loadChart();
}

// ════════════════════════════════════════════════════════════
//  SIMULATE
// ════════════════════════════════════════════════════════════
async function triggerSimulate() {
  try {
    await fetch('/api/simulate');
    await fetchData();
    await loadChart();
    appendSerialLogRaw('serial-info', '[SIM] Server-side GPS inject triggered');
  } catch (err) { console.error('[admin] simulate:', err.message); }
}

function appendSerialLogRaw(cls, text) {
  const log = document.getElementById('serial-log');
  if (!log) return;
  const ts = new Date().toLocaleTimeString('th-TH', { hour12: false });
  addSerialLine(log, ts, cls, text);
  if (autoScroll) log.scrollTop = log.scrollHeight;
}

// ════════════════════════════════════════════════════════════
//  DEMO MODE
// ════════════════════════════════════════════════════════════
function showDemoOverlay() {
  document.getElementById('demo-overlay').classList.add('active');
}

function startDemoMode() {
  demoMode = true;
  document.getElementById('demo-overlay').classList.remove('active');
  document.getElementById('demo-banner').classList.add('active');

  // Auto simulate every 2s (matches Arduino interval)
  demoInterval = setInterval(async () => {
    if (!demoMode) return;
    await triggerSimulate();
  }, 2000);

  appendSerialLogRaw('serial-info', '=== DEMO MODE STARTED ===');
  appendSerialLogRaw('serial-ok',   '[DEMO] Auto-simulate ทุก 2 วินาที');
  console.info('[admin] Demo mode ON');
}

function stopDemoMode() {
  demoMode = false;
  clearInterval(demoInterval);
  document.getElementById('demo-banner').classList.remove('active');
  appendSerialLogRaw('serial-warn', '[DEMO] Demo mode stopped');
  console.info('[admin] Demo mode OFF');
}

// ════════════════════════════════════════════════════════════
//  CLOCK + UPTIME
// ════════════════════════════════════════════════════════════
function startClock() {
  const tick = () => {
    const el = document.getElementById('nc-time');
    if (el) el.textContent = new Date().toLocaleTimeString('th-TH', { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}

function startUptimeCounter() {
  setInterval(() => {
    const secs  = Math.floor((Date.now() - uptimeStart) / 1000);
    const h     = Math.floor(secs / 3600);
    const m     = Math.floor((secs % 3600) / 60);
    const s     = secs % 60;
    const str   = h > 0
      ? `${h}h ${String(m).padStart(2,'0')}m`
      : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    setEl('kpi-uptime', str);
  }, 1000);
}