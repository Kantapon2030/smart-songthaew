const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const mockVehicles = [
  {
    vehicleId: 'BUS_01',
    lat: 8.4304,
    lng: 99.9631,
    timestamp: Date.UTC(2026, 6, 9, 1, 0, 0),
    speed: 28,
    heading: 90,
    battery: 91,
    battVoltage: 12.7,
    packetId: 'PKT_BUS_01_001',
    rssi: -82,
    snr: 8.5,
  },
  {
    vehicleId: 'BUS_02',
    lat: 8.4421,
    lng: 99.9684,
    timestamp: Date.UTC(2026, 6, 9, 1, 1, 0),
    speed: 22,
    heading: 110,
    battery: 74,
    battVoltage: 12.2,
    packetId: 'PKT_BUS_02_001',
    rssi: -94,
    snr: 5.2,
  },
  {
    vehicleId: 'BUS_03',
    lat: 8.4189,
    lng: 99.9515,
    timestamp: Date.UTC(2026, 6, 9, 1, 2, 0),
    speed: 0,
    heading: 0,
    battery: 64,
    battVoltage: 11.9,
    packetId: 'PKT_BUS_03_001',
    rssi: -103,
    snr: 2.1,
  },
];

function validateVehicleTelemetry(vehicle) {
  const errors = [];
  if (!vehicle.vehicleId) errors.push('vehicleId is required');
  if (!Number.isFinite(vehicle.lat)) errors.push('lat is required');
  if (!Number.isFinite(vehicle.lng)) errors.push('lng is required');
  if (!Number.isFinite(vehicle.timestamp)) errors.push('timestamp is required');
  if (!Number.isFinite(vehicle.battery) || vehicle.battery < 0 || vehicle.battery > 100) {
    errors.push('battery must be 0..100');
  }
  if (vehicle.lat < 5.5 || vehicle.lat > 20.5 || vehicle.lng < 97.5 || vehicle.lng > 105.7) {
    errors.push('coordinates must be inside Thailand bounds');
  }
  return errors;
}

function duplicatePacketIds(vehicles) {
  const seen = new Set();
  const duplicates = new Set();
  vehicles.forEach(vehicle => {
    if (!vehicle.packetId) return;
    if (seen.has(vehicle.packetId)) duplicates.add(vehicle.packetId);
    seen.add(vehicle.packetId);
  });
  return [...duplicates];
}

function haversineMeters(a, b) {
  const radius = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(x));
}

function batterySummary(samples) {
  const sorted = [...samples].sort((a, b) => a.ts - b.ts);
  const start = sorted[0];
  const end = sorted[sorted.length - 1];
  const durationHours = (end.ts - start.ts) / 3600000;
  const dropPerHour = durationHours > 0 ? (start.battery - end.battery) / durationHours : 0;
  return {
    startPct: start.battery,
    endPct: end.battery,
    dropPerDay: Number((dropPerHour * 24).toFixed(2)),
  };
}

function csvFromBatterySamples(vehicleId, startDate, endDate, samples) {
  const rows = [
    ['vehicleId', 'rangeStart', 'rangeEnd', 'sampleDate', 'time', 'battery', 'battVoltage'],
    ...samples.map(sample => [
      vehicleId,
      startDate,
      endDate,
      sample.date,
      sample.time,
      sample.battery,
      sample.battVoltage,
    ]),
  ];
  return rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n');
}

test('API routes for vehicle tracking and diagnostics are registered', () => {
  const server = read('server.js');
  [
    "app.post('/api/update-location'",
    "app.get('/api/locations'",
    "app.get('/api/diagnostics/battery-log'",
    "app.get('/api/diagnostics/lora-signal'",
    "app.post('/api/diagnostics/pdr-test'",
    "app.get('/api/diagnostics/pdr-test/:sessionId'",
    "app.post('/api/diagnostics/pdr-test/:sessionId/stop'",
  ].forEach(route => assert.ok(server.includes(route), `missing ${route}`));
});

test('mock vehicle telemetry schema accepts 3 valid vehicles', () => {
  mockVehicles.forEach(vehicle => {
    assert.deepEqual(validateVehicleTelemetry(vehicle), []);
  });
});

test('mock vehicle telemetry schema rejects invalid and missing data', () => {
  assert.ok(validateVehicleTelemetry({ ...mockVehicles[0], lat: undefined }).includes('lat is required'));
  assert.ok(validateVehicleTelemetry({ ...mockVehicles[0], lng: undefined }).includes('lng is required'));
  assert.ok(validateVehicleTelemetry({ ...mockVehicles[0], timestamp: undefined }).includes('timestamp is required'));
  assert.ok(validateVehicleTelemetry({ ...mockVehicles[0], battery: 130 }).includes('battery must be 0..100'));
});

test('duplicate packetId is detected in mock telemetry', () => {
  const vehicles = [
    ...mockVehicles,
    { ...mockVehicles[2], vehicleId: 'BUS_03_REPLAY', packetId: 'PKT_BUS_01_001' },
  ];
  assert.deepEqual(duplicatePacketIds(vehicles), ['PKT_BUS_01_001']);
});

test('mock API locations response remains array-based for map rendering', () => {
  const response = mockVehicles.map(vehicle => ({
    vehicleId: vehicle.vehicleId,
    lat: vehicle.lat,
    lng: vehicle.lng,
    speed: vehicle.speed,
    heading: vehicle.heading,
    battery: vehicle.battery,
    timestamp: vehicle.timestamp,
  }));
  assert.ok(Array.isArray(response));
  assert.equal(response.length, 3);
  response.forEach(item => assert.equal(typeof item.vehicleId, 'string'));
});

test('route distance calculation returns a plausible mock distance', () => {
  const distance = haversineMeters(mockVehicles[0], mockVehicles[1]);
  assert.ok(distance > 1000);
  assert.ok(distance < 3000);
});

test('Field Test & Diagnostics UI hooks exist', () => {
  const adminHtml = read('public/admin.html');
  const adminJs = read('public/js/admin.js');
  [
    'diagnostics-card',
    'diag-battery-start-date',
    'diag-battery-end-date',
    'diag-lora-chart',
    'diag-pdr-active',
  ].forEach(id => assert.ok(adminHtml.includes(id), `missing #${id}`));
  [
    'loadBatteryDiagnostics',
    'loadLoraDiagnostics',
    'startPdrDiagnostics',
    'exportBatteryCsv',
  ].forEach(fn => assert.ok(adminJs.includes(`function ${fn}`) || adminJs.includes(`async function ${fn}`), `missing ${fn}`));
});

test('battery and voltage summary supports multi-day mock samples', () => {
  const samples = [
    { ts: Date.UTC(2026, 6, 7, 0), battery: 91, battVoltage: 12.7 },
    { ts: Date.UTC(2026, 6, 8, 0), battery: 85, battVoltage: 12.4 },
    { ts: Date.UTC(2026, 6, 9, 0), battery: 79, battVoltage: 12.1 },
  ];
  assert.deepEqual(batterySummary(samples), {
    startPct: 91,
    endPct: 79,
    dropPerDay: 6,
  });
});

test('CSV export format includes date range and sample date', () => {
  const csv = csvFromBatterySamples('BUS_01', '2026-07-07', '2026-07-09', [
    { date: '2026-07-07', time: '2026-07-07 08:00', battery: 91, battVoltage: 12.7 },
  ]);
  assert.ok(csv.startsWith('"vehicleId","rangeStart","rangeEnd","sampleDate","time","battery","battVoltage"'));
  assert.ok(csv.includes('"BUS_01","2026-07-07","2026-07-09","2026-07-07"'));
});

test('static pages include viewport metadata and responsive styles exist', () => {
  ['public/index.html', 'public/dashboard.html', 'public/admin.html'].forEach(file => {
    assert.ok(read(file).includes('name="viewport"'), `${file} missing viewport meta`);
  });
  assert.ok(read('public/css/style.css').includes('@media'));
  assert.ok(read('public/admin.html').includes('@media'));
});

test('passenger home exposes live tracking and accessible planner controls', () => {
  const home = read('public/index.html');
  const app = read('public/js/app.js');
  const css = read('public/css/style.css');
  ['home-live-status', 'home-live-copy', 'home-live-dot', 'planner-toggle-btn', 'aria-controls="journey-planner"'].forEach(hook => {
    assert.ok(home.includes(hook), `missing passenger UI hook: ${hook}`);
  });
  assert.ok(app.includes('function updateHomeLiveStatus'));
  assert.ok(css.includes('--motion-base'));
  assert.ok(css.includes('prefers-reduced-motion'));
});

test('mobile passenger tools expose top route tab, floating location actions, and vehicle summary', () => {
  const home = read('public/index.html');
  const app = read('public/js/app.js');
  [
    'mobile-sheet-essential',
    'mobile-sheet-expanded',
    'mobile-vehicle-slot',
    'desktop-vehicle-anchor',
    'pin-picking-banner',
    'cancel-pin-pick-btn',
    'vehicle-arrival',
  ].forEach(hook => assert.ok(home.includes(hook), `missing unified sheet hook: ${hook}`));
  assert.ok(home.indexOf('location-control-row') < home.indexOf('mobile-sheet-expanded'));
  assert.ok(home.includes('top: calc(var(--nav-height) + 12px);'));
  assert.ok(home.includes('right: 86px;'));
  assert.ok(home.includes('grid-template-columns: 54px;'));
  assert.ok(home.includes('bottom: calc(64px + env(safe-area-inset-bottom, 0px) + 8px);'));
  [
    "let mobileSheetState = 'collapsed'",
    'function setMobileSheetState',
    'function syncVehicleCardPlacement',
    'function directionDestinationLabel',
    'function formatArrivalTime',
    'function targetSvg',
    "setMobileSheetState('pin-picking')",
  ].forEach(hook => assert.ok(app.includes(hook), `missing mobile sheet behavior: ${hook}`));
  assert.ok(app.includes("desktopAnchor.insertAdjacentElement('afterend', card)"));
});
