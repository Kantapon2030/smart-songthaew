'use strict';

let meshMap;
let meshMapMarkers = [];
let meshData = null;
let meshPage = 0;
const MESH_PAGE_SIZE = 6;

document.addEventListener('DOMContentLoaded', initMeshDashboard);

async function initMeshDashboard() {
  renderSharedNavbar({ active: 'mesh', mesh: true });
  document.getElementById('legend-bus').innerHTML = busSvg(15, '#2563EB');
  document.getElementById('legend-antenna').innerHTML = antennaSvg(15, '#2563EB');
  document.getElementById('mesh-map-antenna').innerHTML = antennaSvg(14, '#2563EB');
  document.getElementById('mesh-refresh-btn').addEventListener('click', refreshMeshDashboard);
  document.getElementById('mesh-prev-page').addEventListener('click', () => {
    meshPage = Math.max(0, meshPage - 1);
    renderMeshTable();
  });
  document.getElementById('mesh-next-page').addEventListener('click', () => {
    meshPage += 1;
    renderMeshTable();
  });
  await initMeshMap();
  await refreshMeshDashboard();
  setInterval(refreshMeshDashboard, 4000);
}

async function initMeshMap() {
  await loadGoogleMapsAPI();
  if (!window.google?.maps) return;
  meshMap = new google.maps.Map(document.getElementById('mesh-mini-map'), {
    center: { lat: 8.50, lng: 99.89 },
    zoom: 11,
    mapId: 'smart_songthaew_mesh',
    disableDefaultUI: true,
    zoomControl: true,
  });
}

async function refreshMeshDashboard() {
  try {
    const response = await fetch('/api/v1/network');
    if (!response.ok) throw new Error(`network ${response.status}`);
    meshData = await response.json();
    renderMeshSummary();
    renderMeshGraph();
    renderMeshMap();
    renderMeshTable();
    renderNetworkDetails();
  } catch (error) {
    console.error('[mesh]', error);
  }
}

function renderMeshSummary() {
  const meta = meshData?.meta || {};
  const links = meshData?.links || [];
  const totalVehicles = meta.total_vehicles || 0;
  const onlineVehicles = meta.online_vehicles || 0;
  const totalLinks = links.length;
  const direct = meta.direct_links || links.filter(link => link.type === 'direct').length;
  const relay = meta.relay_links || links.filter(link => link.type === 'relay').length;
  const health = Math.round(meshData?.health?.score ?? meshData?.health ?? 0);
  const pct = totalVehicles ? Math.round((onlineVehicles / totalVehicles) * 100) : 0;
  document.getElementById('mesh-online').textContent = `${onlineVehicles}/${totalVehicles}`;
  document.getElementById('mesh-online-sub').textContent = `${pct}%`;
  document.getElementById('mesh-total-links').textContent = totalLinks;
  document.getElementById('mesh-direct-links').textContent = direct;
  document.getElementById('mesh-direct-sub').textContent = `${totalLinks ? Math.round((direct / totalLinks) * 100) : 0}%`;
  document.getElementById('mesh-relay-links').textContent = relay;
  document.getElementById('mesh-relay-sub').textContent = `${totalLinks ? Math.round((relay / totalLinks) * 100) : 0}%`;
  document.getElementById('mesh-health').textContent = `${health}/100`;
  const donut = document.getElementById('mesh-health-donut');
  donut.style.setProperty('--value', health);
  donut.textContent = health;
  document.getElementById('mesh-updated').textContent = `อัปเดต ${formatTime(meshData?.server_time)}`;
}

function renderMeshGraph() {
  const canvas = document.getElementById('mesh-graph-canvas');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const nodes = meshData?.nodes || [];
  const links = meshData?.links || [];
  if (!nodes.length) {
    drawCentered(ctx, 'No data', width, height);
    return;
  }

  const positions = layoutNodes(nodes, width, height);
  links.forEach(link => drawLink(ctx, positions[link.from], positions[link.to], link));
  nodes.forEach(node => drawNode(ctx, positions[node.id], node));
}

function layoutNodes(nodes, width, height) {
  const positions = {};
  const station = nodes.find(node => node.type === 'ground_station');
  const vehicles = nodes.filter(node => node.type !== 'ground_station');
  if (station) positions[station.id] = { x: width / 2, y: height / 2 };
  const radius = Math.min(width, height) * 0.35;
  vehicles.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(vehicles.length, 1) - Math.PI / 2;
    const hopOffset = Math.min(60, (node.hop || 0) * 18);
    positions[node.id] = {
      x: width / 2 + Math.cos(angle) * (radius + hopOffset),
      y: height / 2 + Math.sin(angle) * (radius + hopOffset),
    };
  });
  return positions;
}

function drawLink(ctx, from, to, link) {
  if (!from || !to) return;
  const color = link.type === 'direct' ? '#16A34A' : link.hop > 1 ? '#FBBF24' : '#D97706';
  ctx.save();
  ctx.beginPath();
  if (link.type !== 'direct') ctx.setLineDash([8, 5]);
  if (link.to === 'GROUND_01') ctx.setLineDash([7, 5]);
  ctx.strokeStyle = link.to === 'GROUND_01' ? '#2563EB' : color;
  ctx.lineWidth = link.type === 'direct' ? 3 : 2;
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

function drawNode(ctx, pos, node) {
  if (!pos) return;
  const isStation = node.type === 'ground_station';
  const color = isStation ? '#2563EB' : node.status === 'online' ? '#16A34A' : '#6B7280';
  ctx.save();
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, isStation ? 24 : 20, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = '700 11px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(isStation ? 'ANT' : 'BUS', pos.x, pos.y + 4);
  ctx.fillStyle = '#334155';
  ctx.font = '700 12px Inter, sans-serif';
  ctx.fillText(node.label || node.vehicle_id || node.id, pos.x, pos.y + 38);
  ctx.restore();
}

function drawCentered(ctx, text, width, height) {
  ctx.fillStyle = '#64748B';
  ctx.font = '700 14px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, width / 2, height / 2);
}

function renderMeshMap() {
  if (!meshMap || !meshData) return;
  meshMapMarkers.forEach(marker => { marker.map = null; });
  meshMapMarkers = [];
  const bounds = new google.maps.LatLngBounds();
  (meshData.nodes || []).forEach(node => {
    if (!Number.isFinite(Number(node.lat)) || !Number.isFinite(Number(node.lng))) return;
    const position = { lat: Number(node.lat), lng: Number(node.lng) };
    bounds.extend(position);
    const marker = new google.maps.marker.AdvancedMarkerElement({
      map: meshMap,
      position,
      title: node.label || node.vehicle_id || node.id,
      content: node.type === 'ground_station'
        ? stationMarkerContent()
        : createVehicleMarkerContent(node.speed || 0, node.status === 'online', false, false, 0),
    });
    meshMapMarkers.push(marker);
  });
  if (!bounds.isEmpty()) meshMap.fitBounds(bounds, 40);
}

function stationMarkerContent() {
  const el = document.createElement('div');
  el.style.cssText = 'width:38px;height:38px;border-radius:50%;background:#2563EB;color:#fff;border:3px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 20px rgba(37,99,235,.35);';
  el.innerHTML = antennaSvg(20, '#fff');
  return el;
}

function renderMeshTable() {
  const body = document.getElementById('mesh-links-body');
  const links = meshData?.links || [];
  const start = meshPage * MESH_PAGE_SIZE;
  const page = links.slice(start, start + MESH_PAGE_SIZE);
  if (!page.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty-state">ยังไม่มีลิงก์เชื่อมต่อ</td></tr>';
    if (start >= links.length && meshPage > 0) meshPage = Math.max(0, meshPage - 1);
    return;
  }
  body.innerHTML = page.map((link, index) => `
    <tr>
      <td>${start + index + 1}</td>
      <td>${link.from}</td>
      <td>${link.to}</td>
      <td>${link.distance_m ?? '—'}</td>
      <td>${link.hop ?? 0}</td>
      <td><span class="small-badge ${link.status === 'good' ? 'status-online' : link.status === 'fair' ? 'status-warning' : 'status-offline'}">${link.status || '—'}</span></td>
      <td>${formatTime(link.last_seen)}</td>
    </tr>`).join('');
}

function renderNetworkDetails() {
  const nodes = meshData?.nodes || [];
  const links = meshData?.links || [];
  const online = nodes.filter(node => node.type === 'vehicle' && node.status === 'online').length;
  const vehicles = nodes.filter(node => node.type === 'vehicle').length;
  const avgHop = links.length ? links.reduce((sum, link) => sum + (Number(link.hop) || 0), 0) / links.length : 0;
  const avgLatency = links.map(link => Number(link.latency_ms)).filter(Number.isFinite);
  const latency = avgLatency.length ? Math.round(avgLatency.reduce((a, b) => a + b, 0) / avgLatency.length) : null;
  document.getElementById('network-details').innerHTML = [
    ['ความครอบคลุมเครือข่าย', vehicles ? `${Math.round((online / vehicles) * 100)}%` : '—'],
    ['ค่าเฉลี่ยจำนวนฮอป', avgHop.toFixed(1)],
    ['ค่าแฝงเฉลี่ย', latency != null ? `${latency} ms` : '—'],
    ['อัตราการสูญหายของแพ็กเก็ต', meshData?.health?.packet_loss != null ? `${meshData.health.packet_loss}%` : '—'],
    ['เวลาทำงานของเครือข่าย', meshData?.mode || 'waiting'],
  ].map(([label, value]) => `<div class="detail-row"><span>${label}</span><strong>${value}</strong></div>`).join('');

  document.getElementById('link-explanations').innerHTML = `
    <div class="legend-card"><strong>Direct Link</strong><div class="item-meta">รถเชื่อมต่อสถานีฐานโดยตรง</div></div>
    <div class="legend-card"><strong>Relay Link 1 hop</strong><div class="item-meta">รถส่งข้อมูลผ่านรถอีกคันหนึ่ง</div></div>
    <div class="legend-card"><strong>Relay Link 2+ hop</strong><div class="item-meta">ข้อมูลวิ่งผ่านหลายโหนดในโครงข่าย</div></div>
    <div class="legend-card"><strong>Station link</strong><div class="item-meta">เส้นเชื่อมกับสถานีฐาน</div></div>`;
}
