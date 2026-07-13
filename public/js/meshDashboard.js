'use strict';

let meshData = null;
let meshPage = 0;
let meshAnimStarted = false;
let meshLastFrame = 0;
let selectedMeshNodeId = null;
const MESH_PAGE_SIZE = 8;

document.addEventListener('DOMContentLoaded', initMeshDashboard);

async function initMeshDashboard() {
  renderSharedNavbar({ active: 'dashboard' });
  document.getElementById('mesh-online-icon').innerHTML = busSvg(18, '#16A34A');
  document.getElementById('mesh-direct-icon').innerHTML = antennaSvg(18, '#2563EB');
  document.getElementById('mesh-relay-icon').innerHTML = signalSvg(18, '#D97706');
  document.getElementById('mesh-refresh-btn').addEventListener('click', refreshMeshDashboard);
  document.getElementById('mesh-prev-page').addEventListener('click', () => {
    meshPage = Math.max(0, meshPage - 1);
    renderMeshTable();
  });
  document.getElementById('mesh-next-page').addEventListener('click', () => {
    meshPage += 1;
    renderMeshTable();
  });
  await refreshMeshDashboard();
  setInterval(refreshMeshDashboard, 3000);
  startMeshAnimation();
}

async function refreshMeshDashboard() {
  try {
    const response = await fetch('/api/v1/network');
    if (!response.ok) throw new Error(`network ${response.status}`);
    meshData = await response.json();
    ensureSelectedMeshNode();
    renderMeshSummary();
    renderVehicleDistances();
    renderNodeList();
    renderNetworkDetails();
    renderMeshTable();
    renderMeshGraph(performance.now());
  } catch (error) {
    console.error('[mesh]', error);
  }
}

function renderMeshSummary() {
  const meta = meshData?.meta || {};
  const links = meshLinks();
  const vehicles = vehicleNodes();
  const totalVehicles = meta.total_vehicles ?? vehicles.length;
  const onlineVehicles = meta.online_vehicles ?? vehicles.filter(node => node.status === 'online').length;
  const direct = links.filter(link => link.type === 'direct' || Number(link.hop) === 0).length;
  const relay = links.filter(link => link.type === 'relay' || Number(link.hop) > 0).length;
  const health = Math.round(meshData?.health?.score ?? meshData?.health ?? 0);

  document.getElementById('mesh-online').textContent = `${onlineVehicles}/${totalVehicles} คัน`;
  document.getElementById('mesh-online-sub').textContent = `${totalVehicles ? Math.round((onlineVehicles / totalVehicles) * 100) : 0}% ออนไลน์`;
  document.getElementById('mesh-direct-links').textContent = direct;
  document.getElementById('mesh-direct-sub').textContent = `${links.length ? Math.round((direct / links.length) * 100) : 0}% ของลิงก์ทั้งหมด`;
  document.getElementById('mesh-relay-links').textContent = relay;
  document.getElementById('mesh-relay-sub').textContent = `${links.length ? Math.round((relay / links.length) * 100) : 0}% ของลิงก์ทั้งหมด`;
  document.getElementById('mesh-health').textContent = `${health}/100`;
  document.getElementById('mesh-health-ring').textContent = health;
  document.getElementById('mesh-health-ring').style.setProperty('--value', health);
  document.getElementById('mesh-updated').textContent = `อัปเดต ${formatTime(meshData?.server_time)}`;
  const modeBadge = document.getElementById('mesh-mode-badge');
  modeBadge.textContent = meshData?.mode || 'waiting';
  modeBadge.className = `small-badge ${meshData?.mode === 'telemetry' ? 'status-online' : meshData?.mode === 'estimated' ? 'status-warning' : 'status-offline'}`;
  document.getElementById('mesh-link-summary').textContent = `${links.length} links • ${vehicles.length} vehicles • ${meshData?.health?.label || 'กำลังประเมิน'}`;
}

function startMeshAnimation() {
  if (meshAnimStarted) return;
  meshAnimStarted = true;
  const frame = now => {
    if (now - meshLastFrame > 30) {
      renderMeshGraph(now);
      meshLastFrame = now;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* ─────────────────────────────────────────
   Mesh Graph — Clean Radial Renderer
───────────────────────────────────────── */

const NODE_R_BASE  = 32;
const NODE_R_VEH   = 26;
const ORBIT_PAD    = 34; // min gap from canvas edge to node center

function renderMeshGraph(now = performance.now()) {
  const canvas = document.getElementById('mesh-graph-canvas');
  const ctx = canvas?.getContext('2d');
  if (!ctx) return;
  const { width, height } = resizeCanvas(canvas, ctx);
  ctx.clearRect(0, 0, width, height);
  drawGraphBackground(ctx, width, height);

  const nodes = meshNodes();
  if (!nodes.length) {
    drawCentered(ctx, 'ยังไม่มีข้อมูลโครงข่าย', width, height);
    return;
  }

  const { positions, angles } = layoutNodes(nodes, width, height);
  const links = meshLinks();

  // 1. Draw all links (behind nodes)
  links.forEach(link => drawLink(ctx, positions, link, now));
  drawOfflineConnectors(ctx, positions, nodes, links);

  // 2. Draw nodes + labels on top
  nodes.forEach(node => drawNode(ctx, positions[node.id], angles[node.id], node, width, height));
}

/* ── Layout: radial from center ──────────────────────── */
function layoutNodes(nodes, width, height) {
  const positions = {};
  const angles    = {};
  const station   = nodes.find(n => n.type === 'ground_station') || { id: 'GROUND_01' };
  const vehicles  = nodes.filter(n => n.type === 'vehicle');

  const cx = width  / 2;
  const cy = height / 2;
  positions[station.id] = { x: cx, y: cy };
  angles[station.id]    = null; // center — label goes below

  const maxR = Math.max(62, Math.min(
    cx - ORBIT_PAD - NODE_R_VEH,
    cy - ORBIT_PAD - NODE_R_VEH
  ));
  const orbitR = Math.min(maxR, Math.max(108, Math.min(width, height) * 0.43));

  vehicles.forEach((node, i) => {
    const angle = ((Math.PI * 2) / Math.max(vehicles.length, 1)) * i - Math.PI / 2;
    positions[node.id] = {
      x: cx + Math.cos(angle) * orbitR,
      y: cy + Math.sin(angle) * orbitR,
    };
    angles[node.id] = angle;
  });

  return { positions, angles };
}

/* ── Links ──────────────────────────────────────────── */
function drawLink(ctx, positions, link, now) {
  const from = positions[link.from];
  const to   = positions[link.to];
  if (!from || !to) return;

  const fromNode = nodeById(link.from);
  const toNode   = nodeById(link.to);
  const offline  = fromNode?.status === 'offline' || toNode?.status === 'offline';
  const hop      = Number(link.hop ?? 0);

  let color, dash, lw;
  if (offline)     { color = 'rgba(148,163,184,0.5)'; dash = [7, 8];  lw = 1.5; }
  else if (hop===0){ color = '#22C55E';               dash = [];       lw = 2.5; }
  else if (hop===1){ color = '#F59E0B';               dash = [8, 6];  lw = 2;   }
  else             { color = '#EF4444';               dash = [5, 7];  lw = 1.5; }

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth   = lw;
  ctx.lineCap     = 'round';
  ctx.stroke();
  ctx.restore();

  // Distance label — only when we have a real value
  const label = formatDistanceMeters(link.distance_m);
  if (label && label !== '—') drawDistanceLabel(ctx, from, to, label, color);

  // Single flowing packet for online links
  if (!offline) drawPacket(ctx, from, to, color, now, link.from + link.to);
}

function drawOfflineConnectors(ctx, positions, nodes, links) {
  const station = nodes.find(n => n.type === 'ground_station');
  if (!station) return;
  const base = positions[station.id];
  if (!base) return;
  const linked = new Set(links.flatMap(l => [l.from, l.to]));
  nodes.filter(n => n.type === 'vehicle' && !linked.has(n.id)).forEach(n => {
    const p = positions[n.id];
    if (!p) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(p.x, p.y);
    ctx.setLineDash([4, 9]);
    ctx.strokeStyle = 'rgba(148,163,184,0.28)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  });
}

function drawDistanceLabel(ctx, from, to, label, lineColor) {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  ctx.save();
  ctx.font = '600 10px Inter, Sarabun, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width;
  const pw = tw + 10, ph = 16;
  // simple white rect, colored border
  ctx.fillStyle   = 'rgba(255,255,255,0.95)';
  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = 1;
  roundedRect(ctx, mx - pw / 2, my - ph / 2, pw, ph, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#374151';
  ctx.fillText(label, mx, my);
  ctx.restore();
}

function drawPacket(ctx, from, to, color, now, seed) {
  const hash = [...String(seed)].reduce((s, c) => s + c.charCodeAt(0), 0);
  const t    = ((now / 1600) + (hash % 100) / 100) % 1;
  const x    = from.x + (to.x - from.x) * t;
  const y    = from.y + (to.y - from.y) * t;
  ctx.save();
  // outer glow
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = color.replace(')', ',0.25)').replace('rgb', 'rgba');
  ctx.fill();
  // core dot
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  // white highlight
  ctx.beginPath();
  ctx.arc(x - 0.8, y - 0.8, 1.2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fill();
  ctx.restore();
}

/* ── Nodes ──────────────────────────────────────────── */
function drawNode(ctx, pos, angle, node, width, height) {
  if (!pos) return;
  const isBase = node.type === 'ground_station';
  const online = node.status === 'online';
  const r      = isBase ? NODE_R_BASE : NODE_R_VEH;
  const ring   = isBase ? '#3B82F6' : online ? '#22C55E' : '#9CA3AF';

  ctx.save();

  // Drop shadow
  ctx.shadowColor   = 'rgba(15,23,42,0.12)';
  ctx.shadowBlur    = 10;
  ctx.shadowOffsetY = 3;

  // White filled circle
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur  = 0;
  ctx.shadowOffsetY = 0;

  // Colored border
  ctx.lineWidth   = isBase ? 3 : 2.5;
  ctx.strokeStyle = ring;
  ctx.stroke();

  // Centre label: BASE or hop number
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = ring;
  ctx.font         = `700 ${isBase ? 12 : 11}px Inter, Sarabun, sans-serif`;
  ctx.fillText(isBase ? 'BASE' : `H${node.hop ?? '—'}`, pos.x, pos.y);

  // Status dot (vehicle only)
  if (!isBase) {
    ctx.beginPath();
    ctx.arc(pos.x + r * 0.7, pos.y - r * 0.7, 5, 0, Math.PI * 2);
    ctx.fillStyle   = online ? '#22C55E' : '#9CA3AF';
    ctx.fill();
    ctx.lineWidth   = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  ctx.restore();

  // External label — pushed radially outward
  drawNodeLabel(ctx, pos, angle, r, node, width, height);
}

function drawNodeLabel(ctx, pos, angle, r, node, width, height) {
  const isBase  = node.type === 'ground_station';
  const online  = node.status === 'online';
  const name    = node.label || node.vehicle_id || node.id;
  const gpsText = !isBase && online && !nodeHasGpsFix(node) ? ' · GPS no fix' : '';
  const subLine = isBase
    ? 'Ground Station'
    : (online ? '● online' : '○ offline') + gpsText + ' ' + formatTime(node.last_seen);

  // For the center base station, push label straight down
  // For orbiting vehicles, push in the direction of their angle (away from center)
  const pushAngle = (angle !== null) ? angle : Math.PI / 2;
  const GAP  = r + 10;
  const ox   = Math.cos(pushAngle) * GAP;
  const oy   = Math.sin(pushAngle) * GAP;

  // Anchor text depending on push direction
  let hAlign;
  if (Math.abs(ox) < 10)       hAlign = 'center';
  else if (ox > 0)              hAlign = 'left';
  else                          hAlign = 'right';

  const labelPad = 12;
  const maxLabelWidth = Math.min(140, Math.max(90, width * 0.26));
  let anchorX = pos.x + ox;
  let   anchorY = pos.y + oy;
  // if angle is nearly straight down, push a bit more to clear node
  if (angle === null || Math.abs(pushAngle - Math.PI / 2) < 0.3)
    anchorY = pos.y + r + 12;

  if (hAlign === 'left' && anchorX + maxLabelWidth > width - labelPad) {
    anchorX = width - labelPad - maxLabelWidth;
  } else if (hAlign === 'right' && anchorX - maxLabelWidth < labelPad) {
    anchorX = labelPad + maxLabelWidth;
  } else if (hAlign === 'center') {
    anchorX = clamp(anchorX, labelPad + maxLabelWidth / 2, width - labelPad - maxLabelWidth / 2);
  }
  anchorY = clamp(anchorY, labelPad, height - labelPad - 28);

  ctx.save();
  ctx.textAlign = hAlign;
  ctx.textBaseline = 'top';

  // Vehicle ID / name — bold
  ctx.fillStyle = '#1E293B';
  ctx.font      = `700 11px Inter, Sarabun, sans-serif`;
  ctx.fillText(name, anchorX, anchorY);

  // Sub-line — smaller, colored
  ctx.fillStyle = isBase ? '#3B82F6' : online ? '#16A34A' : '#9CA3AF';
  ctx.font      = `500 9.5px Inter, Sarabun, sans-serif`;
  ctx.fillText(subLine, anchorX, anchorY + 14);

  ctx.restore();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/* ── Canvas helpers ─────────────────────────────────── */
function resizeCanvas(canvas, ctx) {
  const rect = canvas.getBoundingClientRect();
  const w    = Math.max(300, Math.round(rect.width));
  const h    = Math.max(200, Math.round(rect.height));
  const dpr  = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w*dpr) || canvas.height !== Math.round(h*dpr)) {
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: w, height: h };
}

function drawGraphBackground(ctx, width, height) {
  ctx.save();
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  // Very faint dot grid
  ctx.fillStyle = 'rgba(148,163,184,0.18)';
  const sp = 32;
  for (let gx = sp; gx < width; gx += sp) {
    for (let gy = sp; gy < height; gy += sp) {
      ctx.beginPath();
      ctx.arc(gx, gy, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

function drawCentered(ctx, text, width, height) {
  ctx.fillStyle = '#94A3B8';
  ctx.font = '600 13px Inter, Sarabun, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2);
}

function renderVehicleDistances() {
  const body = document.getElementById('vehicle-distance-body');
  const pairs = meshData?.vehicle_pairs || [];
  if (!pairs.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty-state">ยังไม่มีข้อมูลระยะห่าง</td></tr>';
    return;
  }
  body.innerHTML = pairs.map(pair => {
    const cls = distanceClass(pair.distance_m);
    return `
      <tr>
        <td>${pair.from}</td>
        <td>${pair.to}</td>
        <td><span class="distance-pill ${cls}">${formatDistanceMeters(pair.distance_m)}</span></td>
        <td>${distanceStatus(pair.distance_m)}</td>
      </tr>`;
  }).join('');
}

function renderNodeList() {
  const root = document.getElementById('mesh-node-body');
  const nodes = vehicleNodes();
  if (!nodes.length) {
    root.innerHTML = '<div class="empty-state">ยังไม่มีรถในโครงข่าย</div>';
    return;
  }
  root.innerHTML = nodes.map(node => `
    <button class="node-row ${node.id === selectedMeshNodeId ? 'selected' : ''}" type="button" data-node-id="${node.id}">
      <span class="node-dot ${node.status === 'online' ? 'online' : ''}"></span>
      <span>
        <strong>${node.plate || node.vehicle_id || node.id}</strong>
        <span class="item-meta" style="display:block;">Hop ${node.hop ?? '—'} • ${node.demo ? 'Demo' : 'Real'}${gpsMeta(node)}</span>
      </span>
      <span style="display:inline-flex;gap:4px;align-items:center;justify-content:flex-end;flex-wrap:wrap;">${statusBadge(node.status, node.gps_fix)}</span>
    </button>`).join('');
  root.querySelectorAll('[data-node-id]').forEach(button => {
    button.addEventListener('click', () => {
      selectedMeshNodeId = button.dataset.nodeId;
      renderNodeList();
      renderNetworkDetails();
    });
  });
}

function renderNetworkDetails() {
  const root = document.getElementById('mesh-network-body');
  const telemetryDetails = networkTelemetryRows();
  root.innerHTML = telemetryDetails.map(([label, value]) => `
    <div class="network-detail-row">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>`).join('');
  return;
  const links = meshLinks();
  const nodes = vehicleNodes();
  const online = nodes.filter(node => node.status === 'online').length;
  const avgDistance = links.map(link => Number(link.distance_m)).filter(Number.isFinite);
  const avgHop = links.map(link => Number(link.hop)).filter(Number.isFinite);
  const details = [
    ['โหมด', meshData?.mode || 'waiting'],
    ['รถออนไลน์', `${online}/${nodes.length}`],
    ['ระยะลิงก์เฉลี่ย', avgDistance.length ? formatDistanceMeters(avgDistance.reduce((a, b) => a + b, 0) / avgDistance.length) : '—'],
    ['Hop เฉลี่ย', avgHop.length ? (avgHop.reduce((a, b) => a + b, 0) / avgHop.length).toFixed(1) : '—'],
  ];
  root.innerHTML = details.map(([label, value]) => `
    <div class="network-detail-row">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>`).join('');
}

function networkTelemetryRows() {
  const links = meshLinks();
  const nodes = vehicleNodes();
  const online = nodes.filter(node => node.status === 'online').length;
  const avgDistance = links.map(link => Number(link.distance_m)).filter(Number.isFinite);
  const avgHop = links.map(link => Number(link.hop)).filter(Number.isFinite);
  const focus = nodeById(selectedMeshNodeId) || nodes.find(node => node.status === 'online') || nodes[0];
  return [
    ['Mode', meshData?.mode || 'waiting'],
    ['Online vehicles', `${online}/${nodes.length}`],
    ['Average link', avgDistance.length ? formatDistanceMeters(avgDistance.reduce((a, b) => a + b, 0) / avgDistance.length) : '--'],
    ['Average hop', avgHop.length ? (avgHop.reduce((a, b) => a + b, 0) / avgHop.length).toFixed(1) : '--'],
    ...selectedNodeTelemetryRows(focus),
  ];
}

function selectedNodeTelemetryRows(node) {
  if (!node) return [['Selected vehicle', '--']];
  const gps = node.gps_fix === false
    ? 'No fix'
    : [node.sats != null ? `${node.sats} sats` : null, node.hdop != null ? `HDOP ${node.hdop}` : null].filter(Boolean).join(' / ') || 'Fixed';
  return [
    ['Selected vehicle', node.plate || node.vehicle_id || node.id],
    ['Vehicle ID', node.vehicle_id || node.id],
    ['Speed', formatSpeedKmh(node.speed)],
    ['Battery', formatNodeBattery(node)],
    ['Battery raw', formatNodeBatteryRaw(node)],
    ['GPS quality', gps],
    ['RSSI / SNR', [formatMetric(node.received_rssi ?? node.rssi, ' dBm'), formatMetric(node.received_snr ?? node.snr, ' dB')].filter(value => value !== '--').join(' / ') || '--'],
    ['Link quality', node.link_quality != null ? `${node.link_quality}%` : '--'],
    ['Power', formatNodePower(node)],
    ['Packet', [node.seq != null ? `seq ${node.seq}` : null, node.packet_id || null].filter(Boolean).join(' / ') || '--'],
    ['Relay chain', Array.isArray(node.relay_chain) && node.relay_chain.length ? node.relay_chain.join(' -> ') : node.relay_from || 'direct'],
    ['Neighbors', Array.isArray(node.neighbors) && node.neighbors.length ? node.neighbors.length : '--'],
  ];
}

function formatMetric(value, suffix = '') {
  const number = Number(value);
  return Number.isFinite(number) ? `${number}${suffix}` : '--';
}

function formatNodeBattery(node) {
  const battery = Number(node?.battery);
  if (!Number.isFinite(battery)) return '--';
  const voltage = Number(node?.battVoltage);
  const parts = [`${battery.toFixed(Number.isInteger(battery) ? 0 : 1)}%`];
  if (Number.isFinite(voltage)) parts.push(`${voltage} mV`);
  return parts.join(' / ');
}

function formatNodeBatteryRaw(node) {
  const raw = Number(node?.batteryRaw);
  const a0Voltage = Number(node?.a0Voltage);
  const parts = [];
  if (Number.isFinite(raw)) parts.push(`raw ${raw}`);
  if (Number.isFinite(a0Voltage)) parts.push(`A0 ${a0Voltage.toFixed(3)}V`);
  return parts.length ? parts.join(' / ') : '--';
}

function formatNodePower(node) {
  const parts = [];
  if (Number.isFinite(Number(node.battVoltage))) parts.push(`${node.battVoltage} mV`);
  if (Number.isFinite(Number(node.currentMa))) parts.push(`${node.currentMa} mA`);
  if (Number.isFinite(Number(node.powerMw))) parts.push(`${node.powerMw} mW`);
  return parts.length ? parts.join(' / ') : '--';
}

function renderMeshTable() {
  const body = document.getElementById('mesh-links-body');
  const rows = connectivityRows();
  const start = meshPage * MESH_PAGE_SIZE;
  if (start >= rows.length && meshPage > 0) {
    meshPage = Math.max(0, meshPage - 1);
    return renderMeshTable();
  }
  const page = rows.slice(start, start + MESH_PAGE_SIZE);
  body.innerHTML = page.length ? page.map((row, index) => `
    <tr>
      <td>${start + index + 1}</td>
      <td>${row.vehicle}</td>
      <td>${row.connectedTo}</td>
      <td>${formatDistanceMeters(row.distance_m)}</td>
      <td>${row.hop}</td>
      <td>${row.linkType}</td>
      <td>${statusBadge(row.status, row.gps_fix)}</td>
      <td>${formatTime(row.last_seen)}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty-state">ยังไม่มีข้อมูลรถ</td></tr>';
  const totalPages = Math.max(1, Math.ceil(rows.length / MESH_PAGE_SIZE));
  document.getElementById('mesh-page-label').textContent = `หน้า ${Math.min(meshPage + 1, totalPages)} / ${totalPages}`;
}

function connectivityRows() {
  const links = meshLinks();
  return vehicleNodes().map(node => {
    const link = links.find(item => item.from === node.id || item.to === node.id);
    const connectedTo = link ? (link.from === node.id ? link.to : link.from) : '—';
    return {
      vehicle: node.vehicle_id || node.id,
      connectedTo,
      distance_m: link?.distance_m ?? null,
      hop: link?.hop ?? node.hop ?? '—',
      linkType: link?.type || (node.status === 'offline' ? 'offline' : 'none'),
      status: node.status || link?.status || 'offline',
      gps_fix: node.gps_fix,
      last_seen: node.last_seen,
    };
  });
}

function statusBadge(status, gpsFix = true) {
  const cls = status === 'online' || status === 'good' ? 'status-online' : status === 'fair' ? 'status-warning' : status === 'offline' ? 'status-offline' : 'status-danger';
  const label = { online: 'ออนไลน์', offline: 'ออฟไลน์', good: 'good', fair: 'fair', poor: 'poor' }[status] || status || '—';
  const gpsBadge = status === 'online' && gpsFix === false
    ? '<span class="small-badge status-warning">รับ GPS ไม่ได้</span>'
    : '';
  return `<span class="small-badge ${cls}">${label}</span>${gpsBadge}`;
}

function nodeHasGpsFix(node) {
  return node?.gps_fix !== false && Number.isFinite(Number(node?.lat)) && Number.isFinite(Number(node?.lng));
}

function gpsMeta(node) {
  return nodeHasGpsFix(node) ? '' : ' • รับ GPS ไม่ได้';
}

function distanceClass(distance) {
  const value = Number(distance);
  if (!Number.isFinite(value) || value >= 10000) return 'gray';
  if (value < 500) return 'green';
  if (value < 2000) return 'blue';
  return 'amber';
}

function distanceStatus(distance) {
  const cls = distanceClass(distance);
  return { green: 'ใกล้', blue: 'ปกติ', amber: 'ไกล', gray: 'ห่างมาก' }[cls];
}

function ensureSelectedMeshNode() {
  const nodes = vehicleNodes();
  if (!nodes.length) {
    selectedMeshNodeId = null;
    return;
  }
  if (!selectedMeshNodeId || !nodes.some(node => node.id === selectedMeshNodeId)) {
    selectedMeshNodeId = (nodes.find(node => node.status === 'online') || nodes[0]).id;
  }
}

function meshNodes() {
  return meshData?.nodes || [];
}

function vehicleNodes() {
  return meshNodes().filter(node => node.type === 'vehicle');
}

function meshLinks() {
  return meshData?.links || [];
}

function nodeById(id) {
  return meshNodes().find(node => node.id === id || node.vehicle_id === id);
}
