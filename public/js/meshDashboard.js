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

function renderMeshGraph(now = performance.now()) {
  const canvas = document.getElementById('mesh-graph-canvas');
  const ctx = canvas?.getContext('2d');
  if (!ctx) return;
  const { width, height } = resizeCanvas(canvas, ctx);
  ctx.clearRect(0, 0, width, height);
  drawGraphBackground(ctx, width, height);

  const nodes = meshNodes();
  if (!nodes.length) {
    drawCentered(ctx, 'No mesh data', width, height);
    return;
  }

  const positions = layoutNodes(nodes, width, height);
  const links = meshLinks();
  links.forEach(link => drawLink(ctx, positions, link, now));
  nodes.forEach(node => drawNode(ctx, positions[node.id], node));
}

function layoutNodes(nodes, width, height) {
  const positions = {};
  const station = nodes.find(node => node.type === 'ground_station') || { id: 'GROUND_01' };
  const vehicles = nodes.filter(node => node.type === 'vehicle');
  const center = { x: width / 2, y: height * 0.46 };
  positions[station.id] = center;
  const radius = Math.max(44, Math.min(width * 0.3, height * 0.28, 180));
  vehicles.forEach((node, index) => {
    const angle = ((Math.PI * 2) / Math.max(vehicles.length, 1)) * index - Math.PI / 2;
    const hopOffset = Math.min(28, Number(node.hop || 0) * 10);
    positions[node.id] = {
      x: center.x + Math.cos(angle) * (radius + hopOffset),
      y: center.y + Math.sin(angle) * (radius + hopOffset),
    };
  });
  return positions;
}

function drawLink(ctx, positions, link, now) {
  const from = positions[link.from];
  const to = positions[link.to];
  if (!from || !to) return;
  const fromNode = nodeById(link.from);
  const toNode = nodeById(link.to);
  const offline = fromNode?.status === 'offline' || toNode?.status === 'offline';
  const hop = Number(link.hop || 0);
  const color = offline ? '#9CA3AF' : hop === 0 ? '#16A34A' : hop === 1 ? '#D97706' : '#DC2626';

  ctx.save();
  ctx.beginPath();
  if (hop > 0 || offline) ctx.setLineDash([9, 6]);
  ctx.strokeStyle = color;
  ctx.lineWidth = hop === 0 ? 4 : 3;
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();

  drawDistanceLabel(ctx, from, to, formatDistanceMeters(link.distance_m));
  if (!offline) drawPacket(ctx, from, to, color, now, link.from + link.to);
}

function drawDistanceLabel(ctx, from, to, label) {
  if (!label || label === '—') return;
  const x = (from.x + to.x) / 2;
  const y = (from.y + to.y) / 2;
  ctx.save();
  ctx.font = '800 14px Inter, sans-serif';
  ctx.textAlign = 'center';
  const metrics = ctx.measureText(label);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeStyle = '#E2E8F0';
  roundedRect(ctx, x - metrics.width / 2 - 10, y - 14, metrics.width + 20, 26, 13);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#334155';
  ctx.fillText(label, x, y + 5);
  ctx.restore();
}

function drawPacket(ctx, from, to, color, now, seed) {
  const hash = [...String(seed)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const t = ((now / 1200) + (hash % 100) / 100) % 1;
  ctx.save();
  ctx.beginPath();
  ctx.arc(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.fill();
  ctx.restore();
}

function drawNode(ctx, pos, node) {
  if (!pos) return;
  const station = node.type === 'ground_station';
  const color = station ? '#2563EB' : node.status === 'online' ? '#16A34A' : '#6B7280';
  const radius = station ? 38 : 31;
  ctx.save();
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = station ? '850 15px Inter, sans-serif' : '850 14px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(station ? 'BASE' : `H${node.hop ?? '-'}`, pos.x, pos.y + 4);

  if (!station) {
    ctx.beginPath();
    ctx.arc(pos.x + radius - 3, pos.y - radius + 5, 5, 0, Math.PI * 2);
    ctx.fillStyle = node.status === 'online' ? '#16A34A' : '#6B7280';
    ctx.fill();
  }

  ctx.fillStyle = '#0F172A';
  ctx.font = '850 15px Inter, sans-serif';
  ctx.fillText(node.label || node.vehicle_id || node.id, pos.x, pos.y + radius + 22);
  ctx.fillStyle = '#64748B';
  ctx.font = '750 12px Inter, sans-serif';
  ctx.fillText(station ? 'Ground Station' : `${node.status || 'unknown'} • ${formatTime(node.last_seen)}`, pos.x, pos.y + radius + 40);
  ctx.restore();
}

function resizeCanvas(canvas, ctx) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.round(rect.width));
  const height = Math.max(300, Math.round(rect.height));
  const ratio = window.devicePixelRatio || 1;
  const targetWidth = Math.round(width * ratio);
  const targetHeight = Math.round(height * ratio);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { width, height };
}

function drawGraphBackground(ctx, width, height) {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 1;
  for (let x = 40; x < width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 40; y < height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
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
