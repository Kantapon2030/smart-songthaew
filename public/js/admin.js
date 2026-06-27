/**
 * admin.js — Admin Control Page Frontend
 * [FIX] ไฟล์นี้เคยมีโค้ด server.js ผิด — เขียนใหม่ทั้งหมด
 * [FIX] แก้ deleteRoute() เรียกตัวเองวนซ้ำ (ชื่อชน shared.js)
 * [FIX] Route editor map invalidateSize เมื่อเปิด modal
 */
'use strict';

// ── Route Editor Variables ───────────────────────────────────────────
let routeEditorMap = null;
let routeWaypoints = [];
let routePolyline  = null;
let routeMarkers   = [];

let _demoVehicleCount = 1;
let _demoRunning      = false;

// ── Clock ────────────────────────────────────────────────────
setInterval(() => {
  const el = document.getElementById('nc-time');
  if (el) el.textContent = new Date().toLocaleTimeString('th-TH', { hour12:false });
}, 1000);

// ── On config change ─────────────────────────────────────────
function onConfigChanged(cfg) {
  applyConfigToUI(cfg);
}

function applyConfigToUI(cfg) {
  _demoRunning      = cfg.demoMode;
  _demoVehicleCount = cfg.demoVehicles ?? 2;

  document.getElementById('vcc-num').textContent          = _demoVehicleCount;
  document.getElementById('cfg-route').value              = cfg.routeName      ?? '';
  document.getElementById('cfg-timeout').value            = cfg.offlineTimeout ?? 15;
  document.getElementById('cfg-timeout-val').textContent  = cfg.offlineTimeout ?? 15;
  document.getElementById('cfg-announcement').value       = cfg.announcement   ?? '';

  const light     = document.getElementById('demo-light');
  const title     = document.getElementById('demo-state-title');
  const sub       = document.getElementById('demo-state-sub');
  const badge     = document.getElementById('nav-mode-badge');
  const statusSub = document.getElementById('demo-status-sub');
  const toggle    = document.getElementById('demo-mode-toggle');
  const modeBadge = document.getElementById('demo-mode-badge');
  if (toggle) toggle.checked = cfg.demoMode === true;

  if (cfg.demoMode) {
    light.classList.add('on');
    title.textContent     = 'Digital Twin กำลังทำงาน';
    sub.textContent       = `DEMO_1, DEMO_2, DEMO_3 วิ่งอยู่ (ความเร็ว ${cfg.demoSpeed || 1.0}x)`;
    badge.textContent     = 'DEMO';
    badge.className       = 'nav-badge';
    if (modeBadge) { modeBadge.textContent = 'DEMO ACTIVE — simulated data'; modeBadge.classList.add('active'); }
    statusSub.textContent = 'DEMO_1–3 กำลังวิ่ง';
  } else {
    light.classList.remove('on');
    title.textContent     = 'Digital Twin ปิดอยู่';
    sub.textContent       = 'ระบบแสดงข้อมูลจาก ESP8266 จริง';
    badge.textContent     = 'REAL';
    badge.className       = 'nav-badge safe';
    if (modeBadge) { modeBadge.textContent = 'LIVE — real data only'; modeBadge.classList.remove('active'); }
    statusSub.textContent = 'ปิดอยู่';
  }

  renderAnnouncement(cfg.announcement);
  refreshStatus();
}

// ── Demo Controls ─────────────────────────────────────────────
async function toggleDemoMode(enabled) {
  try {
    if (enabled) await startDemo();
    else await stopDemo();
    await refreshDemoStatus();
  } catch (error) {
    const toggle = document.getElementById('demo-mode-toggle');
    if (toggle) toggle.checked = !enabled;
    addLog('err', error.message);
  }
}

async function refreshDemoStatus() {
  const response = await fetch('/api/demo/status');
  if (!response.ok) throw new Error('Unable to read demo status');
  const status = await response.json();
  const config = { ...window.SYS, demoMode: status.demoMode === true };
  Object.assign(window.SYS, config);
  applyConfigToUI(config);
  return status;
}

function changeVehicleCount(d) {
  _demoVehicleCount = Math.max(1, Math.min(8, _demoVehicleCount + d));
  document.getElementById('vcc-num').textContent = _demoVehicleCount;
}

async function startDemo() {
  addLog('info', 'เริ่ม Demo Fleet (DEMO_1–3)...');
  try {
    const response = await authFetch('/api/demo/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicles: 3 }),
    });
    const r = response ? await response.json() : {};
    addLog('ok', `Demo started: ${r.ids?.join(', ')}`);
    await syncConfig();
    return r;
  } catch (e) { addLog('err', e.message); throw e; }
}

async function stopDemo() {
  addLog('warn', 'หยุด Demo Fleet...');
  try {
    await authFetch('/api/demo/stop', { method: 'POST' });
    addLog('ok', 'Demo stopped — กลับเป็นโหมด Real');
    await syncConfig();
  } catch (e) { addLog('err', e.message); throw e; }
}

async function changeDemoSpeed(speed) {
  try {
    const response = await authFetch('/api/demo/speed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speed: parseFloat(speed) }),
    });
    const r = response ? await response.json() : {};
    if (r.ok) {
      addLog('info', `ปรับความเร็วรถจำลองเป็น ${speed}x`);
    } else {
      addLog('err', `ล้มเหลว: ${r.error}`);
    }
  } catch (e) { addLog('err', e.message); }
}

// ── Save Config ───────────────────────────────────────────────
async function saveConfig() {
  const cfg = {
    routeName:      document.getElementById('cfg-route').value.trim(),
    offlineTimeout: parseInt(document.getElementById('cfg-timeout').value),
    announcement:   document.getElementById('cfg-announcement').value.trim(),
  };
  try {
    await authFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    addLog('ok', `บันทึกค่า: ${JSON.stringify(cfg)}`);
    showToast();
    syncConfig();
  } catch (e) { addLog('err', e.message); }
}

// ── Status ────────────────────────────────────────────────────
async function refreshStatus() {
  const row = document.getElementById('status-row');
  try {
    const [loc, demo] = await Promise.all([
      fetchV1FleetForLegacyViews(),
      fetch('/api/demo/status').then(r => r.json()),
    ]);

    const pills = [];
    const realEntry  = loc[REAL_VEHICLE_ID]?.current;
    const realOnline = isVehicleOnline(realEntry);

    pills.push(realOnline
      ? `<span class="status-pill pill-online"><span class="pill-dot"></span>ESP8266 Online — ${realEntry?.speed ?? '?'} km/h</span>`
      : `<span class="status-pill pill-offline"><span class="pill-dot"></span>ESP8266 Offline</span>`
    );

    if (demo.running) {
      pills.push(`<span class="status-pill pill-demo"><span class="pill-dot"></span>Demo Fleet: ${demo.ids?.join(', ') || 'DEMO_1–3'}</span>`);
    }

    for (const id of (demo.ids || [])) {
      const v = loc[id]?.current;
      if (v) pills.push(`<span class="status-pill" style="background:#F5F3FF;color:#7C3AED;border:1px solid #DDD6FE;">
        <span class="pill-dot"></span>${id} ${v.speed}km/h</span>`);
    }

    row.innerHTML = pills.join('') || `<span class="status-pill pill-offline"><span class="pill-dot"></span>ไม่มีข้อมูล</span>`;
  } catch (e) {
    row.innerHTML = `<span class="status-pill pill-offline"><span class="pill-dot"></span>ไม่สามารถเชื่อมต่อ server</span>`;
  }
}

setInterval(refreshStatus, 5000);

// ── Action Log ────────────────────────────────────────────────
function addLog(type, text) {
  const log = document.getElementById('action-log');
  const ts  = new Date().toLocaleTimeString('th-TH', { hour12:false });
  const cls = type === 'ok' ? 'log-ok' : type === 'warn' ? 'log-warn' : type === 'err' ? 'log-err' : '';
  const div = document.createElement('div');
  div.className = 'log-line';
  div.innerHTML = `<span class="log-ts">${ts}</span><span class="${cls}">${text}</span>`;
  log.appendChild(div);
  while (log.children.length > 50) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg = '✓ บันทึกแล้ว') {
  const t = document.getElementById('save-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

// ── Auth ─────────────────────────────────────────────────────
async function checkAuth() {
  const isAuthed = await requireAuth();
  if (!isAuthed) return;

  if (typeof renderSharedNavbar === 'function') {
    renderSharedNavbar({ active: 'admin' });
  }

  const username = localStorage.getItem('adminUsername') || 'Admin';
  const el = document.getElementById('user-info');
  if (el) el.textContent = `👤 ${username}`;

  loadRoutes();
  loadFleet();
  refreshStatus();
  refreshDemoStatus().catch(e => addLog('err', e.message));
}

function logout() {
  clearAuth();
  window.location.href = '/login.html';
}

// ── Route Management ─────────────────────────────────────────
// [FIX] เปลี่ยนชื่อ function ให้ไม่ชนกับ deleteRoute() ใน shared.js
async function loadRoutes() {
  try {
    const routes    = await fetchRoutes();
    const container = document.getElementById('routes-list');

    if (!routes || Object.keys(routes).length === 0) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--slate-400);">ไม่มีเส้นทาง — กดปุ่ม "+ สร้างเส้นทางใหม่" เพื่อเพิ่ม</div>';
      return;
    }

    container.innerHTML = Object.entries(routes).map(([id, route]) => `
      <div style="background:var(--slate-50);border:1px solid var(--slate-200);border-radius:12px;padding:15px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div style="font-weight:700;color:var(--slate-700);">${route.name || '(ไม่มีชื่อ)'}</div>
            <div style="font-size:.75rem;color:var(--slate-400);">${route.vehicleCount || 0} คัน | ${route.coords?.length || 0} จุด</div>
          </div>
          <div style="display:flex;gap:8px;">
            <button onclick="showRouteOnMap('${id}')" class="btn btn-outline" style="padding:4px 12px;font-size:.7rem;">👁️ ดู</button>
            <button onclick="confirmDeleteRoute('${id}','${(route.name||'').replace(/'/g,'')}')" class="btn btn-danger" style="padding:4px 12px;font-size:.7rem;">🗑️ ลบ</button>
          </div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    addLog('err', 'Failed to load routes: ' + e.message);
  }
}

// [FIX] ชื่อใหม่เพื่อไม่ชน shared.js deleteRoute()
async function confirmDeleteRoute(routeId, routeName) {
  if (!confirm(`ยืนยันลบเส้นทาง "${routeName}"?\nรถทั้งหมดในเส้นทางนี้จะถูกนำออก`)) return;

  try {
    addLog('warn', `กำลังลบเส้นทาง ${routeId}...`);
    // ใช้ deleteRoute จาก shared.js
    const res = await deleteRoute(routeId);
    if (res && res.ok) {
      addLog('ok', `ลบเส้นทาง "${routeName}" สำเร็จ`);
      showToast('🗑️ ลบเส้นทางแล้ว');
      loadRoutes();
    } else {
      const body = res ? await res.json().catch(() => ({})) : {};
      addLog('err', 'ลบเส้นทางไม่สำเร็จ: ' + (body.error || 'unknown'));
    }
  } catch (e) {
    addLog('err', 'ลบเส้นทางไม่สำเร็จ: ' + e.message);
  }
}

// ── Show Route on map (quick preview via alert with coords) ──
function showRouteDetail(routeId) {
  alert('รายละเอียดเส้นทาง: ' + routeId);
}

let _previewMap  = null;
let _previewLine = null;

function showRouteOnMap(routeId) {
  fetchRoutes().then(routes => {
    const route = routes[routeId];
    if (!route || !route.coords?.length) {
      alert('ไม่มีข้อมูลพิกัดเส้นทาง');
      return;
    }

    // เปิด modal route-editor-modal แบบ read-only
    const modal = document.getElementById('route-editor-modal');
    modal.style.display = 'flex';

    // แสดงหัว modal
    const modalTitle = modal.querySelector('div[style*="font-size:1rem"]');
    if (modalTitle) modalTitle.textContent = `🗺️ เส้นทาง: ${route.name}`;

    initRouteEditorMap();

    // Clear existing
    clearWaypoints();

    // Plot route
    route.coords.forEach(coord => {
      const latlng = { lat: coord[0], lng: coord[1] };
      addWaypoint(latlng, /*readOnly=*/true);
    });

    // Fit bounds
    if (routePolyline) {
      routeEditorMap.fitBounds(routePolyline.getBounds().pad(0.1));
    }
  });
}

// ── Route Editor Functions ───────────────────────────────────────────
function openRouteEditor() {
  const modal = document.getElementById('route-editor-modal');
  modal.style.display = 'flex';

  // ตั้ง title modal กลับเป็น "สร้างเส้นทางใหม่"
  const modalTitle = modal.querySelector('div[style*="font-size:1rem"]');
  if (modalTitle) modalTitle.textContent = '🗺️ สร้างเส้นทางใหม่';

  initRouteEditorMap();
  clearWaypoints();

  document.getElementById('route-name-input').value = '';
  document.getElementById('route-desc-input').value = '';
}

function initRouteEditorMap() {
  if (!routeEditorMap) {
    routeEditorMap = L.map('route-editor-map').setView([8.445000, 99.965000], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19
    }).addTo(routeEditorMap);

    routeEditorMap.on('click', function(e) {
      addWaypoint(e.latlng);
    });
  }

  // [FIX] invalidateSize ทุกครั้งที่เปิด modal เพื่อแก้ map แสดงไม่เต็ม
  setTimeout(() => routeEditorMap.invalidateSize(), 100);
}

function closeRouteEditor() {
  const modal = document.getElementById('route-editor-modal');
  modal.style.display = 'none';
  clearWaypoints();
}

function clearWaypoints() {
  routeWaypoints = [];

  if (routeEditorMap) {
    routeMarkers.forEach(m => routeEditorMap.removeLayer(m));
    if (routePolyline) {
      routeEditorMap.removeLayer(routePolyline);
      routePolyline = null;
    }
  }
  routeMarkers = [];
  updateRouteEditorUI();
}

// [FIX] เพิ่ม param readOnly เพื่อรองรับโหมดดู
function addWaypoint(latlng, readOnly = false) {
  const idx = routeWaypoints.length;
  routeWaypoints.push([latlng.lat, latlng.lng]);

  const marker = L.marker(latlng, {
    draggable: !readOnly,
    title: `จุดที่ ${idx + 1}`
  }).addTo(routeEditorMap);

  // Numbered icon
  marker.setIcon(L.divIcon({
    className: '',
    html: `<div style="width:24px;height:24px;border-radius:50%;background:#2563EB;color:white;
      display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;
      border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.3);">${idx + 1}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  }));

  if (!readOnly) {
    marker.on('dragend', function(e) {
      const newPos = e.target.getLatLng();
      const i = routeMarkers.indexOf(marker);
      if (i !== -1) routeWaypoints[i] = [newPos.lat, newPos.lng];
      updatePolyline();
      updateRouteEditorUI();
    });

    // Right-click to remove waypoint
    marker.on('contextmenu', function() {
      const i = routeMarkers.indexOf(marker);
      if (i !== -1) {
        routeWaypoints.splice(i, 1);
        routeEditorMap.removeLayer(marker);
        routeMarkers.splice(i, 1);
        // Renumber remaining markers
        routeMarkers.forEach((m, j) => {
          m.setIcon(L.divIcon({
            className: '',
            html: `<div style="width:24px;height:24px;border-radius:50%;background:#2563EB;color:white;
              display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;
              border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.3);">${j + 1}</div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
          }));
        });
        updatePolyline();
        updateRouteEditorUI();
      }
    });
  }

  routeMarkers.push(marker);
  updatePolyline();
  updateRouteEditorUI();
}

function updatePolyline() {
  if (routePolyline && routeEditorMap) {
    routeEditorMap.removeLayer(routePolyline);
    routePolyline = null;
  }

  if (routeWaypoints.length > 1) {
    routePolyline = L.polyline(routeWaypoints, {
      color: '#2563EB',
      weight: 4,
      opacity: 0.75
    }).addTo(routeEditorMap);
  }
}

function updateRouteEditorUI() {
  const wc = document.getElementById('waypoint-count');
  const rd = document.getElementById('route-distance');
  if (wc) wc.textContent = routeWaypoints.length;

  let totalDist = 0;
  for (let i = 1; i < routeWaypoints.length; i++) {
    totalDist += haversineKm(
      routeWaypoints[i-1][0], routeWaypoints[i-1][1],
      routeWaypoints[i][0],   routeWaypoints[i][1]
    );
  }
  if (rd) rd.textContent = totalDist.toFixed(2);
}

async function saveRoute() {
  const name        = document.getElementById('route-name-input').value.trim();
  const description = document.getElementById('route-desc-input').value.trim();

  if (!name) {
    alert('กรุณาระบุชื่อเส้นทาง');
    return;
  }

  if (routeWaypoints.length < 2) {
    alert('กรุณาเลือกจุดอย่างน้อย 2 จุด (คลิกบนแผนที่)');
    return;
  }

  const routeData = {
    name,
    description,
    coords: routeWaypoints,
    stops:  routeWaypoints.map((coord, i) => ({
      name: `จุดที่ ${i + 1}`,
      lat:  coord[0],
      lng:  coord[1]
    }))
  };

  try {
    // ใช้ createRoute จาก shared.js
    const res = await createRoute(routeData);
    if (res && res.ok) {
      addLog('ok', `สร้างเส้นทาง "${name}" สำเร็จ (${routeWaypoints.length} จุด)`);
      showToast('✓ บันทึกเส้นทางแล้ว');
      closeRouteEditor();
      loadRoutes();
    } else {
      const body = res ? await res.json().catch(() => ({})) : {};
      addLog('err', 'สร้างเส้นทางไม่สำเร็จ: ' + (body.error || 'ตรวจสอบ Auth'));
    }
  } catch (e) {
    addLog('err', 'สร้างเส้นทางไม่สำเร็จ: ' + e.message);
  }
}

// ── Clean up ghost vehicles from Firebase ───────────────────
async function purgeGhostVehicles() {
  if (!confirm('ลบรถทั้งหมดที่มีพิกัดผิดพลาดหรือ OFFLINE นานเกิน 1 ชั่วโมง?')) return;
  addLog('warn', 'กำลังล้างข้อมูลรถผี...');
  try {
    const res  = await authFetch('/api/admin/purge-ghosts', { method: 'POST' });
    if (!res) return;
    const body = await res.json();
    if (body.ok) {
      addLog('ok', `ล้างแล้ว ${body.removed} คัน: ${(body.ids || []).join(', ') || '-'}`);
      showToast(`🗑️ ล้างข้อมูลผี ${body.removed} คัน`);
      loadFleet();
      refreshStatus();
    } else {
      addLog('err', body.error || 'ล้างไม่สำเร็จ');
    }
  } catch (e) { addLog('err', e.message); }
}

// ── Delete ALL routes ─────────────────────────────────────────
async function deleteAllRoutes() {
  if (!confirm('⚠️ ลบเส้นทางทั้งหมด?\nรถทุกคันจะถูกยกเลิกการกำหนดเส้นทาง')) return;
  try {
    const res  = await authFetch('/api/admin/all-routes', { method: 'DELETE' });
    if (!res) return;
    const body = await res.json();
    if (body.ok) {
      addLog('ok', 'ลบเส้นทางทั้งหมดสำเร็จ');
      showToast('🗑️ ลบทุกเส้นทางแล้ว');
      loadRoutes();
      loadFleet();
    } else {
      addLog('err', body.error || 'ลบไม่สำเร็จ');
    }
  } catch (e) { addLog('err', e.message); }
}

// ── Edit route name/desc ──────────────────────────────────────
async function editRouteName(routeId, currentName) {
  const name = prompt('ชื่อเส้นทางใหม่:', currentName);
  if (!name || name === currentName) return;
  try {
    const res  = await authFetch(`/api/routes/${routeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res) return;
    const body = await res.json();
    if (body.ok) { addLog('ok', `แก้ชื่อเส้นทางเป็น "${name}" สำเร็จ`); loadRoutes(); }
    else addLog('err', body.error || 'แก้ไขไม่สำเร็จ');
  } catch (e) { addLog('err', e.message); }
}

// ── loadRoutes (override — แสดง vehicle count + edit/delete) ─
async function loadRoutes() {
  try {
    const routes    = await fetchRoutes();
    const container = document.getElementById('routes-list');
    if (!routes || Object.keys(routes).length === 0) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--slate-400);">ไม่มีเส้นทาง — กด "+ สร้างเส้นทางใหม่"</div>';
      return;
    }
    container.innerHTML = Object.entries(routes).map(([id, route]) => `
      <div style="background:var(--slate-50);border:1px solid var(--slate-200);border-radius:12px;padding:15px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <div>
            <div style="font-weight:700;color:var(--slate-700);">${route.name || '(ไม่มีชื่อ)'}</div>
            <div style="font-size:.72rem;color:var(--slate-400);">
              ID: <code>${id}</code> · ${route.vehicleCount || 0} คัน · ${route.coords?.length || 0} จุด
              ${route.description ? ' · ' + route.description : ''}
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button onclick="showRouteOnMap('${id}')" class="btn btn-outline" style="padding:4px 12px;font-size:.7rem;">👁 ดู</button>
            <button onclick="editRouteName('${id}','${(route.name||'').replace(/'/g,"\\'")}')" class="btn btn-outline" style="padding:4px 12px;font-size:.7rem;">✏️ แก้ไข</button>
            <button onclick="confirmDeleteRoute('${id}','${(route.name||'').replace(/'/g,"\\'")}')" class="btn btn-danger" style="padding:4px 12px;font-size:.7rem;">🗑️ ลบ</button>
          </div>
        </div>
      </div>
    `).join('');
  } catch (e) { addLog('err', 'โหลดเส้นทางไม่สำเร็จ: ' + e.message); }
}

// ── Fleet Management ──────────────────────────────────────────
// Full Firebase route editor (new schema)
let adminRouteEditingId = null;
let adminRouteModel = null;
let adminRouteMaps = {};
let adminRouteLayers = {};
let adminRouteDragged = null;
let adminRouteClickMode = { outbound: 'waypoint', inbound: 'waypoint' };

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function jsEscape(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
}

function emptyAdminDirection(dir) {
  return { label: dir === 'inbound' ? 'ขากลับ' : 'ขาไป', coords: [], stops: [] };
}

function emptyAdminRoute() {
  return {
    name: '',
    shortName: '',
    color: '#2563EB',
    active: true,
    directions: {
      outbound: { ...emptyAdminDirection('outbound') },
      inbound: { ...emptyAdminDirection('inbound') },
    },
  };
}

function normalizeAdminRoute(route = {}, id = '') {
  const normalized = normalizeRouteRecord(route, id);
  return {
    id: normalized.id || normalized.route_id || id,
    name: normalized.name || '',
    shortName: normalized.shortName || '',
    color: normalized.color || '#2563EB',
    active: normalized.active !== false,
    directions: {
      outbound: {
        label: normalized.directions?.outbound?.label || 'ขาไป',
        coords: directionCoords(normalized, 'outbound'),
        stops: directionStopsForRoute(normalized, 'outbound'),
      },
      inbound: {
        label: normalized.directions?.inbound?.label || 'ขากลับ',
        coords: directionCoords(normalized, 'inbound'),
        stops: directionStopsForRoute(normalized, 'inbound'),
      },
    },
  };
}

function routeDirectionEditorHtml(dir, title) {
  const reverseButton = dir === 'inbound'
    ? '<button class="btn btn-outline" type="button" onclick="reverseOutboundToInbound()">กลับทิศทาง</button>'
    : '';
  return `
    <section class="route-tab-panel" id="route-tab-${dir}">
      <label class="admin-label">${title} label</label>
      <input id="route-${dir}-label" class="admin-input" type="text" placeholder="${title}">
      <div class="route-editor-toolbar">
        <button class="btn btn-outline" type="button" onclick="setRouteMapMode('${dir}','waypoint')">วาดเส้นทาง</button>
        <button class="btn btn-outline" type="button" onclick="setRouteMapMode('${dir}','stop')">เพิ่มจุดจอดบนแผนที่</button>
        <button class="btn btn-outline" type="button" onclick="importRouteCoords('${dir}')">นำเข้าพิกัด</button>
        ${reverseButton}
      </div>
      <div id="route-${dir}-map" class="route-dir-map"></div>
      <div class="route-editor-grid">
        <div>
          <h4>Waypoints</h4>
          <div id="route-${dir}-waypoints" class="route-editor-list"></div>
        </div>
        <div>
          <h4>Stops</h4>
          <div class="route-stop-inline">
            <input id="route-${dir}-stop-name" class="admin-input" type="text" placeholder="ชื่อจุดจอด">
            <input id="route-${dir}-stop-lat" class="admin-input" type="number" step="0.000001" placeholder="lat">
            <input id="route-${dir}-stop-lng" class="admin-input" type="number" step="0.000001" placeholder="lng">
            <button class="btn btn-outline" type="button" onclick="addStopFromInputs('${dir}')">เพิ่ม</button>
          </div>
          <div id="route-${dir}-stops" class="route-editor-list"></div>
        </div>
      </div>
    </section>`;
}

function ensureRouteEditorShell() {
  const modal = document.getElementById('route-editor-modal');
  if (!modal) return;
  const body = modal.querySelector('.admin-modal-body');
  const foot = modal.querySelector('.admin-modal-foot');
  if (body?.dataset.fullRouteEditor === 'true') return;
  body.dataset.fullRouteEditor = 'true';
  body.innerHTML = `
    <input type="hidden" id="route-id-input">
    <div class="route-editor-tabs" role="tablist">
      <button class="route-editor-tab active" type="button" data-tab="general" onclick="switchRouteEditorTab('general')">ข้อมูลทั่วไป</button>
      <button class="route-editor-tab" type="button" data-tab="outbound" onclick="switchRouteEditorTab('outbound')">ขาไป</button>
      <button class="route-editor-tab" type="button" data-tab="inbound" onclick="switchRouteEditorTab('inbound')">ขากลับ</button>
    </div>
    <section class="route-tab-panel active" id="route-tab-general">
      <label class="admin-label">ชื่อเส้นทาง</label>
      <input id="route-name-input" class="admin-input" type="text" placeholder="นครศรีธรรมราช → พรหมคีรี">
      <label class="admin-label">ชื่อย่อ</label>
      <input id="route-short-name-input" class="admin-input" maxlength="10" type="text" placeholder="นคร-พรหม">
      <label class="admin-label">สี</label>
      <input id="route-color-input" class="admin-input" type="color" value="#2563EB" onchange="renderAllRouteDirections()">
      <label class="admin-label" style="display:flex;gap:10px;align-items:center;margin-top:12px;">
        <input id="route-active-input" type="checkbox" checked> เปิดให้บริการ / ปิด
      </label>
    </section>
    ${routeDirectionEditorHtml('outbound', 'ขาไป')}
    ${routeDirectionEditorHtml('inbound', 'ขากลับ')}
  `;
  if (foot) {
    foot.innerHTML = `
      <button class="btn btn-outline" type="button" onclick="closeRouteEditor()">ยกเลิก</button>
      <button class="btn btn-primary" type="button" onclick="saveRoute()">บันทึกลง Firebase</button>
    `;
  }
}

async function loadRoutes() {
  try {
    const routes = await fetchRoutes();
    const container = document.getElementById('routes-list');
    if (!container) return;
    const entries = Object.entries(routes || {}).map(([id, route]) => [id, normalizeAdminRoute(route, id)]);
    if (!entries.length) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--slate-400);">ยังไม่มีเส้นทาง — กด “+ สร้างเส้นทางใหม่” เพื่อเพิ่ม</div>';
      return;
    }
    container.innerHTML = entries.map(([id, route]) => {
      const stopCount = route.directions.outbound.stops.length + route.directions.inbound.stops.length;
      return `
        <div class="route-list-card">
          <div class="route-list-main">
            <span class="route-color-dot" style="background:${htmlEscape(route.color)}"></span>
            <div>
              <div class="route-list-name">${htmlEscape(route.name || '(ไม่มีชื่อ)')}</div>
              <div class="route-list-meta">ID: <code>${htmlEscape(id)}</code> · ${stopCount} จุดจอด · ${routes[id]?.vehicleCount || 0} คัน</div>
            </div>
          </div>
          <span class="route-status-badge ${route.active ? 'active' : 'inactive'}">${route.active ? 'active' : 'inactive'}</span>
          <div class="route-list-actions">
            <button onclick="openRouteEditor('${jsEscape(id)}')" class="btn btn-outline" type="button">Edit</button>
            <button onclick="toggleRouteActive('${jsEscape(id)}', ${route.active ? 'false' : 'true'})" class="btn btn-outline" type="button">${route.active ? 'ปิด' : 'เปิด'}</button>
            <button onclick="confirmDeleteRoute('${jsEscape(id)}','${jsEscape(route.name)}')" class="btn btn-danger" type="button">Delete</button>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    addLog('err', 'โหลดเส้นทางไม่สำเร็จ: ' + e.message);
  }
}

async function openRouteEditor(routeId = null) {
  ensureRouteEditorShell();
  adminRouteEditingId = routeId;
  const modal = document.getElementById('route-editor-modal');
  modal.style.display = 'flex';
  document.getElementById('route-editor-title').textContent = routeId ? '🗺️ แก้ไขเส้นทาง' : '🗺️ สร้างเส้นทางใหม่';
  if (routeId) {
    const response = await fetch(`/api/routes/${encodeURIComponent(routeId)}`);
    if (!response.ok) throw new Error('Route not found');
    adminRouteModel = normalizeAdminRoute(await response.json(), routeId);
  } else {
    adminRouteModel = emptyAdminRoute();
  }
  fillRouteEditorForm();
  switchRouteEditorTab('general');
  setTimeout(() => {
    initRouteDirectionMap('outbound');
    initRouteDirectionMap('inbound');
    renderAllRouteDirections();
  }, 80);
}

function closeRouteEditor() {
  const modal = document.getElementById('route-editor-modal');
  if (modal) modal.style.display = 'none';
}

function fillRouteEditorForm() {
  document.getElementById('route-id-input').value = adminRouteEditingId || '';
  document.getElementById('route-name-input').value = adminRouteModel.name || '';
  document.getElementById('route-short-name-input').value = adminRouteModel.shortName || '';
  document.getElementById('route-color-input').value = adminRouteModel.color || '#2563EB';
  document.getElementById('route-active-input').checked = adminRouteModel.active !== false;
  for (const dir of ['outbound', 'inbound']) {
    document.getElementById(`route-${dir}-label`).value = adminRouteModel.directions[dir].label || '';
  }
}

function syncRouteEditorForm() {
  adminRouteModel.name = document.getElementById('route-name-input').value.trim();
  adminRouteModel.shortName = document.getElementById('route-short-name-input').value.trim().slice(0, 10);
  adminRouteModel.color = document.getElementById('route-color-input').value || '#2563EB';
  adminRouteModel.active = document.getElementById('route-active-input').checked;
  for (const dir of ['outbound', 'inbound']) {
    adminRouteModel.directions[dir].label = document.getElementById(`route-${dir}-label`).value.trim() || (dir === 'inbound' ? 'ขากลับ' : 'ขาไป');
  }
}

function switchRouteEditorTab(tab) {
  document.querySelectorAll('.route-editor-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  document.querySelectorAll('.route-tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `route-tab-${tab}`));
  if (tab === 'outbound' || tab === 'inbound') {
    setTimeout(() => {
      initRouteDirectionMap(tab);
      adminRouteMaps[tab]?.invalidateSize();
      renderRouteDirection(tab);
    }, 60);
  }
}

function initRouteDirectionMap(dir) {
  const el = document.getElementById(`route-${dir}-map`);
  if (!el || adminRouteMaps[dir]) return;
  const map = L.map(el).setView([8.445, 99.965], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  map.on('click', event => {
    if (!adminRouteModel) return;
    if (adminRouteClickMode[dir] === 'stop') {
      adminRouteModel.directions[dir].stops.push({
        id: `${dir}_stop_${adminRouteModel.directions[dir].stops.length + 1}`,
        name: `จุดจอด ${adminRouteModel.directions[dir].stops.length + 1}`,
        lat: event.latlng.lat,
        lng: event.latlng.lng,
      });
    } else {
      adminRouteModel.directions[dir].coords.push({ lat: event.latlng.lat, lng: event.latlng.lng });
    }
    renderRouteDirection(dir);
  });
  adminRouteMaps[dir] = map;
  adminRouteLayers[dir] = { waypointMarkers: [], stopMarkers: [], polyline: null };
}

function setRouteMapMode(dir, mode) {
  adminRouteClickMode[dir] = mode;
  showToast(mode === 'stop' ? 'คลิกแผนที่เพื่อเพิ่มจุดจอด' : 'คลิกแผนที่เพื่อวาด waypoint');
}

function renderAllRouteDirections() {
  ['outbound', 'inbound'].forEach(renderRouteDirection);
}

function renderRouteDirection(dir) {
  if (!adminRouteModel || !adminRouteMaps[dir]) return;
  const map = adminRouteMaps[dir];
  const layers = adminRouteLayers[dir];
  layers.waypointMarkers.forEach(marker => marker.remove());
  layers.stopMarkers.forEach(marker => marker.remove());
  if (layers.polyline) layers.polyline.remove();
  layers.waypointMarkers = [];
  layers.stopMarkers = [];
  const direction = adminRouteModel.directions[dir];
  const color = document.getElementById('route-color-input')?.value || adminRouteModel.color || '#2563EB';
  const latlngs = direction.coords.map(p => [Number(p.lat), Number(p.lng)]);
  if (latlngs.length) {
    layers.polyline = L.polyline(latlngs, { color, weight: 5, opacity: 0.85 }).addTo(map);
    map.fitBounds(layers.polyline.getBounds().pad(0.18));
  }
  direction.coords.forEach((point, index) => {
    const marker = L.marker([point.lat, point.lng], { draggable: true }).addTo(map);
    marker.bindTooltip(String(index + 1), { permanent: true, direction: 'top' });
    marker.on('dragend', e => {
      const latlng = e.target.getLatLng();
      direction.coords[index] = { lat: latlng.lat, lng: latlng.lng };
      renderRouteDirection(dir);
    });
    marker.on('contextmenu', () => removeWaypoint(dir, index));
    layers.waypointMarkers.push(marker);
  });
  direction.stops.forEach((stop, index) => {
    const marker = L.marker([stop.lat, stop.lng], { draggable: true, title: stop.name }).addTo(map);
    marker.bindPopup(stop.name || `Stop ${index + 1}`);
    marker.on('dragend', e => {
      const latlng = e.target.getLatLng();
      direction.stops[index].lat = latlng.lat;
      direction.stops[index].lng = latlng.lng;
      renderRouteDirection(dir);
    });
    layers.stopMarkers.push(marker);
  });
  renderRouteLists(dir);
}

function renderRouteLists(dir) {
  const direction = adminRouteModel.directions[dir];
  document.getElementById(`route-${dir}-waypoints`).innerHTML = direction.coords.map((point, index) => `
    <div class="route-editor-row" draggable="true" ondragstart="dragRouteItem('coords','${dir}',${index})" ondragover="event.preventDefault()" ondrop="dropRouteItem('coords','${dir}',${index})">
      <span>#${index + 1} ${Number(point.lat).toFixed(6)}, ${Number(point.lng).toFixed(6)}</span>
      <span>
        <button type="button" onclick="moveWaypoint('${dir}',${index},-1)">↑</button>
        <button type="button" onclick="moveWaypoint('${dir}',${index},1)">↓</button>
        <button type="button" onclick="removeWaypoint('${dir}',${index})">ลบ</button>
      </span>
    </div>`).join('') || '<div class="route-editor-empty">ยังไม่มี waypoint</div>';
  document.getElementById(`route-${dir}-stops`).innerHTML = direction.stops.map((stop, index) => `
    <div class="route-editor-row stop-row" draggable="true" ondragstart="dragRouteItem('stops','${dir}',${index})" ondragover="event.preventDefault()" ondrop="dropRouteItem('stops','${dir}',${index})">
      <input class="admin-input" value="${htmlEscape(stop.name)}" onchange="updateStopName('${dir}',${index},this.value)">
      <small>${Number(stop.lat).toFixed(6)}, ${Number(stop.lng).toFixed(6)}</small>
      <span>
        <button type="button" onclick="moveStop('${dir}',${index},-1)">↑</button>
        <button type="button" onclick="moveStop('${dir}',${index},1)">↓</button>
        <button type="button" onclick="removeStop('${dir}',${index})">ลบ</button>
      </span>
    </div>`).join('') || '<div class="route-editor-empty">ยังไม่มีจุดจอด</div>';
}

function moveItem(list, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  const [item] = list.splice(index, 1);
  list.splice(target, 0, item);
}

function dragRouteItem(type, dir, index) {
  adminRouteDragged = { type, dir, index };
}

function dropRouteItem(type, dir, index) {
  if (!adminRouteDragged || adminRouteDragged.type !== type || adminRouteDragged.dir !== dir) return;
  const list = adminRouteModel.directions[dir][type];
  const [item] = list.splice(adminRouteDragged.index, 1);
  list.splice(index, 0, item);
  adminRouteDragged = null;
  renderRouteDirection(dir);
}

function moveWaypoint(dir, index, delta) { moveItem(adminRouteModel.directions[dir].coords, index, delta); renderRouteDirection(dir); }
function removeWaypoint(dir, index) { adminRouteModel.directions[dir].coords.splice(index, 1); renderRouteDirection(dir); }
function moveStop(dir, index, delta) { moveItem(adminRouteModel.directions[dir].stops, index, delta); renderRouteDirection(dir); }
function removeStop(dir, index) { adminRouteModel.directions[dir].stops.splice(index, 1); renderRouteDirection(dir); }
function updateStopName(dir, index, value) { adminRouteModel.directions[dir].stops[index].name = value.trim() || `จุดจอด ${index + 1}`; renderRouteDirection(dir); }

function addStopFromInputs(dir) {
  const nameEl = document.getElementById(`route-${dir}-stop-name`);
  const latEl = document.getElementById(`route-${dir}-stop-lat`);
  const lngEl = document.getElementById(`route-${dir}-stop-lng`);
  const lat = Number(latEl.value);
  const lng = Number(lngEl.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return alert('กรุณากรอก lat/lng ให้ถูกต้อง');
  adminRouteModel.directions[dir].stops.push({
    id: `${dir}_stop_${adminRouteModel.directions[dir].stops.length + 1}`,
    name: nameEl.value.trim() || `จุดจอด ${adminRouteModel.directions[dir].stops.length + 1}`,
    lat,
    lng,
  });
  nameEl.value = ''; latEl.value = ''; lngEl.value = '';
  renderRouteDirection(dir);
}

function importRouteCoords(dir) {
  const raw = prompt('วาง JSON array ของพิกัด เช่น [{"lat":8.43,"lng":99.96}] หรือ [[8.43,99.96]]');
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    const coords = (Array.isArray(parsed) ? parsed : []).map(point => {
      const lat = Array.isArray(point) ? Number(point[0]) : Number(point.lat);
      const lng = Array.isArray(point) ? Number(point[1]) : Number(point.lng);
      return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }).filter(Boolean);
    adminRouteModel.directions[dir].coords = coords;
    renderRouteDirection(dir);
  } catch (e) {
    alert('JSON ไม่ถูกต้อง: ' + e.message);
  }
}

function reverseOutboundToInbound() {
  adminRouteModel.directions.inbound.coords = [...adminRouteModel.directions.outbound.coords].reverse().map(point => ({ ...point }));
  adminRouteModel.directions.inbound.stops = [...adminRouteModel.directions.outbound.stops].reverse().map((stop, index) => ({ ...stop, id: stop.id || `inbound_stop_${index + 1}` }));
  renderRouteDirection('inbound');
}

async function toggleRouteActive(routeId, active) {
  const res = await updateRoute(routeId, { active });
  if (!res) return;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return alert(body.error || 'อัปเดตสถานะไม่สำเร็จ');
  }
  await loadRoutes();
}

async function confirmDeleteRoute(routeId, routeName = '') {
  if (!confirm(`ยืนยันลบเส้นทาง "${routeName || routeId}"?\nรถทั้งหมดในเส้นทางนี้จะถูก unassign`)) return;
  const res = await deleteRoute(routeId);
  if (!res) return;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return alert(body.error || 'ลบเส้นทางไม่สำเร็จ');
  }
  showToast('ลบเส้นทางแล้ว');
  await loadRoutes();
  await loadFleet();
}

function showRouteOnMap(routeId) {
  openRouteEditor(routeId);
}

async function saveRoute() {
  syncRouteEditorForm();
  if (!adminRouteModel.name) return alert('กรุณากรอกชื่อเส้นทาง');
  const payload = {
    name: adminRouteModel.name,
    shortName: adminRouteModel.shortName,
    color: adminRouteModel.color,
    active: adminRouteModel.active,
    directions: adminRouteModel.directions,
  };
  const res = adminRouteEditingId ? await updateRoute(adminRouteEditingId, payload) : await createRoute(payload);
  if (!res) return;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return alert(body.error || 'บันทึกเส้นทางไม่สำเร็จ');
  showToast('บันทึกเส้นทางลง Firebase แล้ว');
  closeRouteEditor();
  await loadRoutes();
  await loadFleet();
}

async function loadFleet() {
  const container = document.getElementById('fleet-list');
  if (!container) return;
  try {
    const [fleet, routes] = await Promise.all([
      fetch('/api/fleet').then(r => r.json()),
      fetchRoutes(),
    ]);
    if (!fleet || Object.keys(fleet).length === 0) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--slate-400);">ไม่มีรถในระบบ — กด "+ เพิ่มรถใหม่"</div>';
      return;
    }
    const routeNames = Object.fromEntries(Object.entries(routes).map(([id, r]) => [id, r.name]));
    container.innerHTML = Object.entries(fleet).map(([id, v]) => {
      const online = v.current && (Date.now() - v.current.timestamp) < 30000;
      const routeName = routeNames[v.routeId] || (v.routeId === 'unassigned' ? '—' : v.routeId);
      const bat = v.current?.battery >= 0 ? v.current.battery : null;
      const spd = v.current?.speed ?? '--';
      const routeOpts = ['<option value="unassigned">— ยังไม่กำหนด —</option>',
        ...Object.entries(routes).map(([rid, r]) =>
          `<option value="${rid}"${v.routeId===rid?' selected':''}>${r.name}</option>`)
      ].join('');
      return `
        <div style="background:var(--slate-50);border:1px solid var(--slate-200);border-radius:12px;padding:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <div style="width:38px;height:38px;border-radius:50%;background:${online?'#ECFDF5':'#F1F5F9'};border:2px solid ${online?'#059669':'#CBD5E1'};display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;">🚐</div>
          <div style="flex:1;min-width:140px;">
            <div style="font-weight:700;font-family:'IBM Plex Mono',monospace;font-size:.85rem;">${id}</div>
            <div style="font-size:.68rem;color:var(--slate-400);">
              ${online ? '<span style="color:#059669;font-weight:700;">● Online</span>' : '<span style="color:#94A3B8;">○ Offline</span>'}
              ${bat !== null ? ` · 🔋${bat}%` : ''} · ⚡${spd}km/h
            </div>
            <div style="font-size:.68rem;color:var(--slate-400);">เส้นทาง: ${routeName}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <select onchange="changeVehicleRoute('${id}',this.value)" style="padding:5px 8px;border:1px solid var(--slate-200);border-radius:7px;font-family:'Sarabun',sans-serif;font-size:.72rem;">
              ${routeOpts}
            </select>
            <button onclick="deleteVehicle('${id}')" class="btn btn-danger" style="padding:4px 10px;font-size:.7rem;">🗑</button>
          </div>
        </div>`;
    }).join('');
  } catch (e) { addLog('err', 'โหลดรถไม่สำเร็จ: ' + e.message); }
}

async function changeVehicleRoute(vehicleId, routeId) {
  try {
    const res  = await authFetch(`/api/fleet/${vehicleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routeId }),
    });
    if (!res) return;
    const body = await res.json();
    if (body.ok) { addLog('ok', `${vehicleId} → เส้นทาง ${routeId}`); loadFleet(); }
    else addLog('err', body.error);
  } catch (e) { addLog('err', e.message); }
}

async function deleteVehicle(vehicleId) {
  if (!confirm(`ลบรถ "${vehicleId}" ออกจากระบบ?`)) return;
  try {
    const res  = await authFetch(`/api/fleet/${vehicleId}`, { method: 'DELETE' });
    if (!res) return;
    const body = await res.json();
    if (body.ok) { addLog('ok', `ลบรถ ${vehicleId} แล้ว`); showToast('🗑 ลบรถแล้ว'); loadFleet(); }
    else addLog('err', body.error);
  } catch (e) { addLog('err', e.message); }
}

// ── Register Vehicle Modal ────────────────────────────────────
async function openRegisterVehicle() {
  // โหลด route list ไปใส่ใน select
  const sel = document.getElementById('reg-route-id');
  if (sel) {
    try {
      const routes = await fetchRoutes();
      sel.innerHTML = '<option value="unassigned">ยังไม่กำหนดเส้นทาง</option>' +
        Object.entries(routes).map(([id, r]) => `<option value="${id}">${r.name}</option>`).join('');
    } catch (_) {}
  }
  const modal = document.getElementById('register-vehicle-modal');
  if (modal) modal.style.display = 'flex';
  const inp = document.getElementById('reg-vehicle-id');
  if (inp) { inp.value = ''; inp.focus(); }
}

function closeRegisterVehicle() {
  const modal = document.getElementById('register-vehicle-modal');
  if (modal) modal.style.display = 'none';
}

async function registerVehicle() {
  const vehicleId   = document.getElementById('reg-vehicle-id')?.value.trim();
  const routeId     = document.getElementById('reg-route-id')?.value || 'unassigned';
  const description = document.getElementById('reg-description')?.value.trim() || '';
  const type        = document.getElementById('reg-type')?.value || 'real';

  if (!vehicleId) { alert('กรุณาระบุ Vehicle ID'); return; }
  addLog('info', `กำลังลงทะเบียน ${vehicleId}...`);
  try {
    const res  = await authFetch('/api/fleet/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicleId, routeId, description, type }),
    });
    if (!res) return;
    const body = await res.json();
    if (body.ok) {
      addLog('ok', `ลงทะเบียนรถ "${vehicleId}" สำเร็จ → ${routeId}`);
      showToast(`✓ เพิ่มรถ ${vehicleId}`);
      closeRegisterVehicle();
      loadFleet();
    } else {
      addLog('err', body.error || 'ลงทะเบียนไม่สำเร็จ');
      alert('❌ ' + (body.error || 'ลงทะเบียนไม่สำเร็จ'));
    }
  } catch (e) { addLog('err', e.message); }
}

// ── Initialize ──────────────────────────────────────────────────────────────
checkAuth();
// loadFleet จะถูกเรียกหลัง checkAuth() → loadRoutes() ใน checkAuth
