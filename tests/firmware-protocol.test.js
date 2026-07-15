const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function relaySlot(packetHash, vehicleNumber, slotCount = 3) {
  return (Number.parseInt(packetHash, 16) + vehicleNumber - 1) % slotCount;
}

function simulateGroundQueue({ cycles, outageCycles = 0, arrivalsPerCycle = 3, batchSize = 6, capacity = 40 }) {
  let depth = 0;
  let dropped = 0;
  for (let cycle = 0; cycle < cycles; cycle++) {
    depth += arrivalsPerCycle;
    if (depth > capacity) {
      dropped += depth - capacity;
      depth = capacity;
    }
    if (cycle >= outageCycles) depth = Math.max(0, depth - batchSize);
  }
  return { depth, dropped };
}

test('firmware profile is fixed to three vehicles and ten seconds', () => {
  const config = read('mesh_config.h');
  assert.match(config, /#define VEHICLE_COUNT\s+3\b/);
  assert.match(config, /#define TX_INTERVAL_MS\s+10000UL/);
  assert.match(config, /#define MAX_HOPS\s+2\b/);
  assert.match(config, /#define BUFFER_SIZE\s+40\b/);
});

test('protocol v2 preserves packet hash and makes store-forward explicit', () => {
  const vehicle = read('Songthaew_V03_vehicle.ino');
  assert.ok(vehicle.includes('doc["pv"] = 2'));
  assert.ok(vehicle.includes('doc["sf"] = storeForward ? 1 : 0'));
  assert.ok(vehicle.includes('originalPacketHash'));
  assert.ok(vehicle.includes('doc["ph"] | ""'));
});

test('relay contention slots rotate uniquely for all three vehicles', () => {
  ['000000', '12AB34', 'FFFFFF'].forEach(hash => {
    const slots = [1, 2, 3].map(vehicle => relaySlot(hash, vehicle));
    assert.equal(new Set(slots).size, 3);
  });
});

test('vehicle relay is queued and restricted to store-forward requests', () => {
  const vehicle = read('Songthaew_V03_vehicle.ino');
  assert.ok(vehicle.includes('if (!explicitlyAddressed && !storeForwardRequested) return false'));
  assert.ok(vehicle.includes('queuePendingRelay(packetId, payload'));
  assert.ok(vehicle.includes('cancelPendingRelay(pid)'));
  assert.ok(!vehicle.includes('bool sent = built && sendRawPayload(payload);\n  if (!hasForwardPath() || !sent)'));
});

test('forced-hop test is opt-in and preserves the BUS_03 to BUS_02 to BUS_01 route', () => {
  const config = read('mesh_config.h');
  const vehicle = read('Songthaew_V03_vehicle.ino');
  const ground = read('Songthaew_V03_ground.ino');
  assert.match(config, /#define FORCED_HOP_TEST_ENABLED\s+0\b/);
  assert.match(config, /#define FORCED_HOP_TEST_SOURCE\s+"BUS_03"/);
  assert.match(config, /#define FORCED_HOP_TEST_RELAY_1\s+"BUS_02"/);
  assert.match(config, /#define FORCED_HOP_TEST_RELAY_2\s+"BUS_01"/);
  assert.match(config, /#define FORCED_HOP_TEST_RX_EXTRA_MS\s+1500UL/);
  assert.match(config, /#define FORCED_HOP_TEST_RELAY_DELAY_MS\s+400UL/);
  assert.ok(vehicle.includes('doc["ft"] = 1'));
  assert.ok(vehicle.includes('doc["fc"] = 1'));
  assert.ok(vehicle.includes('doc["to"] = relayToShort'));
  assert.ok(vehicle.includes('if (!forcedHopTest && measureJson(doc) < 140)'));
  assert.ok(vehicle.includes('ignore non-target'));
  assert.ok(vehicle.includes('bool compactListContains'));
  assert.ok(vehicle.includes('compactListContains(out, shortId)'));
  assert.ok(vehicle.includes('millis() + FORCED_HOP_TEST_RELAY_DELAY_MS'));
  assert.ok(vehicle.includes('stale state; forwarding assigned packet'));
  assert.ok(vehicle.includes('if (!stateUpdated && !forcedHopTest) return'));
  assert.ok(vehicle.includes('hop != 1 || !sameId(relayFrom, FORCED_HOP_TEST_RELAY_1)'));
  assert.ok(ground.includes('ignore intermediate'));
  assert.ok(ground.includes('isValidForcedHopCompletion'));
  assert.ok(ground.includes('FORCED_HOP_TEST_RX_EXTRA_MS'));
  assert.ok(ground.includes('[HOP_TEST] RX window:%lums'));
  assert.ok(ground.includes('reject invalid completion'));
  assert.ok(ground.includes('[HOP_TEST] PASS'));
});

test('vehicle transmission epoch follows the ground beacon only', () => {
  const vehicle = read('Songthaew_V03_vehicle.ino');
  assert.ok(vehicle.includes('syncTxSlotFromBeacon(millis())'));
  assert.ok(vehicle.includes('nextTxMode = "beacon"'));
  assert.ok(!vehicle.includes('gpsTxSlotDue'));
  assert.ok(!vehicle.includes('processPpsSync'));
});

test('ground queue survives a two minute outage and drains afterward', () => {
  const duringOutage = simulateGroundQueue({ cycles: 12, outageCycles: 12 });
  assert.deepEqual(duringOutage, { depth: 36, dropped: 0 });
  const recovered = simulateGroundQueue({ cycles: 24, outageCycles: 12 });
  assert.deepEqual(recovered, { depth: 0, dropped: 0 });
});

test('ground batch endpoint and key provisioning are registered', () => {
  const server = read('server.js');
  assert.ok(server.includes("app.post('/api/v1/ground/telemetry-batch'"));
  assert.ok(server.includes("app.post('/api/v1/admin/ground-keys/:groundId'"));
  assert.ok(server.includes("req.get('X-Ground-Key')"));
  assert.ok(server.includes('calculateBatteryFromRaw('));
});

test('ground flush does not force Wi-Fi offline after success', () => {
  const ground = read('Songthaew_V03_ground.ino');
  const flushStart = ground.indexOf('void flushBuffer(');
  const serviceStart = ground.indexOf('void serviceWiFi(', flushStart);
  const flushBody = ground.slice(flushStart, serviceStart);
  assert.ok(!flushBody.includes('wifiConnected = false'));
  assert.ok(flushBody.includes('postBatchToServer(body)'));
});
