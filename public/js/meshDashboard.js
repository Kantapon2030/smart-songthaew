'use strict';

let meshData = null;
let meshPage = 0;
let meshAnimStarted = false;
let meshLastFrame = 0;
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
   Mesh Graph — Premium Animated Renderer
───────────────────────────────────────── */

const NODE_R_BASE   = 36; // base station radius
const NODE_R_VEHCL  = 28; // vehicle node radius
const LABEL_PAD_V   = 14; // vertical gap between node edge and label

function renderMeshGraph(now = performance.now()) {
  const canvas = document.getElementById('mesh-graph-canvas');
  const ctx = canvas?.getContext('2d');
  if (!ctx) return;
  const { width, height } = resizeCanvas(canvas, ctx);
  ctx.clearRect(0, 0, width, height);
  drawGraphBackground(ctx, width, height);

  const nodes = meshNodes();
  if (!nodes.length) {
    drawCentered(ctx, '— ยังไม่มีข้อมูลโครงข่าย —', width, height);
    return;
  }

  const positions = layoutNodes(nodes, width, height);
  const links = meshLinks();

  // Draw links first (behind nodes)
  links.forEach(link => drawLink(ctx, positions, link, now));

  // Draw offline ghost links for nodes with no explicit link
  drawOfflineConnectors(ctx, positions, nodes, links);

  // Draw nodes on top
  nodes.forEach(node => drawNode(ctx, positions[node.id], node, width, height));
}

/* ── Layout ───────────────────────────────────────────── */
function layoutNodes(nodes, width, height) {
  const PAD = 80; // keep nodes inside this border padding
  const positions = {};
  const station = nodes.find(n => n.type === 'ground_station') || { id: 'GROUND_01' };
  const vehicles = nodes.filter(n => n.type === 'vehicle');

  const cx = width  / 2;
  const cy = height / 2;
  positions[station.id] = { x: cx, y: cy };

  const available = Math.min(
    (width  / 2) - PAD - NODE_R_BASE,
    (height / 2) - PAD - NODE_R_BASE
  );
  const orbitR = Math.max(80, Math.min(available, 160));

  vehicles.forEach((node, i) => {
    const angle = ((Math.PI * 2) / Math.max(vehicles.length, 1)) * i - Math.PI / 2;
    positions[node.id] = {
      x: cx + Math.cos(angle) * orbitR,
      y: cy + Math.sin(angle) * orbitR,
    };
  });
  return positions;
}

/* ── Link rendering ───────────────────────────────────── */
function drawLink(ctx, positions, link, now) {
  const from = positions[link.from];
  const to   = positions[link.to];
  if (!from || !to) return;

  const fromNode = nodeById(link.from);
  const toNode   = nodeById(link.to);
  const offline  = fromNode?.status === 'offline' || toNode?.status === 'offline';
  const hop      = Number(link.hop ?? 0);

  // Pick colors & style per link type
  let lineColor, glowColor, dashPattern, lineWidth;
  if (offline) {
    lineColor   = 'rgba(156,163,175,0.45)';
    glowColor   = 'rgba(156,163,175,0)';
    dashPattern = [8, 8];
    lineWidth   = 2;
  } else if (hop === 0) {
    lineColor   = '#16A34A';
    glowColor   = 'rgba(22,163,74,0.25)';
    dashPattern = [];
    lineWidth   = 3;
  } else if (hop === 1) {
    lineColor   = '#D97706';
    glowColor   = 'rgba(217,119,6,0.22)';
    dashPattern = [10, 6];
    lineWidth   = 2.5;
  } else {
    lineColor   = '#DC2626';
    glowColor   = 'rgba(220,38,38,0.2)';
    dashPattern = [6, 8];
    lineWidth   = 2;
  }

  // --- Glow halo pass (thicker, semi-transparent) ---
  if (!offline) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.setLineDash(dashPattern);
    ctx.strokeStyle = glowColor;
    ctx.lineWidth   = lineWidth + 8;
    ctx.lineCap     = 'round';
    ctx.stroke();
    ctx.restore();
  }

  // --- Main line pass ---
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.setLineDash(dashPattern);
  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = lineWidth;
  ctx.lineCap     = 'round';
  ctx.stroke();
  ctx.restore();

  // --- Distance badge ---
  drawDistanceLabel(ctx, from, to, formatDistanceMeters(link.distance_m), lineColor, offline);

  // --- Animated data packets (only for online links) ---
  if (!offline) {
    drawPackets(ctx, from, to, lineColor, glowColor, now, link.from + link.to);
  }
}

/* Draw faint dashed connectors for all nodes to base even if not in links[] */
function drawOfflineConnectors(ctx, positions, nodes, links) {
  const station = nodes.find(n => n.type === 'ground_station');
  if (!station) return;
  const basePos = positions[station.id];
  if (!basePos) return;

  const linkedIds = new Set(links.flatMap(l => [l.from, l.to]));
  nodes.filter(n => n.type === 'vehicle' && !linkedIds.has(n.id)).forEach(node => {
    const pos = positions[node.id];
    if (!pos) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(basePos.x, basePos.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.setLineDash([5, 10]);
    ctx.strokeStyle = 'rgba(156,163,175,0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  });
}

/* ── Distance pill on link midpoint ──────────────────── */
function drawDistanceLabel(ctx, from, to, label, lineColor, offline) {
  if (!label || label === '—') return;
  const x = (from.x + to.x) / 2;
  const y = (from.y + to.y) / 2;
  ctx.save();
  ctx.font = '700 11px Inter, Sarabun, sans-serif';
  ctx.textAlign = 'center';
  const tw = ctx.measureText(label).width;
  const pw = tw + 14, ph = 18, pr = 9;

  // pill background
  ctx.fillStyle   = offline ? '#F1F5F9' : 'rgba(255,255,255,0.96)';
  ctx.strokeStyle = offline ? '#CBD5E1' : lineColor;
  ctx.lineWidth   = 1.2;
  roundedRect(ctx, x - pw / 2, y - ph / 2, pw, ph, pr);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = offline ? '#94A3B8' : '#1E293B';
  ctx.fillText(label, x, y + 4);
  ctx.restore();
}

/* ── Animated flowing packets on online links ─────── */
function drawPackets(ctx, from, to, color, glowColor, now, seed) {
  const hash  = [...String(seed)].reduce((s, c) => s + c.charCodeAt(0), 0);
  // Draw 2 packets per link with phase offset for a nice flowing effect
  [0, 0.5].forEach(phase => {
    const t = ((now / 1400) + (hash % 100) / 100 + phase) % 1;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle   = '#ffffff';
    ctx.shadowColor = color;
    ctx.shadowBlur  = 14;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  });
}

/* ── Node rendering ───────────────────────────────────── */
function drawNode(ctx, pos, node, canvasW, canvasH) {
  if (!pos) return;
  const isBase   = node.type === 'ground_station';
  const online   = node.status === 'online';
  const r        = isBase ? NODE_R_BASE : NODE_R_VEHCL;

  const ringColor = isBase
    ? '#2563EB'
    : online ? '#16A34A' : '#94A3B8';

  const gradTop = isBase
    ? '#EFF6FF'
    : online ? '#F0FDF4' : '#F8FAFC';
  const gradBot = isBase
    ? '#DBEAFE'
    : online ? '#DCFCE7' : '#F1F5F9';

  ctx.save();

  // --- Outer glow ring for online nodes ---
  if (online || isBase) {
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r + 8, 0, Math.PI * 2);
    ctx.fillStyle = isBase
      ? 'rgba(37,99,235,0.10)'
      : 'rgba(22,163,74,0.10)';
    ctx.fill();
  }

  // --- Drop shadow ---
  ctx.shadowColor  = 'rgba(15,23,42,0.18)';
  ctx.shadowBlur   = 12;
  ctx.shadowOffsetY = 4;

  // --- Node fill with vertical gradient ---
  const grad = ctx.createRadialGradient(pos.x, pos.y - r * 0.3, r * 0.1, pos.x, pos.y, r);
  grad.addColorStop(0, gradTop);
  grad.addColorStop(1, gradBot);
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur  = 0;
  ctx.shadowOffsetY = 0;

  // --- Colored ring border ---
  ctx.lineWidth   = isBase ? 3.5 : 2.5;
  ctx.strokeStyle = ringColor;
  ctx.stroke();

  // --- Inner label (BASE / H0 / H1 …) ---
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = ringColor;
  ctx.font         = `800 ${isBase ? 13 : 12}px Inter, Sarabun, sans-serif`;
  ctx.fillText(isBase ? 'BASE' : `H${node.hop ?? '—'}`, pos.x, pos.y);

  // --- Status dot (top-right corner) ---
  if (!isBase) {
    const dotX = pos.x + r * 0.68;
    const dotY = pos.y - r * 0.68;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = online ? '#16A34A' : '#9CA3AF';
    ctx.fill();
    ctx.lineWidth   = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  ctx.restore();

  // --- Node labels (name + status/time) outside node ---
  drawNodeLabel(ctx, pos, node, r, canvasW, canvasH);
}

function drawNodeLabel(ctx, pos, node, r, canvasW, canvasH) {
  const isBase   = node.type === 'ground_station';
  const name     = node.label || node.vehicle_id || node.id;
  const sub      = isBase ? 'Ground Station' : `${node.status ?? 'unknown'} • ${formatTime(node.last_seen)}`;
  const online   = node.status === 'online';
  const nameColor = '#0F172A';
  const subColor  = isBase ? '#2563EB' : online ? '#16A34A' : '#94A3B8';

  // Place label below if node is in top half, above if in bottom half
  // But clamp so label doesn't go outside canvas bounds
  const spaceBelow = canvasH - (pos.y + r);
  const spaceAbove = pos.y - r;
  const useAbove   = spaceBelow < 56 && spaceAbove > 56;

  ctx.save();
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'alphabetic';

  const nameFont = `700 12px Inter, Sarabun, sans-serif`;
  const subFont  = `600 10px Inter, Sarabun, sans-serif`;

  // Measure pill width
  ctx.font = nameFont;
  const nameW = ctx.measureText(name).width;
  ctx.font = subFont;
  const subW  = ctx.measureText(sub).width;
  const pillW = Math.max(nameW, subW) + 18;
  const pillH = 34;
  const pillR = 7;

  const labelY = useAbove
    ? pos.y - r - LABEL_PAD_V - pillH
    : pos.y + r + LABEL_PAD_V;

  // Pill background
  ctx.fillStyle   = 'rgba(255,255,255,0.92)';
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth   = 1;
  roundedRect(ctx, pos.x - pillW / 2, labelY, pillW, pillH, pillR);
  ctx.fill();
  ctx.stroke();

  // Name
  ctx.fillStyle = nameColor;
  ctx.font      = nameFont;
  ctx.fillText(name, pos.x, labelY + 14);

  // Sub-text
  ctx.fillStyle = subColor;
  ctx.font      = subFont;
  ctx.fillText(sub, pos.x, labelY + 28);

  ctx.restore();
}

/* ── Canvas utilities ─────────────────────────────────── */
function resizeCanvas(canvas, ctx) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(300, Math.round(rect.width));
  const h = Math.max(200, Math.round(rect.height));
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: w, height: h };
}

function drawGraphBackground(ctx, width, height) {
  ctx.save();

  // Subtle light gradient background
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, '#F8FAFF');
  bg.addColorStop(1, '#EFF4FF');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Dot-grid pattern
  ctx.fillStyle = 'rgba(148,163,184,0.30)';
  const spacing = 28;
  for (let gx = spacing; gx < width; gx += spacing) {
    for (let gy = spacing; gy < height; gy += spacing) {
      ctx.beginPath();
      ctx.arc(gx, gy, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}



function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function drawCentered(ctx, text, width, height) {
  ctx.fillStyle = '#64748B';
  ctx.font = '800 15px Inter, sans-serif';
  ctx.textAlign = 'center';
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
    <div class="node-row">
      <span class="node-dot ${node.status === 'online' ? 'online' : ''}"></span>
      <span>
        <strong>${node.vehicle_id || node.id}</strong>
        <span class="item-meta" style="display:block;">Hop ${node.hop ?? '—'} • ${node.demo ? 'Demo' : 'Real'}</span>
      </span>
      <span class="small-badge ${node.status === 'online' ? 'status-online' : 'status-offline'}">${node.status || '—'}</span>
    </div>`).join('');
}

function renderNetworkDetails() {
  const root = document.getElementById('mesh-network-body');
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
      <td>${statusBadge(row.status)}</td>
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
      last_seen: node.last_seen,
    };
  });
}

function statusBadge(status) {
  const cls = status === 'online' || status === 'good' ? 'status-online' : status === 'fair' ? 'status-warning' : status === 'offline' ? 'status-offline' : 'status-danger';
  const label = { online: 'ออนไลน์', offline: 'ออฟไลน์', good: 'good', fair: 'fair', poor: 'poor' }[status] || status || '—';
  return `<span class="small-badge ${cls}">${label}</span>`;
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
