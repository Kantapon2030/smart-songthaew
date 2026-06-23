// VIBE Mesh Network Overlay for Passenger Map.
// Feature-flagged: off by default, must be explicitly enabled.
(function () {
  'use strict';

  let overlayEnabled = false;
  let polylines = [];
  let infoWindows = [];
  let pollInterval = null;
  let mapInstance = null;

  const POLL_MS = 5000;

  window.MeshOverlay = {
    init(map) { mapInstance = map; },
    toggle() { overlayEnabled ? disable() : enable(); return overlayEnabled; },
    isEnabled() { return overlayEnabled; }
  };

  function enable() {
    overlayEnabled = true;
    fetchAndRender();
    pollInterval = setInterval(fetchAndRender, POLL_MS);
    console.log('[MeshOverlay] enabled');
  }

  function disable() {
    overlayEnabled = false;
    clearInterval(pollInterval);
    pollInterval = null;
    clearMeshOverlay();
    console.log('[MeshOverlay] disabled');
  }

  async function fetchNetwork() {
    const res = await fetch('/api/v1/network');
    if (!res.ok) throw new Error('network fetch failed: ' + res.status);
    return res.json();
  }

  function clearMeshOverlay() {
    polylines.forEach(p => p.setMap(null));
    infoWindows.forEach(w => w.close());
    polylines = [];
    infoWindows = [];
  }

  function getLinkStyle(link) {
    const styles = {
      good: { color: '#22c55e', weight: 2.5, opacity: 0.8, dash: null },
      fair: { color: '#f59e0b', weight: 2, opacity: 0.7, dash: '8 4' },
      poor: { color: '#ef4444', weight: 1.5, opacity: 0.6, dash: '4 4' },
      offline: { color: '#9ca3af', weight: 1, opacity: 0.4, dash: '2 6' }
    };
    return styles[link.status] || styles.offline;
  }

  function formatDistance(meters) {
    if (meters === null || meters === undefined) return '?';
    return meters >= 1000
      ? (meters / 1000).toFixed(1) + ' km'
      : Math.round(meters) + ' m';
  }

  function getNodeLatLng(nodeId, nodes) {
    const node = nodes.find(item => item.id === nodeId);
    if (!node || node.lat === null || node.lng === null) return null;
    return { lat: node.lat, lng: node.lng };
  }

  function renderMeshOverlay(data) {
    if (!mapInstance) return;
    clearMeshOverlay();

    const { nodes, links, mode } = data;
    links.forEach(link => {
      const fromPos = getNodeLatLng(link.from, nodes);
      const toPos = getNodeLatLng(link.to, nodes);
      if (!fromPos || !toPos) return;

      const style = getLinkStyle(link);
      const lineOpts = {
        path: [fromPos, toPos],
        strokeColor: style.color,
        strokeWeight: style.weight,
        strokeOpacity: style.opacity,
        map: mapInstance
      };
      if (style.dash) {
        lineOpts.icons = [{
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 2 },
          offset: '0',
          repeat: style.dash.replace(' ', 'px ') + 'px'
        }];
        lineOpts.strokeOpacity = 0;
      }

      const polyline = new google.maps.Polyline(lineOpts);
      const midLat = (fromPos.lat + toPos.lat) / 2;
      const midLng = (fromPos.lng + toPos.lng) / 2;
      const label = formatDistance(link.distance_m) +
        (link.hop > 0 ? ' | hop ' + link.hop : ' | direct') +
        (mode === 'estimated' ? ' ~' : '');
      const infoWindow = new google.maps.InfoWindow({
        content: '<div style="font-size:11px;color:' + style.color + ';font-weight:500">' + label + '</div>',
        position: { lat: midLat, lng: midLng },
        disableAutoPan: true
      });
      infoWindow.open(mapInstance);

      polylines.push(polyline);
      infoWindows.push(infoWindow);
    });
  }

  async function fetchAndRender() {
    if (!overlayEnabled || !mapInstance) return;
    try {
      const data = await fetchNetwork();
      renderMeshOverlay(data);
    } catch (error) {
      console.warn('[MeshOverlay] fetch error:', error.message);
    }
  }
})();
