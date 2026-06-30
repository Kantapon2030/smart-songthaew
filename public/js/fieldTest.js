'use strict';

let fieldMap;
let fieldNodeSeq = 1;
let fieldMeasureMode = false;
let fieldRedrawTimer = null;
let fieldRealNetwork = null;

const fieldTestNodes = [];
const fieldMeasurePoints = [];
const fieldMarkers = new Map();
const fieldRangeRings = new Map();
const fieldLinkLines = [];
const fieldLinkLabels = [];
const fieldRealMarkers = [];
const fieldRealLines = [];
const fieldMeasureArtifacts = [];
const fieldLayers = {
  distance: true,
  rssi: false,
  snr: false,
  lq: true,
  hop: true,
  mode: 'all'
};

document.addEventListener('DOMContentLoaded', async () => {
  if (!await requireAuth()) return;
  renderSharedNavbar({ active: 'admin' });
  await initFieldTestMap();
  bindFieldTestControls();
  await loadSavedSessions();
});

async function initFieldTestMap() {
  await loadGoogleMapsAPI();
  const mapEl = document.getElementById('field-map');
  if (!window.google?.maps) {
    mapEl.textContent = 'Google Maps is not available.';
    return;
  }
  fieldMap = new google.maps.Map(mapEl, {
    center: { lat: 8.50, lng: 99.89 },
    zoom: 13,
    mapTypeId: 'hybrid',
    mapId: 'smart_songthaew_fieldtest',
    zoomControl: true,
    streetViewControl: false,
    fullscreenControl: true,
    gestureHandling: 'greedy'
  });
  fieldMap.addListener('click', event => {
    if (!event.latLng) return;
    const point = { lat: event.latLng.lat(), lng: event.latLng.lng() };
    if (fieldMeasureMode) {
      addMeasurePoint(point);
      return;
    }
    const label = document.getElementById('node-label-input').value.trim() || `Test ${fieldNodeSeq}`;
    placeTestNode(point.lat, point.lng, label);
  });
  setStatus('Satellite field test map ready.');
}

function bindFieldTestControls() {
  document.querySelectorAll('[data-layer]').forEach(input => {
    input.addEventListener('change', () => toggleLayer(input.dataset.layer, input.checked));
  });
  document.getElementById('mesh-mode-filter').addEventListener('change', event => {
    fieldLayers.mode = event.target.value;
    scheduleRenderTestLinks();
    renderRealNetworkOverlay();
  });
  document.getElementById('range-radius-input').addEventListener('change', () => {
    fieldTestNodes.forEach(node => drawRangeRing(node, currentRangeRadius()));
  });
  document.getElementById('load-real-btn').addEventListener('click', loadRealNetworkOverlay);
  document.getElementById('clear-test-btn').addEventListener('click', clearTestNodes);
  document.getElementById('measure-btn').addEventListener('click', () => {
    fieldMeasureMode = true;
    resetMeasurement();
    setStatus('Measurement mode: click two points on the map.');
  });
  document.getElementById('reset-measure-btn').addEventListener('click', resetMeasurement);
  document.getElementById('save-session-btn').addEventListener('click', saveTestSession);
  document.getElementById('load-session-btn').addEventListener('click', loadSelectedSession);
  document.getElementById('export-csv-btn').addEventListener('click', exportSessionCSV);
}

function placeTestNode(lat, lng, label) {
  if (!fieldMap || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
  const node = {
    id: `test_${Date.now()}_${fieldNodeSeq}`,
    label: String(label || `Test ${fieldNodeSeq}`),
    lat: Number(lat),
    lng: Number(lng),
    radiusMeters: currentRangeRadius(),
    type: 'test',
    createdAt: Date.now()
  };
  fieldNodeSeq += 1;
  fieldTestNodes.push(node);
  const marker = new google.maps.marker.AdvancedMarkerElement({
    map: fieldMap,
    position: { lat: node.lat, lng: node.lng },
    title: node.label,
    content: markerContent(node.label, 'test')
  });
  fieldMarkers.set(node.id, marker);
  drawRangeRing(node, node.radiusMeters);
  renderNodeList();
  scheduleRenderTestLinks();
  setStatus(`Placed ${node.label}.`);
  return node;
}

function removeTestNode(nodeId) {
  const index = fieldTestNodes.findIndex(node => node.id === nodeId);
  if (index < 0) return;
  const [node] = fieldTestNodes.splice(index, 1);
  fieldMarkers.get(node.id)?.setMap?.(null);
  if (fieldMarkers.get(node.id)) fieldMarkers.get(node.id).map = null;
  fieldMarkers.delete(node.id);
  fieldRangeRings.get(node.id)?.setMap(null);
  fieldRangeRings.delete(node.id);
  renderNodeList();
  scheduleRenderTestLinks();
}

function measureDistance(pointA, pointB) {
  if (typeof haversineKm !== 'function') return null;
  return haversineKm(pointA.lat, pointA.lng, pointB.lat, pointB.lng) * 1000;
}

function drawRangeRing(node, radiusMeters) {
  if (!fieldMap || !node) return;
  const radius = Math.max(50, Number(radiusMeters) || currentRangeRadius());
  node.radiusMeters = radius;
  fieldRangeRings.get(node.id)?.setMap(null);
  const ring = new google.maps.Circle({
    map: fieldMap,
    center: { lat: node.lat, lng: node.lng },
    radius,
    strokeColor: '#2563EB',
    strokeOpacity: 0.55,
    strokeWeight: 1.5,
    fillColor: '#2563EB',
    fillOpacity: 0.08
  });
  fieldRangeRings.set(node.id, ring);
}

function renderTestLinks() {
  clearTestLinks();
  if (!fieldMap) return;
  if (fieldTestNodes.length > 30) {
    setStatus('Node count is above 30; redraw is throttled to protect the browser.');
  }
  if (!modeAllows('estimated')) return;
  const links = buildEstimatedTestLinks();
  links.forEach(link => drawFieldLink(link, 'estimated'));
  updateModeBadge();
}

function toggleLayer(layerName, visible) {
  if (!Object.prototype.hasOwnProperty.call(fieldLayers, layerName)) return;
  fieldLayers[layerName] = Boolean(visible);
  scheduleRenderTestLinks();
  renderRealNetworkOverlay();
}

async function loadRealNetworkOverlay() {
  try {
    const response = await authFetch('/api/v1/network');
    if (!response || !response.ok) throw new Error(`network ${response?.status || 'failed'}`);
    fieldRealNetwork = await response.json();
    renderRealNetworkOverlay();
    setStatus(`Loaded real network overlay: ${fieldRealNetwork.nodes?.length || 0} nodes.`);
  } catch (error) {
    setStatus(`Cannot load real network overlay: ${error.message}`);
  }
}

async function saveTestSession() {
  const links = buildEstimatedTestLinks();
  const payload = {
    sessionName: document.getElementById('session-name-input').value.trim() || `Field test ${new Date().toLocaleString()}`,
    notes: document.getElementById('session-notes-input').value.trim(),
    nodes: fieldTestNodes.map(node => ({ ...node })),
    links
  };
  try {
    const response = await authFetch('/api/v1/fieldtest/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response || !response.ok) throw new Error(`save ${response?.status || 'failed'}`);
    const data = await response.json();
    setStatus(`Saved session ${data.sessionId}.`);
    await loadSavedSessions(data.sessionId);
  } catch (error) {
    setStatus(`Save failed: ${error.message}`);
  }
}

function exportSessionCSV() {
  const rows = [['type', 'id', 'label', 'lat', 'lng', 'from', 'to', 'distance_m', 'mode']];
  fieldTestNodes.forEach(node => rows.push(['node', node.id, node.label, node.lat, node.lng, '', '', '', 'test']));
  buildEstimatedTestLinks().forEach(link => rows.push(['link', '', '', '', '', link.from, link.to, link.distance_m, 'estimated']));
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fieldtest-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function scheduleRenderTestLinks() {
  const delay = fieldTestNodes.length > 30 ? 500 : 80;
  clearTimeout(fieldRedrawTimer);
  fieldRedrawTimer = setTimeout(renderTestLinks, delay);
}

function buildEstimatedTestLinks() {
  const links = [];
  for (let i = 0; i < fieldTestNodes.length; i++) {
    for (let j = i + 1; j < fieldTestNodes.length; j++) {
      const a = fieldTestNodes[i];
      const b = fieldTestNodes[j];
      const distance = measureDistance(a, b);
      if (!Number.isFinite(distance)) continue;
      links.push({
        from: a.id,
        to: b.id,
        type: 'estimated',
        source: 'estimated',
        distance_m: Math.round(distance),
        status: distance < 500 ? 'good' : distance < 2000 ? 'fair' : 'poor',
        hop: distance < 2000 ? 0 : 1,
        rssi: null,
        snr: null,
        link_quality: estimatedLinkQuality(distance),
        relay_chain: distance < 2000 ? [] : [a.label, b.label]
      });
    }
  }
  return links;
}

function drawFieldLink(link, mode) {
  if (!modeAllows(mode)) return;
  const from = nodePosition(link.from);
  const to = nodePosition(link.to);
  if (!from || !to) return;
  const style = linkStyle(link, mode);
  const line = new google.maps.Polyline({
    map: fieldMap,
    path: [from, to],
    strokeColor: style.color,
    strokeOpacity: style.opacity,
    strokeWeight: style.weight,
    icons: style.dash ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 2 }, offset: '0', repeat: '10px' }] : undefined
  });
  if (style.dash) line.setOptions({ strokeOpacity: 0 });
  fieldLinkLines.push(line);
  const label = buildLinkLabel(link, mode);
  if (label) {
    const marker = new google.maps.marker.AdvancedMarkerElement({
      map: fieldMap,
      position: midpoint(from, to),
      content: labelContent(label)
    });
    fieldLinkLabels.push(marker);
  }
}

function renderRealNetworkOverlay() {
  clearRealOverlay();
  if (!fieldMap || !fieldRealNetwork || !modeAllows('real')) {
    updateModeBadge();
    return;
  }
  const nodes = fieldRealNetwork.nodes || [];
  nodes.forEach(node => {
    if (!Number.isFinite(Number(node.lat)) || !Number.isFinite(Number(node.lng))) return;
    const marker = new google.maps.marker.AdvancedMarkerElement({
      map: fieldMap,
      position: { lat: Number(node.lat), lng: Number(node.lng) },
      title: node.label || node.vehicle_id || node.id,
      content: markerContent(node.label || node.vehicle_id || node.id, node.type === 'ground_station' ? 'ground' : 'real')
    });
    fieldRealMarkers.push(marker);
  });
  (fieldRealNetwork.links || []).forEach(link => drawRealLink(link, nodes));
  updateModeBadge();
}

function drawRealLink(link, nodes) {
  const from = realNodePosition(link.from, nodes);
  const to = realNodePosition(link.to, nodes);
  if (!from || !to) return;
  const style = linkStyle(link, 'real');
  const line = new google.maps.Polyline({
    map: fieldMap,
    path: [from, to],
    strokeColor: style.color,
    strokeOpacity: style.opacity,
    strokeWeight: style.weight
  });
  fieldRealLines.push(line);
  const label = buildLinkLabel(link, 'real');
  if (label) {
    const marker = new google.maps.marker.AdvancedMarkerElement({
      map: fieldMap,
      position: midpoint(from, to),
      content: labelContent(label)
    });
    fieldRealMarkers.push(marker);
  }
}

async function loadSavedSessions(selectedId = '') {
  try {
    const response = await authFetch('/api/v1/fieldtest/sessions');
    if (!response || !response.ok) return;
    const data = await response.json();
    const select = document.getElementById('session-select');
    const sessions = data.sessions || [];
    select.innerHTML = '<option value="">Saved sessions</option>' + sessions
      .map(session => `<option value="${escapeHtml(session.sessionId)}">${escapeHtml(session.sessionName || session.sessionId)}</option>`)
      .join('');
    if (selectedId) select.value = selectedId;
  } catch (_) {}
}

async function loadSelectedSession() {
  const id = document.getElementById('session-select').value;
  if (!id) return;
  try {
    const response = await authFetch(`/api/v1/fieldtest/session/${encodeURIComponent(id)}`);
    if (!response || !response.ok) throw new Error(`load ${response?.status || 'failed'}`);
    const data = await response.json();
    clearTestNodes();
    document.getElementById('session-name-input').value = data.sessionName || '';
    document.getElementById('session-notes-input').value = data.notes || '';
    (data.nodes || []).forEach(node => placeTestNode(Number(node.lat), Number(node.lng), node.label || node.id));
    setStatus(`Loaded session ${id}.`);
  } catch (error) {
    setStatus(`Load failed: ${error.message}`);
  }
}

function addMeasurePoint(point) {
  fieldMeasurePoints.push(point);
  const marker = new google.maps.Marker({
    map: fieldMap,
    position: point,
    label: String(fieldMeasurePoints.length)
  });
  fieldMeasureArtifacts.push(marker);
  if (fieldMeasurePoints.length === 2) {
    const [a, b] = fieldMeasurePoints;
    const distance = measureDistance(a, b);
    const line = new google.maps.Polyline({
      map: fieldMap,
      path: [a, b],
      strokeColor: '#111827',
      strokeOpacity: 0.9,
      strokeWeight: 2
    });
    fieldMeasureArtifacts.push(line);
    document.getElementById('measure-output').textContent = `Measured distance: ${formatMeters(distance)}`;
    fieldMeasureMode = false;
  }
}

function resetMeasurement() {
  fieldMeasurePoints.splice(0);
  fieldMeasureArtifacts.forEach(item => item.setMap?.(null));
  fieldMeasureArtifacts.splice(0);
  document.getElementById('measure-output').textContent = 'No measurement yet.';
}

function clearTestNodes() {
  [...fieldTestNodes].forEach(node => removeTestNode(node.id));
  fieldTestNodes.splice(0);
  clearTestLinks();
  renderNodeList();
}

function clearTestLinks() {
  fieldLinkLines.forEach(line => line.setMap(null));
  fieldLinkLabels.forEach(marker => { marker.map = null; });
  fieldLinkLines.splice(0);
  fieldLinkLabels.splice(0);
}

function clearRealOverlay() {
  fieldRealLines.forEach(line => line.setMap(null));
  fieldRealMarkers.forEach(marker => { marker.map = null; });
  fieldRealLines.splice(0);
  fieldRealMarkers.splice(0);
}

function currentRangeRadius() {
  return Math.max(50, Number(document.getElementById('range-radius-input')?.value) || 1000);
}

function nodePosition(nodeId) {
  const node = fieldTestNodes.find(item => item.id === nodeId);
  return node ? { lat: node.lat, lng: node.lng } : null;
}

function realNodePosition(nodeId, nodes) {
  const node = nodes.find(item => item.id === nodeId || item.vehicle_id === nodeId);
  if (!node) return null;
  const lat = Number(node.lat);
  const lng = Number(node.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function midpoint(a, b) {
  return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
}

function modeAllows(mode) {
  return fieldLayers.mode === 'all' || fieldLayers.mode === mode;
}

function linkStyle(link, mode) {
  const status = link.status || 'offline';
  const color = mode === 'real'
    ? (status === 'good' ? '#16a34a' : status === 'fair' ? '#d97706' : '#dc2626')
    : (status === 'good' ? '#2563eb' : status === 'fair' ? '#f59e0b' : '#64748b');
  return {
    color,
    weight: mode === 'real' ? 2.5 : 1.8,
    opacity: mode === 'real' ? 0.82 : 0.62,
    dash: mode === 'estimated'
  };
}

function buildLinkLabel(link, mode) {
  const parts = [];
  if (fieldLayers.distance) parts.push(formatMeters(link.distance_m));
  if (fieldLayers.rssi) parts.push(`RSSI ${link.rssi ?? 'estimated'}`);
  if (fieldLayers.snr) parts.push(`SNR ${link.snr ?? 'estimated'}`);
  if (fieldLayers.lq) parts.push(`LQ ${link.link_quality ?? link.status ?? 'n/a'}`);
  if (fieldLayers.hop) parts.push(`hop ${link.hop ?? 0}${link.relay_chain?.length ? ` via ${link.relay_chain.join('>')}` : ''}`);
  if (!parts.length) return '';
  return `${mode === 'estimated' ? 'estimated' : 'real'} | ${parts.join(' | ')}`;
}

function markerContent(label, type) {
  const el = document.createElement('div');
  el.className = `field-marker ${type || ''}`;
  el.textContent = String(label || '?').slice(0, 8);
  return el;
}

function labelContent(text) {
  const el = document.createElement('div');
  el.className = 'field-label';
  el.textContent = text;
  return el;
}

function estimatedLinkQuality(distanceMeters) {
  if (distanceMeters < 500) return 90;
  if (distanceMeters < 1000) return 75;
  if (distanceMeters < 2000) return 55;
  if (distanceMeters < 5000) return 35;
  return 15;
}

function formatMeters(meters) {
  const value = Number(meters);
  if (!Number.isFinite(value)) return '-';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${Math.round(value)} m`;
}

function renderNodeList() {
  const root = document.getElementById('test-node-list');
  if (!root) return;
  root.innerHTML = fieldTestNodes.length ? fieldTestNodes.map(node => `
    <div class="field-node-row">
      <span><strong>${escapeHtml(node.label)}</strong><br/><code>${node.lat.toFixed(6)}, ${node.lng.toFixed(6)} | ${formatMeters(node.radiusMeters)}</code></span>
      <button class="button ghost" type="button" onclick="removeTestNode('${node.id}')">Remove</button>
    </div>
  `).join('') : '<div class="empty-state">No test nodes yet.</div>';
}

function updateModeBadge() {
  const badge = document.getElementById('field-mode-badge');
  const hasReal = Boolean(fieldRealNetwork && modeAllows('real'));
  badge.textContent = hasReal
    ? 'Mesh View: real telemetry overlay plus estimated GPS-distance test links'
    : 'Mesh View: estimated from GPS distance';
}

function setStatus(text) {
  const el = document.getElementById('field-status');
  if (el) el.textContent = text;
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
