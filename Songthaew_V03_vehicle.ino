// Songthaew_V03_vehicle.ino
/*
  Smart Songthaew VIBE Mesh - Vehicle Firmware V03

  ESP8266 NodeMCU -> SX1276 Ra-02
  D5 (GPIO14) -> SCK
  D6 (GPIO12) -> MISO
  D7 (GPIO13) -> MOSI
  D8 (GPIO15) -> NSS/CS
  D0 (GPIO16) -> RESET
  D2 (GPIO4)  -> DIO0
  3V3         -> VCC
  GND         -> GND

  ESP8266 NodeMCU -> NEO-6M GPS
  D4 (GPIO2)  -> GPS TX (we receive)
  D1 (GPIO5)  -> GPS PPS / 1PPS
  3V3         -> VCC
  GND         -> GND
  GPS RX is not connected

  Battery sense voltage divider:
  BAT+ -> 330k ohm -> A0 -> 82k ohm -> GND
  100nF capacitor across 82k ohm
*/

#include <Arduino.h>
#include <ArduinoJson.h>
#include <LoRa.h>
#include <SoftwareSerial.h>
#include <SPI.h>
#include <TinyGPS++.h>
#include <ESP8266WiFi.h>
#include <math.h>
#if __has_include("songthaew_secrets.h")
#include "songthaew_secrets.h"
#else
#error "Create songthaew_secrets.h from songthaew_secrets.example.h before flashing."
#endif
#include "mesh_config.h"

struct Neighbor {
  char vehicleId[16];
  float rssi;
  float snr;
  unsigned long lastSeen;
  float lat;
  float lng;
  int hop;
};

struct VehicleState {
  char vehicleId[16];
  char bootId[5];
  char packetId[40];
  uint32_t seq;
  uint32_t gpsTs;
  float lat;
  float lng;
  float speed;
  int heading;
  int battery;
  int hop;
  bool gpsFix;
  bool used;
  unsigned long lastSeen;
};

struct CarryPacket {
  char packetId[40];
  char payload[MAX_LORA_PACKET_BYTES + 1];
  bool used;
  uint8_t attempts;
  unsigned long queuedAt;
  unsigned long lastAttempt;
};

TinyGPSPlus gps;
SoftwareSerial gpsSerial(GPS_RX_PIN, -1);

Neighbor neighbors[MAX_NEIGHBORS];
int neighborCount = 0;

VehicleState sharedStates[SHARED_STATE_SIZE];
CarryPacket carryBuffer[CARRY_BUFFER_SIZE];

char seenPackets[DEDUP_BUFFER][40];
int seenIdx = 0;

char bootId[5] = "0000";
uint32_t seq = 0;

float gpsLat = 0.0f;
float gpsLng = 0.0f;
float gpsSpeed = 0.0f;
float gpsHeading = 0.0f;
uint32_t gpsSats = 0;
float gpsHdop = 99.9f;
bool gpsValid = false;
bool gpsTimeValid = false;
bool gpsTimestampValid = false;
uint32_t gpsTimestamp = 0;
uint8_t lastGpsSlotSecond = 255;
uint8_t lastPpsSlotSecond = 255;

unsigned long nextTxMs = 0;
unsigned long lastExpireMs = 0;
unsigned long lastLoRaRetryMs = 0;
unsigned long lastCarryFlushMs = 0;
unsigned long ppsLastSeenMs = 0;
const char* nextTxMode = "fallback";
bool loraReady = false;

// Power Management State
bool peripheralPower = false;
unsigned long currentTxInterval = TX_INTERVAL_NORMAL;
int stationaryCount = 0;
float lastLat = 0.0f;
float lastLng = 0.0f;
unsigned long lastSleepCheck = 0;
bool isStationary = false;

volatile bool ppsFlag = false;
volatile unsigned long ppsTickMs = 0;

float toRadians(float degrees) {
  return degrees * PI / 180.0f;
}

float haversineDistance(float lat1, float lng1, float lat2, float lng2) {
  const float radiusMeters = 6371000.0f;
  float dLat = toRadians(lat2 - lat1);
  float dLng = toRadians(lng2 - lng1);
  float a = sin(dLat / 2.0f) * sin(dLat / 2.0f) +
            cos(toRadians(lat1)) * cos(toRadians(lat2)) *
            sin(dLng / 2.0f) * sin(dLng / 2.0f);
  float c = 2.0f * atan2(sqrt(a), sqrt(1.0f - a));
  return radiusMeters * c;
}

bool isLeapYear(uint16_t year) {
  return (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
}

uint32_t gpsUnixTimestamp() {
  if (!gps.date.isValid() || !gps.time.isValid()) return 0;
  if (gps.date.age() > 2000 || gps.time.age() > 2000) return 0;

  static const uint8_t daysBeforeMonth[] = { 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 };
  uint16_t year = gps.date.year();
  uint8_t month = gps.date.month();
  uint8_t day = gps.date.day();
  if (year < 2020 || month < 1 || month > 12 || day < 1 || day > 31) return 0;

  uint32_t days = 0;
  for (uint16_t y = 1970; y < year; y++) {
    days += isLeapYear(y) ? 366UL : 365UL;
  }
  days += daysBeforeMonth[month - 1];
  if (month > 2 && isLeapYear(year)) days++;
  days += day - 1;

  return days * 86400UL +
         (uint32_t)gps.time.hour() * 3600UL +
         (uint32_t)gps.time.minute() * 60UL +
         (uint32_t)gps.time.second();
}

int linkQuality(float rssi, float snr) {
  int lq = constrain(map((long)rssi, -120, -60, 0, 100), 0, 100);
  if (snr < 0.0f) lq = constrain(lq - 10, 0, 100);
  return lq;
}

bool sameId(const char* a, const char* b) {
  return strncmp(a, b, 15) == 0;
}

int vehicleNumber() {
  if (strncmp(VEHICLE_ID, "BUS_", 4) != 0) return 1;
  int number = atoi(VEHICLE_ID + 4);
  return number > 0 ? number : 1;
}

unsigned long vehicleTxOffsetMs() {
  int slot = (vehicleNumber() - 1) % TX_SLOT_COUNT;
  return (unsigned long)slot * TX_SLOT_SPACING_MS;
}

unsigned long txJitterMs() {
  return TX_JITTER_MS > 0 ? (unsigned long)random(0, TX_JITTER_MS + 1) : 0;
}

void scheduleNextTx(unsigned long baseMs, const char* mode = "fallback") {
  nextTxMs = baseMs + currentTxInterval + txJitterMs();
  nextTxMode = mode;
}

bool ppsRecentlySeen() {
  return ppsLastSeenMs > 0 && millis() - ppsLastSeenMs < 2500UL;
}

void syncTxSlotFromBeacon(unsigned long beaconRxMs) {
  if (gpsTimeValid || ppsRecentlySeen()) return;
  nextTxMs = beaconRxMs + TX_SYNC_GUARD_MS + vehicleTxOffsetMs() + txJitterMs();
  nextTxMode = "beacon";
}

uint16_t gpsMsIntoMinute() {
  return ((uint16_t)gps.time.second() * 1000U) + ((uint16_t)gps.time.centisecond() * 10U);
}

bool gpsTxSlotDue() {
  if (!gpsTimeValid || ppsRecentlySeen()) return false;

  const uint16_t periodMs = (uint16_t)currentTxInterval;
  const uint16_t slotStart = (uint16_t)(vehicleTxOffsetMs() % periodMs);
  const uint16_t elapsed = gpsMsIntoMinute() % periodMs;
  const uint16_t delta = elapsed >= slotStart ? elapsed - slotStart : (periodMs - slotStart) + elapsed;
  const uint8_t second = gps.time.second();

  if (delta > GPS_TX_WINDOW_MS || second == lastGpsSlotSecond) return false;
  lastGpsSlotSecond = second;
  return true;
}

void ICACHE_RAM_ATTR onGpsPps() {
  unsigned long now = millis();
  static unsigned long lastIsrMs = 0;
  if (now - lastIsrMs < 500UL) return;
  lastIsrMs = now;
  ppsTickMs = now;
  ppsFlag = true;
}

void processPpsSync() {
  if (!ppsFlag) return;

  noInterrupts();
  bool hadPps = ppsFlag;
  unsigned long tickMs = ppsTickMs;
  ppsFlag = false;
  interrupts();

  if (!hadPps) return;
  ppsLastSeenMs = millis();
  if (!gpsTimeValid) return;

  const uint8_t periodSec = (uint8_t)(currentTxInterval / 1000UL);
  const uint8_t second = gps.time.second();
  if (periodSec == 0 || (second % periodSec) != 0 || second == lastPpsSlotSecond) return;

  lastPpsSlotSecond = second;
  nextTxMs = tickMs + TX_SYNC_GUARD_MS + vehicleTxOffsetMs() + txJitterMs();
  nextTxMode = "pps";
  Serial.printf("[PPS] sec:%u tx_in:%lums\n", second, nextTxMs - millis());
}

bool neighborExpired(const Neighbor& neighbor, unsigned long now) {
  return now - neighbor.lastSeen > NEIGHBOR_EXPIRE_MS;
}

int findNeighborIndex(const char* id) {
  for (int i = 0; i < neighborCount; i++) {
    if (sameId(neighbors[i].vehicleId, id)) return i;
  }
  return -1;
}

void updateNeighborWithHop(const char* id, float rssi, float snr, float lat, float lng, int hop) {
  if (id == nullptr || id[0] == '\0' || sameId(id, VEHICLE_ID)) return;

  int index = findNeighborIndex(id);
  if (index < 0) {
    if (neighborCount < MAX_NEIGHBORS) {
      index = neighborCount++;
    } else {
      unsigned long oldestSeen = neighbors[0].lastSeen;
      index = 0;
      for (int i = 1; i < MAX_NEIGHBORS; i++) {
        if (neighbors[i].lastSeen < oldestSeen) {
          oldestSeen = neighbors[i].lastSeen;
          index = i;
        }
      }
    }
  }

  strncpy(neighbors[index].vehicleId, id, sizeof(neighbors[index].vehicleId) - 1);
  neighbors[index].vehicleId[sizeof(neighbors[index].vehicleId) - 1] = '\0';
  neighbors[index].rssi = rssi;
  neighbors[index].snr = snr;
  neighbors[index].lastSeen = millis();
  neighbors[index].lat = lat;
  neighbors[index].lng = lng;
  neighbors[index].hop = hop;
}

void updateNeighbor(const char* id, float rssi, float snr, float lat, float lng) {
  updateNeighborWithHop(id, rssi, snr, lat, lng, 0);
}

void expireNeighbors() {
  unsigned long now = millis();
  for (int i = 0; i < neighborCount; i++) {
    if (neighborExpired(neighbors[i], now)) {
      neighbors[i] = neighbors[neighborCount - 1];
      neighborCount--;
      i--;
    }
  }
}

Neighbor* findBestRelay() {
  Neighbor* best = nullptr;
  float bestDistance = 999999999.0f;
  unsigned long now = millis();
  float myDistance = gpsValid ? haversineDistance(gpsLat, gpsLng, GROUND_LAT, GROUND_LNG) : 999999999.0f;

  for (int i = 0; i < neighborCount; i++) {
    if (neighborExpired(neighbors[i], now)) continue;
    if (sameId(neighbors[i].vehicleId, GROUND_ID)) continue;
    if (neighbors[i].lat == 0.0f && neighbors[i].lng == 0.0f) continue;
    if (linkQuality(neighbors[i].rssi, neighbors[i].snr) < MIN_RELAY_LINK_QUALITY) continue;

    float distance = haversineDistance(neighbors[i].lat, neighbors[i].lng, GROUND_LAT, GROUND_LNG);
    if (gpsValid && distance + RELAY_DISTANCE_MARGIN_M >= myDistance) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = &neighbors[i];
    }
  }
  return best;
}

Neighbor* findGroundStation() {
  int index = findNeighborIndex(GROUND_ID);
  if (index < 0) return nullptr;
  if (neighborExpired(neighbors[index], millis())) return nullptr;
  return &neighbors[index];
}

bool isGroundStationNearby() {
  return findGroundStation() != nullptr;
}

bool alreadySeen(const char* packetId) {
  if (packetId == nullptr || packetId[0] == '\0') return false;
  for (int i = 0; i < DEDUP_BUFFER; i++) {
    if (strncmp(seenPackets[i], packetId, sizeof(seenPackets[i])) == 0) return true;
  }
  return false;
}

void markSeen(const char* packetId) {
  if (packetId == nullptr || packetId[0] == '\0' || alreadySeen(packetId)) return;
  strncpy(seenPackets[seenIdx], packetId, sizeof(seenPackets[seenIdx]) - 1);
  seenPackets[seenIdx][sizeof(seenPackets[seenIdx]) - 1] = '\0';
  seenIdx = (seenIdx + 1) % DEDUP_BUFFER;
}

void buildPacketId(char* out, size_t outSize) {
  snprintf(out, outSize, "%s_%lu_%s_%lu",
           VEHICLE_ID, (unsigned long)seq, bootId, (unsigned long)gpsTimestamp);
}

int findSharedStateIndex(const char* id) {
  if (id == nullptr || id[0] == '\0') return -1;
  for (int i = 0; i < SHARED_STATE_SIZE; i++) {
    if (sharedStates[i].used && sameId(sharedStates[i].vehicleId, id)) return i;
  }
  return -1;
}

int sharedStateSlotFor(const char* id) {
  int index = findSharedStateIndex(id);
  if (index >= 0) return index;

  for (int i = 0; i < SHARED_STATE_SIZE; i++) {
    if (!sharedStates[i].used) return i;
  }

  int oldest = 0;
  for (int i = 1; i < SHARED_STATE_SIZE; i++) {
    if (sharedStates[i].lastSeen < sharedStates[oldest].lastSeen) oldest = i;
  }
  return oldest;
}

bool packetIsNewer(const VehicleState& state, const char* bid, uint32_t rxSeq, uint32_t rxGpsTs) {
  if (!state.used) return true;
  if (strncmp(state.bootId, bid, sizeof(state.bootId)) != 0) {
    if (rxGpsTs > 0 && state.gpsTs > 0) return rxGpsTs >= state.gpsTs;
    if (rxGpsTs > 0 && state.gpsTs == 0) return true;
    if (rxGpsTs == 0 && state.gpsTs > 0) return false;
    return true;
  }
  if (rxSeq > state.seq) return true;
  if (rxSeq == state.seq && rxGpsTs > state.gpsTs) return true;
  return false;
}

void writeSharedState(int index, const char* vid, const char* bid, const char* pid,
                      uint32_t rxSeq, uint32_t rxGpsTs, float lat, float lng,
                      float speed, int heading, int battery, int hop, bool fix) {
  if (index < 0 || index >= SHARED_STATE_SIZE) return;

  strncpy(sharedStates[index].vehicleId, vid, sizeof(sharedStates[index].vehicleId) - 1);
  sharedStates[index].vehicleId[sizeof(sharedStates[index].vehicleId) - 1] = '\0';
  strncpy(sharedStates[index].bootId, bid, sizeof(sharedStates[index].bootId) - 1);
  sharedStates[index].bootId[sizeof(sharedStates[index].bootId) - 1] = '\0';
  strncpy(sharedStates[index].packetId, pid, sizeof(sharedStates[index].packetId) - 1);
  sharedStates[index].packetId[sizeof(sharedStates[index].packetId) - 1] = '\0';
  sharedStates[index].seq = rxSeq;
  sharedStates[index].gpsTs = rxGpsTs;
  sharedStates[index].lat = lat;
  sharedStates[index].lng = lng;
  sharedStates[index].speed = speed;
  sharedStates[index].heading = heading;
  sharedStates[index].battery = battery;
  sharedStates[index].hop = hop;
  sharedStates[index].gpsFix = fix;
  sharedStates[index].used = true;
  sharedStates[index].lastSeen = millis();
}

bool updateSharedStateFromDoc(JsonDocument& doc) {
  const char* vid = doc["vid"] | "";
  const char* bid = doc["bid"] | "";
  const char* pid = doc["pid"] | "";
  if (vid[0] == '\0' || bid[0] == '\0' || pid[0] == '\0') return false;

  uint32_t rxSeq = doc["seq"] | 0UL;
  uint32_t rxGpsTs = doc["gt"] | 0UL;
  int index = sharedStateSlotFor(vid);
  if (!packetIsNewer(sharedStates[index], bid, rxSeq, rxGpsTs)) return false;

  writeSharedState(index, vid, bid, pid, rxSeq, rxGpsTs,
                   doc["lat"] | 0.0f, doc["lng"] | 0.0f,
                   doc["spd"] | 0.0f, doc["hdg"] | 0,
                   doc["bat"] | -1, doc["hop"] | 0, doc["fix"] | false);
  return true;
}

void updateOwnSharedState(const char* packetId, int battery, int hop) {
  int index = sharedStateSlotFor(VEHICLE_ID);
  writeSharedState(index, VEHICLE_ID, bootId, packetId, seq, gpsTimestamp,
                   gpsValid ? gpsLat : 0.0f, gpsValid ? gpsLng : 0.0f,
                   gpsSpeed, (int)gpsHeading, battery, hop, gpsValid);
}

void updateKnownVehicle(const char* vehicleId, const char* shortId,
                        uint32_t rxSeq, const char* rxBootId) {
  if (vehicleId == nullptr || vehicleId[0] == '\0') return;
  if (sameId(vehicleId, VEHICLE_ID)) return;

  const char* safeBootId = rxBootId ? rxBootId : "";
  int index = sharedStateSlotFor(vehicleId);
  VehicleState& state = sharedStates[index];
  if (state.used && sameId(state.vehicleId, vehicleId) &&
      strncmp(state.bootId, safeBootId, sizeof(state.bootId)) == 0 &&
      rxSeq < state.seq) {
    return;
  }

  strncpy(state.vehicleId, vehicleId, sizeof(state.vehicleId) - 1);
  state.vehicleId[sizeof(state.vehicleId) - 1] = '\0';
  strncpy(state.bootId, safeBootId, sizeof(state.bootId) - 1);
  state.bootId[sizeof(state.bootId) - 1] = '\0';
  state.seq = rxSeq;
  state.used = true;
  state.lastSeen = millis();
  (void)shortId;
}

void addVersionSummary(JsonDocument& doc) {
  JsonArray summary = doc.createNestedArray("vs");
  int added = 0;
  for (int i = 0; i < SHARED_STATE_SIZE && added < VERSION_SUMMARY_LIMIT; i++) {
    if (!sharedStates[i].used || sameId(sharedStates[i].vehicleId, VEHICLE_ID)) continue;
    JsonArray item = summary.createNestedArray();
    item.add(sharedStates[i].vehicleId);
    item.add(sharedStates[i].seq);
    if (sharedStates[i].gpsTs > 0) item.add(sharedStates[i].gpsTs);
    added++;
  }
  if (added == 0) doc.remove("vs");
}

void fullVehicleIdFromShortToBuffer(const char* shortId, char* out, size_t outSize) {
  if (outSize == 0) return;
  out[0] = '\0';
  if (shortId == nullptr || shortId[0] == '\0') return;

  int number = atoi(shortId + 1);
  if (shortId[0] == 'B') {
    snprintf(out, outSize, "BUS_%02d", number);
    return;
  }
  if (shortId[0] == 'D') {
    snprintf(out, outSize, "DEMO_%d", number);
    return;
  }
  if (shortId[0] == 'G') {
    snprintf(out, outSize, "GROUND_%02d", number);
    return;
  }
  strncpy(out, shortId, outSize - 1);
  out[outSize - 1] = '\0';
}

const char* directionCode(const char* direction) {
  if (direction == nullptr || direction[0] == '\0') return "U";
  char c = direction[0];
  if (c == 'i' || c == 'I') return "I";
  if (c == 'o' || c == 'O') return "O";
  return "U";
}

void packetHash6ToBuffer(const char* packetId, char* out, size_t outSize) {
  if (outSize == 0) return;
  out[0] = '\0';
  uint32_t hash = 2166136261UL;
  if (packetId != nullptr) {
    while (*packetId) {
      hash ^= (uint8_t)*packetId++;
      hash *= 16777619UL;
    }
  }
  snprintf(out, outSize, "%06lX", (unsigned long)(hash & 0xFFFFFFUL));
}

void shortVehicleIdToBuffer(const char* vehicleId, char* out, size_t outSize) {
  if (outSize == 0) return;
  out[0] = '\0';
  if (vehicleId == nullptr || vehicleId[0] == '\0') return;

  if (strncmp(vehicleId, "DEMO_", 5) == 0) {
    snprintf(out, outSize, "D%d", atoi(vehicleId + 5));
    return;
  }
  if (strncmp(vehicleId, "BUS_", 4) == 0) {
    snprintf(out, outSize, "B%d", atoi(vehicleId + 4));
    return;
  }
  if (strncmp(vehicleId, "GROUND_", 7) == 0) {
    snprintf(out, outSize, "G%d", atoi(vehicleId + 7));
    return;
  }

  size_t write = 0;
  for (size_t read = 0; vehicleId[read] != '\0' && write < outSize - 1 && write < 6; read++) {
    if (vehicleId[read] == '_') continue;
    out[write++] = vehicleId[read];
  }
  out[write] = '\0';
}

void shortRouteIdToBuffer(const char* routeId, char* out, size_t outSize) {
  if (outSize == 0) return;
  out[0] = '\0';
  if (routeId == nullptr || routeId[0] == '\0') return;
  if (strncmp(routeId, "route_", 6) == 0) {
    snprintf(out, outSize, "R%d", atoi(routeId + 6));
    return;
  }

  size_t write = 0;
  for (size_t read = 0; routeId[read] != '\0' && write < outSize - 1 && write < 8; read++) {
    if (routeId[read] == '_' || routeId[read] == '-') continue;
    if (strncmp(routeId + read, "route", 5) == 0) {
      out[write++] = 'R';
      read += 4;
      continue;
    }
    out[write++] = routeId[read];
  }
  out[write] = '\0';
}

void appendCompactToken(char* out, size_t outSize, const char* token) {
  if (outSize == 0 || token == nullptr || token[0] == '\0') return;
  size_t used = strlen(out);
  if (used >= outSize - 1) return;
  snprintf(out + used, outSize - used, "%s%s", used > 0 ? "," : "", token);
}

void trimCompactListTo(char* out, size_t maxLen) {
  while (strlen(out) > maxLen) {
    char* comma = strchr(out, ',');
    if (comma == nullptr) {
      size_t len = strlen(out);
      memmove(out, out + len - maxLen, maxLen + 1);
      return;
    }
    memmove(out, comma + 1, strlen(comma + 1) + 1);
  }
}

void buildNeighborCompact(char* out, size_t outSize, Neighbor* table, int count) {
  if (outSize == 0) return;
  out[0] = '\0';
  int best[3] = { -1, -1, -1 };
  unsigned long now = millis();

  for (int i = 0; i < count; i++) {
    if (neighborExpired(table[i], now)) continue;
    if (sameId(table[i].vehicleId, GROUND_ID)) continue;

    for (int slot = 0; slot < 3; slot++) {
      if (best[slot] < 0 || table[i].rssi > table[best[slot]].rssi) {
        for (int shift = 2; shift > slot; shift--) best[shift] = best[shift - 1];
        best[slot] = i;
        break;
      }
    }
  }

  for (int slot = 0; slot < 3; slot++) {
    int index = best[slot];
    if (index < 0) continue;
    char shortId[8];
    char token[32];
    shortVehicleIdToBuffer(table[index].vehicleId, shortId, sizeof(shortId));
    snprintf(token, sizeof(token), "%s:%d:%d", shortId, (int)table[index].rssi, (int)round(table[index].snr * 10.0f));
    appendCompactToken(out, outSize, token);
  }
}

void buildRelayChainCompactFromDoc(JsonDocument& doc, char* out, size_t outSize) {
  if (outSize == 0) return;
  out[0] = '\0';
  char ownShort[8];
  shortVehicleIdToBuffer(VEHICLE_ID, ownShort, sizeof(ownShort));

  if (doc["rc"].is<JsonArray>()) {
    for (JsonVariant item : doc["rc"].as<JsonArray>()) {
      char shortId[8];
      shortVehicleIdToBuffer(item.as<const char*>(), shortId, sizeof(shortId));
      if (shortId[0] == '\0' || strcmp(shortId, ownShort) == 0) continue;
      appendCompactToken(out, outSize, shortId);
    }
  }

  const char* relayFrom = doc["rf"] | "";
  if (relayFrom[0] != '\0') {
    char shortId[8];
    shortVehicleIdToBuffer(relayFrom, shortId, sizeof(shortId));
    if (shortId[0] != '\0' && strcmp(shortId, ownShort) != 0) appendCompactToken(out, outSize, shortId);
  }
  trimCompactListTo(out, 30);
}

void buildVersionSummaryCompact(char* out, size_t outSize) {
  if (outSize == 0) return;
  out[0] = '\0';
  unsigned long now = millis();
  int added = 0;
  for (int i = 0; i < SHARED_STATE_SIZE && added < VERSION_SUMMARY_LIMIT; i++) {
    if (!sharedStates[i].used || sameId(sharedStates[i].vehicleId, VEHICLE_ID)) continue;
    if (now - sharedStates[i].lastSeen > MESH_SEEN_TIMEOUT_MS) continue;
    char shortId[8];
    char bootPrefix[3] = "";
    char token[32];
    shortVehicleIdToBuffer(sharedStates[i].vehicleId, shortId, sizeof(shortId));
    if (strlen(sharedStates[i].bootId) >= 2) {
      bootPrefix[0] = sharedStates[i].bootId[0];
      bootPrefix[1] = sharedStates[i].bootId[1];
      bootPrefix[2] = '\0';
    } else {
      strncpy(bootPrefix, sharedStates[i].bootId, sizeof(bootPrefix) - 1);
    }
    snprintf(token, sizeof(token), "%s:%lu:%s", shortId, (unsigned long)sharedStates[i].seq, bootPrefix);
    appendCompactToken(out, outSize, token);
    added++;
  }
}

bool buildLoRaPacket(const char* vehicleId, const char* packetId, uint32_t packetSeq,
                       const char* packetBootId, uint32_t packetGpsTs,
                       float lat, float lng, float speed, int heading, int battery,
                       int hop, int ttl, const char* routeId, const char* direction,
                       const char* relayFrom, int linkQualityValue, bool storeForward,
                       const char* relayChain, bool gpsFix, char* payload, size_t payloadSize) {
  StaticJsonDocument<256> doc;

  char shortId[8];
  shortVehicleIdToBuffer(vehicleId, shortId, sizeof(shortId));
  doc["id"] = shortId;
  doc["sq"] = packetSeq;
  doc["bi"] = packetBootId;
  doc["ts"] = packetGpsTs;
  doc["fx"] = gpsFix ? 1 : 0;
  if (gpsFix) {
    char latText[12];
    char lngText[12];
    dtostrf(lat, 0, 6, latText);
    dtostrf(lng, 0, 6, lngText);
    doc["la"] = serialized(latText);
    doc["ln"] = serialized(lngText);
  }
  doc["sp"] = (int)round(speed);
  doc["bt"] = battery;
  doc["hp"] = hop;
  char packetHash[7];
  packetHash6ToBuffer(packetId, packetHash, sizeof(packetHash));
  doc["pk"] = packetHash;
  doc["tt"] = ttl;

  if (measureJson(doc) < 140) {
    doc["hd"] = heading;
    char route[10];
    shortRouteIdToBuffer(routeId, route, sizeof(route));
    if (route[0] != '\0') doc["ri"] = route;
    doc["dr"] = directionCode(direction);
    if (relayFrom != nullptr && relayFrom[0] != '\0') {
      char relayShort[8];
      shortVehicleIdToBuffer(relayFrom, relayShort, sizeof(relayShort));
      doc["rf"] = relayShort;
    }
    doc["lq"] = linkQualityValue;
    if (storeForward) doc["sf"] = 1;
  }

  if (measureJson(doc) < 180) {
    if (relayChain != nullptr && relayChain[0] != '\0') doc["rc"] = relayChain;
    char compactNeighbors[80];
    buildNeighborCompact(compactNeighbors, sizeof(compactNeighbors), neighbors, neighborCount);
    if (compactNeighbors[0] != '\0') doc["nb"] = compactNeighbors;
  }

  if (measureJson(doc) < 195) {
    char versionSummary[96];
    buildVersionSummaryCompact(versionSummary, sizeof(versionSummary));
    if (versionSummary[0] != '\0') doc["vs"] = versionSummary;
  }

  while (measureJson(doc) > MAX_LORA_PACKET_BYTES && doc.containsKey("vs")) doc.remove("vs");
  if (measureJson(doc) > MAX_LORA_PACKET_BYTES && doc.containsKey("nb")) {
    char compactNeighbors[80];
    strncpy(compactNeighbors, doc["nb"] | "", sizeof(compactNeighbors) - 1);
    compactNeighbors[sizeof(compactNeighbors) - 1] = '\0';
    while (measureJson(doc) > MAX_LORA_PACKET_BYTES && strrchr(compactNeighbors, ',') != nullptr) {
      *strrchr(compactNeighbors, ',') = '\0';
      doc["nb"] = compactNeighbors;
    }
    if (measureJson(doc) > MAX_LORA_PACKET_BYTES) doc.remove("nb");
  }
  while (measureJson(doc) > MAX_LORA_PACKET_BYTES && doc.containsKey("rc")) doc.remove("rc");

  if (payloadSize == 0 || measureJson(doc) > MAX_LORA_PACKET_BYTES) return false;
  size_t len = serializeJson(doc, payload, payloadSize);
  return len > 0 && len <= MAX_LORA_PACKET_BYTES;
}

void addNeighborArray(JsonDocument& doc) {
  if (neighborCount == 0) return;

  JsonArray nb = doc.createNestedArray("nb");
  unsigned long now = millis();
  int added = 0;
  for (int i = 0; i < neighborCount && added < 2; i++) {
    if (neighborExpired(neighbors[i], now)) continue;
    JsonObject item = nb.createNestedObject();
    item["id"] = neighbors[i].vehicleId;
    item["rs"] = (int)neighbors[i].rssi;
    item["sn"] = neighbors[i].snr;
    added++;
  }
  if (added == 0) doc.remove("nb");
}

bool packetFits(JsonDocument& doc) {
  if (measureJson(doc) <= MAX_LORA_PACKET_BYTES) return true;

  if (doc.containsKey("nb")) {
    doc.remove("nb");
    if (measureJson(doc) <= MAX_LORA_PACKET_BYTES) return true;
  }
  if (doc.containsKey("vs")) {
    doc.remove("vs");
    if (measureJson(doc) <= MAX_LORA_PACKET_BYTES) return true;
  }
  if (doc.containsKey("sats")) {
    doc.remove("sats");
    doc.remove("hdop");
    if (measureJson(doc) <= MAX_LORA_PACKET_BYTES) return true;
  }
  if (doc.containsKey("src")) {
    doc.remove("src");
    if (measureJson(doc) <= MAX_LORA_PACKET_BYTES) return true;
  }
  if (doc.containsKey("type")) {
    doc.remove("type");
    doc["t"] = "vd";
    if (measureJson(doc) <= MAX_LORA_PACKET_BYTES) return true;
  }
  if (doc.containsKey("rssi")) {
    doc.remove("rssi");
    doc.remove("snr");
    if (measureJson(doc) <= MAX_LORA_PACKET_BYTES) return true;
  }
  if (doc.containsKey("rid")) {
    doc.remove("rid");
    if (measureJson(doc) <= MAX_LORA_PACKET_BYTES) return true;
  }
  if (doc.containsKey("dir")) {
    doc.remove("dir");
    if (measureJson(doc) <= MAX_LORA_PACKET_BYTES) return true;
  }
  if (doc.containsKey("fix")) {
    doc.remove("fix");
    if (measureJson(doc) <= MAX_LORA_PACKET_BYTES) return true;
  }
  if (doc.containsKey("lq")) {
    doc.remove("lq");
    if (measureJson(doc) <= MAX_LORA_PACKET_BYTES) return true;
  }
  if (doc.containsKey("ttl")) {
    doc.remove("ttl");
    if (measureJson(doc) <= MAX_LORA_PACKET_BYTES) return true;
  }
  if (doc.containsKey("rc")) {
    doc.remove("rc");
    if (measureJson(doc) <= MAX_LORA_PACKET_BYTES) return true;
  }
  if (doc.containsKey("sf")) {
    doc.remove("sf");
    if (measureJson(doc) <= MAX_LORA_PACKET_BYTES) return true;
  }
  return measureJson(doc) <= MAX_LORA_PACKET_BYTES;
}

bool serializeMeshPacket(JsonDocument& doc, char* out, size_t outSize) {
  if (!packetFits(doc)) return false;
  size_t len = serializeJson(doc, out, outSize);
  return len > 0 && len <= MAX_LORA_PACKET_BYTES;
}

int findCarryIndex(const char* packetId) {
  if (packetId == nullptr || packetId[0] == '\0') return -1;
  for (int i = 0; i < CARRY_BUFFER_SIZE; i++) {
    if (carryBuffer[i].used && strncmp(carryBuffer[i].packetId, packetId, sizeof(carryBuffer[i].packetId)) == 0) return i;
  }
  return -1;
}

int firstFreeCarryIndex() {
  for (int i = 0; i < CARRY_BUFFER_SIZE; i++) {
    if (!carryBuffer[i].used) return i;
  }
  return -1;
}

int oldestCarryIndex() {
  int oldest = -1;
  for (int i = 0; i < CARRY_BUFFER_SIZE; i++) {
    if (!carryBuffer[i].used) continue;
    if (oldest < 0 || carryBuffer[i].queuedAt < carryBuffer[oldest].queuedAt) oldest = i;
  }
  return oldest;
}

void clearCarrySlot(int index) {
  if (index < 0 || index >= CARRY_BUFFER_SIZE) return;
  carryBuffer[index].packetId[0] = '\0';
  carryBuffer[index].payload[0] = '\0';
  carryBuffer[index].used = false;
  carryBuffer[index].attempts = 0;
  carryBuffer[index].queuedAt = 0;
  carryBuffer[index].lastAttempt = 0;
}

void expireCarryBuffer() {
  unsigned long now = millis();
  for (int i = 0; i < CARRY_BUFFER_SIZE; i++) {
    if (carryBuffer[i].used && now - carryBuffer[i].queuedAt > CARRY_PACKET_TTL_MS) {
      Serial.printf("[CARRY] expire %s\n", carryBuffer[i].packetId);
      clearCarrySlot(i);
    }
  }
}

bool sendRawPayload(const char* payload) {
  if (!loraReady || payload == nullptr || payload[0] == '\0') return false;

  LoRa.idle();
  LoRa.beginPacket();
  LoRa.print(payload);
  int result = LoRa.endPacket();
  LoRa.receive();
  return result == 1;
}

void queueCarryPacket(JsonDocument& doc, const char* reason) {
  const char* packetId = doc["pid"] | "";
  if (packetId[0] == '\0' || findCarryIndex(packetId) >= 0) return;

  doc["sf"] = 1;
  char payload[MAX_LORA_PACKET_BYTES + 1];
  if (!serializeMeshPacket(doc, payload, sizeof(payload))) {
    Serial.printf("[CARRY] drop oversized %s\n", packetId);
    return;
  }

  int slot = firstFreeCarryIndex();
  if (slot < 0) {
    slot = oldestCarryIndex();
    Serial.printf("[CARRY] full, dropping oldest slot:%d\n", slot);
  }
  if (slot < 0) return;

  strncpy(carryBuffer[slot].packetId, packetId, sizeof(carryBuffer[slot].packetId) - 1);
  carryBuffer[slot].packetId[sizeof(carryBuffer[slot].packetId) - 1] = '\0';
  strncpy(carryBuffer[slot].payload, payload, sizeof(carryBuffer[slot].payload) - 1);
  carryBuffer[slot].payload[sizeof(carryBuffer[slot].payload) - 1] = '\0';
  carryBuffer[slot].used = true;
  carryBuffer[slot].attempts = 0;
  carryBuffer[slot].queuedAt = millis();
  carryBuffer[slot].lastAttempt = 0;
  Serial.printf("[CARRY] queued %s reason:%s\n", packetId, reason);
}

void queueCarryPayload(const char* packetId, const char* payload, const char* reason) {
  if (packetId == nullptr || packetId[0] == '\0' || payload == nullptr || payload[0] == '\0' || findCarryIndex(packetId) >= 0) return;

  int slot = firstFreeCarryIndex();
  if (slot < 0) {
    slot = oldestCarryIndex();
    Serial.printf("[CARRY] full, dropping oldest slot:%d\n", slot);
  }
  if (slot < 0) return;

  strncpy(carryBuffer[slot].packetId, packetId, sizeof(carryBuffer[slot].packetId) - 1);
  carryBuffer[slot].packetId[sizeof(carryBuffer[slot].packetId) - 1] = '\0';
  strncpy(carryBuffer[slot].payload, payload, sizeof(carryBuffer[slot].payload) - 1);
  carryBuffer[slot].payload[sizeof(carryBuffer[slot].payload) - 1] = '\0';
  carryBuffer[slot].used = true;
  carryBuffer[slot].attempts = 0;
  carryBuffer[slot].queuedAt = millis();
  carryBuffer[slot].lastAttempt = 0;
  Serial.printf("[CARRY] queued %s reason:%s\n", packetId, reason);
}

bool hasForwardPath() {
  return findGroundStation() != nullptr || findBestRelay() != nullptr;
}

void flushCarryBuffer() {
  unsigned long now = millis();
  if (now - lastCarryFlushMs < CARRY_RETRY_MS) return;
  lastCarryFlushMs = now;

  expireCarryBuffer();
  if (!hasForwardPath()) return;

  int index = oldestCarryIndex();
  if (index < 0) return;

  if (sendRawPayload(carryBuffer[index].payload)) {
    Serial.printf("[CARRY] sent %s\n", carryBuffer[index].packetId);
    clearCarrySlot(index);
    return;
  }

  carryBuffer[index].attempts++;
  carryBuffer[index].lastAttempt = now;
  Serial.printf("[CARRY] retry %s attempt:%u\n", carryBuffer[index].packetId, carryBuffer[index].attempts);
  if (carryBuffer[index].attempts >= CARRY_MAX_ATTEMPTS) clearCarrySlot(index);
}

bool sendJson(JsonDocument& doc) {
  if (!loraReady) return false;

  char payload[MAX_LORA_PACKET_BYTES + 1];
  if (!serializeMeshPacket(doc, payload, sizeof(payload))) {
    Serial.println("[TX] drop oversized packet");
    return false;
  }

  return sendRawPayload(payload);
}

float readBattery() {
  int raw = analogRead(BAT_PIN);
  float vOut = (raw / 1023.0f) * BAT_VCC;
  float vBat = vOut * (BAT_R1 + BAT_R2) / BAT_R2;
  float percent = ((vBat * 100.0f) - 330.0f) * 100.0f / (420.0f - 330.0f);
  return constrain(percent, 0.0f, 100.0f);
}

void readGPS() {
  while (gpsSerial.available()) {
    gps.encode(gpsSerial.read());
  }

  gpsValid = gps.location.isValid() && gps.location.age() < 2000;
  gpsTimeValid = gps.time.isValid() && gps.time.age() < 2000;
  gpsTimestamp = gpsUnixTimestamp();
  gpsTimestampValid = gpsTimestamp > 0;
  if (gpsValid) {
    gpsLat = gps.location.lat();
    gpsLng = gps.location.lng();
  }
  gpsSpeed = gps.speed.isValid() ? gps.speed.kmph() : 0.0f;
  gpsHeading = gps.course.isValid() ? gps.course.deg() : 0.0f;
  gpsSats = gps.satellites.isValid() ? gps.satellites.value() : 0;
  gpsHdop = gps.hdop.isValid() ? gps.hdop.hdop() : 99.9f;
}

void transmitPacket(const char* txMode = "auto") {
  Neighbor* ground = findGroundStation();
  Neighbor* relay = ground == nullptr ? findBestRelay() : nullptr;
  bool direct = ground != nullptr;
  bool hasRoute = direct || relay != nullptr;
  int hop = direct ? 0 : (relay ? constrain(relay->hop + 1, 1, MAX_HOPS) : 0);
  float bestRssi = direct ? ground->rssi : (relay ? relay->rssi : 0.0f);
  float bestSnr = direct ? ground->snr : (relay ? relay->snr : 0.0f);
  int battery = (int)round(readBattery());

  seq++;
  char packetId[40];
  buildPacketId(packetId, sizeof(packetId));
  markSeen(packetId);

  updateOwnSharedState(packetId, battery, hop);

  char payload[MAX_LORA_PACKET_BYTES + 1] = "";
  bool built = buildLoRaPacket(VEHICLE_ID, packetId, seq, bootId, gpsTimestamp,
                               gpsValid ? gpsLat : 0.0f, gpsValid ? gpsLng : 0.0f,
                               gpsSpeed, (int)gpsHeading, battery, hop, MAX_HOPS - hop,
                               ROUTE_ID, ROUTE_DIR, "", linkQuality(bestRssi, bestSnr),
                               !hasRoute, "", gpsValid, payload, sizeof(payload));

  bool sent = built && sendRawPayload(payload);
  if (!hasRoute || !sent) queueCarryPayload(packetId, payload, sent ? "no_route" : "tx_fail");
  if (hasRoute) flushCarryBuffer();
  Serial.printf("[TX] %s mode:%s hop:%d bytes:%d rssi:%.0f %s\n",
                VEHICLE_ID, txMode, hop, strlen(payload), bestRssi, sent ? "sent" : "failed");
}

bool wouldCreateLoop(JsonVariantConst relayChain, const char* myId) {
  if (!relayChain.is<JsonArrayConst>()) return false;
  char myShort[8];
  shortVehicleIdToBuffer(myId, myShort, sizeof(myShort));
  for (JsonVariantConst item : relayChain.as<JsonArrayConst>()) {
    const char* id = item.as<const char*>();
    if (id == nullptr || id[0] == '\0') continue;
    if (sameId(id, myId) || strcmp(id, myShort) == 0) return true;
  }
  return false;
}

bool wouldCreateLoopCompact(const char* rcCompact, const char* myId) {
  if (rcCompact == nullptr || rcCompact[0] == '\0') return false;

  char myShort[8];
  shortVehicleIdToBuffer(myId, myShort, sizeof(myShort));
  const char* start = rcCompact;
  while (*start != '\0') {
    while (*start == ' ' || *start == ',') start++;
    const char* end = strchr(start, ',');
    size_t len = end ? (size_t)(end - start) : strlen(start);
    while (len > 0 && start[len - 1] == ' ') len--;
    if ((strlen(myShort) == len && strncmp(start, myShort, len) == 0) ||
        (strlen(myId) == len && strncmp(start, myId, len) == 0)) {
      return true;
    }
    if (end == nullptr) break;
    start = end + 1;
  }
  return false;
}

void appendSelfToChain(JsonDocument& doc) {
  JsonArray chain;
  if (doc["rc"].is<JsonArray>()) {
    chain = doc["rc"].as<JsonArray>();
  } else {
    chain = doc.createNestedArray("rc");
  }

  for (JsonVariant item : chain) {
    const char* id = item.as<const char*>();
    if (id != nullptr && sameId(id, VEHICLE_ID)) return;
  }
  chain.add(VEHICLE_ID);
}

bool shouldRelay(JsonDocument& doc, int hop) {
  const char* sourceVid = doc["vid"] | "";
  const char* relayFrom = doc["rf"] | "";
  const char* relayTo = doc["to"] | "";
  int ttl = doc["ttl"] | (MAX_HOPS - hop);

  if (sameId(sourceVid, VEHICLE_ID)) return false;
  if (sameId(relayFrom, VEHICLE_ID)) return false;
  if (relayTo[0] != '\0' && !sameId(relayTo, VEHICLE_ID)) return false;
  if (wouldCreateLoop(doc["rc"], VEHICLE_ID)) {
    Serial.printf("[RELAY] skip loop: packet from %s already passed through me\n", sourceVid[0] ? sourceVid : "?");
    return false;
  }
  if (hop >= MAX_HOPS) {
    Serial.println("[RELAY] skip: max hops reached");
    return false;
  }
  if (ttl <= 0) {
    Serial.println("[RELAY] skip: TTL expired");
    return false;
  }
  if (isGroundStationNearby()) return true;

  float sourceLat = doc["lat"] | 0.0f;
  float sourceLng = doc["lng"] | 0.0f;
  if (gpsValid && sourceLat != 0.0f && sourceLng != 0.0f) {
    float myDistance = haversineDistance(gpsLat, gpsLng, GROUND_LAT, GROUND_LNG);
    float sourceDistance = haversineDistance(sourceLat, sourceLng, GROUND_LAT, GROUND_LNG);
    return myDistance + RELAY_DISTANCE_MARGIN_M < sourceDistance;
  }

  return findBestRelay() != nullptr;
}

void relayVehiclePacket(JsonDocument& doc, int hop, float rssi, float snr) {
  int ttl = doc["ttl"] | (MAX_HOPS - hop);
  if (ttl <= 0) return;
  if (wouldCreateLoop(doc["rc"], VEHICLE_ID)) {
    Serial.println("[RELAY] skip loop before forward");
    return;
  }

  doc["hop"] = hop + 1;
  doc["ttl"] = ttl - 1;
  doc["rf"] = VEHICLE_ID;
  doc["rssi"] = (int)rssi;
  doc["snr"] = snr;
  doc["lq"] = linkQuality(rssi, snr);
  doc.remove("nb");
  doc.remove("to");
  appendSelfToChain(doc);

  const char* vehicleId = doc["vid"] | "";
  const char* packetId = doc["pid"] | "";
  const char* packetBootId = doc["bid"] | "";
  char relayChain[40];
  char payload[MAX_LORA_PACKET_BYTES + 1] = "";
  buildRelayChainCompactFromDoc(doc, relayChain, sizeof(relayChain));
  bool built = buildLoRaPacket(vehicleId, packetId, doc["seq"] | 0UL, packetBootId,
                               doc["gt"] | 0UL, doc["lat"] | 0.0f, doc["lng"] | 0.0f,
                               doc["spd"] | 0.0f, doc["hdg"] | 0, doc["bat"] | -1,
                               hop + 1, ttl - 1, doc["rid"] | ROUTE_ID, doc["dir"] | ROUTE_DIR,
                               VEHICLE_ID, linkQuality(rssi, snr), !hasForwardPath(), relayChain,
                               doc["fix"] | false, payload, sizeof(payload));

  bool sent = built && sendRawPayload(payload);
  if (!hasForwardPath() || !sent) queueCarryPayload(packetId, payload, sent ? "relay_wait" : "relay_tx_fail");
  Serial.printf("[RELAY] %s hop:%d bytes:%d rssi:%.0f %s\n",
                vehicleId[0] ? vehicleId : "?", hop + 1, strlen(payload), rssi, sent ? "sent" : "failed");
}

void handleBeacon(JsonDocument& doc, float rssi, float snr) {
  const char* stationId = doc["sid"] | GROUND_ID;
  float lat = doc["lat"] | GROUND_LAT;
  float lng = doc["lng"] | GROUND_LNG;
  updateNeighbor(stationId, rssi, snr, lat, lng);
  syncTxSlotFromBeacon(millis());
  Serial.printf("[RX] beacon %s rssi:%.0f snr:%.1f next_tx:%lums\n",
                stationId, rssi, snr, nextTxMs);
}

void handleVehicleData(JsonDocument& doc, float rssi, float snr) {
  const char* vid = doc["vid"] | "";
  const char* pid = doc["pid"] | "";
  float lat = doc["lat"] | 0.0f;
  float lng = doc["lng"] | 0.0f;
  int hop = doc["hop"] | 0;

  updateNeighborWithHop(vid, rssi, snr, lat, lng, hop);
  Serial.printf("[RX] from %s hop:%d rssi:%.0f\n", vid[0] ? vid : "?", hop, rssi);

  if (alreadySeen(pid)) return;
  markSeen(pid);
  if (!updateSharedStateFromDoc(doc)) return;
  updateKnownVehicle(vid, "", doc["seq"] | 0UL, doc["bid"] | "");

  if (shouldRelay(doc, hop)) {
    relayVehiclePacket(doc, hop, rssi, snr);
  }
}

bool decodeCompactVehiclePacket(JsonDocument& compact, JsonDocument& expanded) {
  const char* shortId = compact["id"] | "";
  const char* packetHash = compact["pk"] | "";
  const char* boot = compact["bi"] | "";
  if (shortId[0] == '\0' || packetHash[0] == '\0' || boot[0] == '\0') return false;

  char fullId[16];
  fullVehicleIdFromShortToBuffer(shortId, fullId, sizeof(fullId));
  uint32_t packetSeq = compact["sq"] | 0UL;
  uint32_t packetTs = compact["ts"] | 0UL;
  char packetId[64];
  snprintf(packetId, sizeof(packetId), "%s_%lu_%s_%lu_%s",
           fullId, (unsigned long)packetSeq, boot, (unsigned long)packetTs, packetHash);

  expanded["type"] = "vehicle_data";
  expanded["vid"] = fullId;
  expanded["pid"] = packetId;
  expanded["seq"] = packetSeq;
  expanded["bid"] = boot;
  expanded["gt"] = packetTs;
  expanded["lat"] = compact["la"].is<const char*>() ? atof(compact["la"] | "0") : (compact["la"] | 0.0f);
  expanded["lng"] = compact["ln"].is<const char*>() ? atof(compact["ln"] | "0") : (compact["ln"] | 0.0f);
  expanded["spd"] = compact["sp"] | 0;
  expanded["hdg"] = compact["hd"] | 0;
  expanded["bat"] = compact["bt"] | -1;
  expanded["hop"] = compact["hp"] | 0;
  expanded["ttl"] = compact["tt"] | (MAX_HOPS - (int)(compact["hp"] | 0));
  expanded["lq"] = compact["lq"] | 0;
  float lat = expanded["lat"] | 0.0f;
  float lng = expanded["lng"] | 0.0f;
  bool gpsFix = compact.containsKey("fx")
    ? ((compact["fx"] | 0) == 1)
    : (lat >= 5.5f && lat <= 20.5f && lng >= 97.5f && lng <= 105.7f);
  expanded["fix"] = gpsFix;

  if (compact["rf"].is<const char*>()) {
    char relayFrom[16];
    fullVehicleIdFromShortToBuffer(compact["rf"] | "", relayFrom, sizeof(relayFrom));
    expanded["rf"] = relayFrom;
  }

  if (compact["rc"].is<const char*>()) {
    const char* rc = compact["rc"] | "";
    if (wouldCreateLoopCompact(rc, VEHICLE_ID)) {
      Serial.printf("[RELAY] skip compact loop: %s\n", rc);
      return false;
    }
    JsonArray chain = expanded.createNestedArray("rc");
    const char* start = rc;
    while (*start != '\0') {
      while (*start == ' ' || *start == ',') start++;
      const char* comma = strchr(start, ',');
      size_t len = comma ? (size_t)(comma - start) : strlen(start);
      while (len > 0 && start[len - 1] == ' ') len--;
      if (len > 0) {
        char item[16];
        char expandedId[16];
        size_t copyLen = min(len, sizeof(item) - 1);
        memcpy(item, start, copyLen);
        item[copyLen] = '\0';
        fullVehicleIdFromShortToBuffer(item, expandedId, sizeof(expandedId));
        chain.add(expandedId);
      }
      if (comma == nullptr) break;
      start = comma + 1;
    }
  }

  return true;
}

void onLoRaReceive(int packetSize) {
  if (packetSize <= 0) return;

  char payload[256];
  int len = 0;
  while (LoRa.available() && len < (int)sizeof(payload) - 1) {
    payload[len++] = (char)LoRa.read();
  }
  payload[len] = '\0';

  float rssi = LoRa.packetRssi();
  float snr = LoRa.packetSnr();

  StaticJsonDocument<768> doc;
  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("[RX] invalid json: %s\n", error.c_str());
    return;
  }

  const char* type = doc["type"] | "";
  const char* compactType = doc["t"] | "";
  if (strcmp(type, "beacon") == 0 || strcmp(compactType, "b") == 0) {
    handleBeacon(doc, rssi, snr);
  } else if (strcmp(type, "vehicle_data") == 0 || strcmp(compactType, "vd") == 0) {
    handleVehicleData(doc, rssi, snr);
  } else if (doc["id"].is<const char*>() && doc["pk"].is<const char*>()) {
    StaticJsonDocument<768> expanded;
    if (decodeCompactVehiclePacket(doc, expanded)) handleVehicleData(expanded, rssi, snr);
  }
}

bool initLoRa() {
  LoRa.setPins(LORA_SS, LORA_RST, LORA_DIO0);
  if (!LoRa.begin(LORA_FREQ)) {
    Serial.println("[LoRa] init failed, will retry");
    return false;
  }
  LoRa.setSignalBandwidth(LORA_BW);
  LoRa.setSpreadingFactor(LORA_SF);
  LoRa.setCodingRate4(LORA_CR);
  LoRa.setSyncWord(LORA_SYNC);
  LoRa.setTxPower(LORA_TX_DBM);
  LoRa.enableCrc();
  LoRa.receive();
  Serial.println("[LoRa] ready");
  return true;
}

void setPower(bool on) {
  if (on == peripheralPower) return;
  digitalWrite(PWR_EN_PIN, on ? PWR_ON : PWR_OFF);
  peripheralPower = on;
  Serial.println(on ? F("[PWR] Peripherals ON") : F("[PWR] Peripherals OFF"));
}

/*
 * IRF9540N High-side Power Switch
 * --------------------------------
 * Viewed from front (text side):
 *   Pin 1 = Gate
 *   Pin 2 = Drain
 *   Pin 3 = Source
 *
 * Connections:
 *   3.3V_MAIN -> Source (pin 3)
 *   Drain (pin 2) -> 3.3V_SW -> GPS VCC + LoRa VCC
 *   Gate (pin 1) -> ESP8266 D3 / GPIO0
 *   100k ohm resistor between Source and Gate (pull-up)
 *
 * Logic:
 *   D3 = LOW  -> MOSFET conducts -> GPS + LoRa powered ON
 *   D3 = HIGH -> MOSFET off      -> GPS + LoRa powered OFF
 *
 * Deep sleep note:
 *   For ESP.deepSleep() to work, GPIO16 must be connected to RST.
 *   Otherwise deep sleep wakes up only on external reset.
 */
void initPowerPin() {
  digitalWrite(PWR_EN_PIN, PWR_ON);
  pinMode(PWR_EN_PIN, OUTPUT);
  setPower(true);
}

void updateStationaryStatus() {
  if (!gpsValid) {
    stationaryCount = 0;
    isStationary = false;
    return;
  }

  float dist = 0.0f;
  if (lastLat != 0.0f && lastLng != 0.0f) {
    dist = haversineDistance(lastLat, lastLng, gpsLat, gpsLng);
  }

  if (dist < STATIONARY_DIST_M) {
    stationaryCount++;
  } else {
    stationaryCount = 0;
    isStationary = false;
  }

  if (stationaryCount >= STATIONARY_COUNT && !isStationary) {
    isStationary = true;
    Serial.println(F("[PWR] Vehicle stationary detected"));
  }

  lastLat = gpsLat;
  lastLng = gpsLng;
}

void updateTxInterval() {
  float bat = readBattery();
  unsigned long newInterval = TX_INTERVAL_NORMAL;

  if (isStationary) {
    newInterval = TX_INTERVAL_STATIONARY;
  } else if (bat <= BAT_LOW_PCT) {
    newInterval = TX_INTERVAL_LOW_BAT;
  }

  if (newInterval != currentTxInterval) {
    currentTxInterval = newInterval;
    Serial.printf("[PWR] TX interval -> %lums (bat:%.0f%% stationary:%d)\n",
                  currentTxInterval, bat, isStationary);
  }
}

void enableModemSleep() {
  WiFi.mode(WIFI_OFF);
  WiFi.forceSleepBegin();
  Serial.println(F("[PWR] WiFi modem sleep ON"));
}

void checkCriticalBattery() {
  if (millis() - lastSleepCheck < SLEEP_CHECK_MS) return;
  lastSleepCheck = millis();

  float bat = readBattery();
  if (bat <= 0.0f || bat > BAT_CRITICAL_PCT) return;

  Serial.printf("[PWR] CRITICAL battery %.0f%% - sending alert\n", bat);

  StaticJsonDocument<128> alertDoc;
  alertDoc["vid"] = VEHICLE_ID;
  alertDoc["bat"] = (int)bat;
  alertDoc["alert"] = "critical_battery";
  alertDoc["ts"] = millis();

  char alertBuf[128];
  serializeJson(alertDoc, alertBuf, sizeof(alertBuf));

  if (loraReady) {
    LoRa.beginPacket();
    LoRa.print(alertBuf);
    LoRa.endPacket();
  }

  Serial.println(F("[PWR] Critical battery alert sent - staying awake"));
}

void printPowerStatus() {
  Serial.printf("[PWR] bat:%.0f%% interval:%lums stationary:%d mosfet:%s\n",
                readBattery(),
                currentTxInterval,
                isStationary,
                peripheralPower ? "ON" : "OFF");
}

void setup() {
  Serial.begin(115200);
  ESP.wdtEnable(8000);
  initPowerPin();
  enableModemSleep();
  gpsSerial.begin(GPS_BAUD);
  pinMode(GPS_PPS_PIN, INPUT);
  attachInterrupt(digitalPinToInterrupt(GPS_PPS_PIN), onGpsPps, RISING);

  randomSeed(analogRead(BAT_PIN) ^ micros() ^ ESP.getChipId());
  snprintf(bootId, sizeof(bootId), "%04X", (unsigned int)random(0, 0x10000));
  seq = 0;

  Serial.printf("\nSmart Songthaew Vehicle V03 | %s | boot:%s\n", VEHICLE_ID, bootId);
  loraReady = initLoRa();
  nextTxMs = millis() + vehicleTxOffsetMs() + txJitterMs();
  Serial.printf("[TX-SLOT] pps_pin:D1 offset:%lums guard:%lums jitter_max:%lums\n",
                vehicleTxOffsetMs(), (unsigned long)TX_SYNC_GUARD_MS, (unsigned long)TX_JITTER_MS);
}

void loop() {
  readGPS();
  processPpsSync();

  if (!loraReady && millis() - lastLoRaRetryMs >= 5000UL) {
    lastLoRaRetryMs = millis();
    loraReady = initLoRa();
  }

  if (loraReady) {
    int packetSize = LoRa.parsePacket();
    if (packetSize > 0) onLoRaReceive(packetSize);
  }

  unsigned long now = millis();
  if (now - lastExpireMs >= EXPIRE_INTERVAL_MS) {
    lastExpireMs = now;
    expireNeighbors();
  }

  static unsigned long lastPwrUpdate = 0;
  static bool lastStationary = false;
  if (now - lastPwrUpdate >= currentTxInterval) {
    lastPwrUpdate = now;
    updateStationaryStatus();
    updateTxInterval();
    if (isStationary != lastStationary) {
      lastStationary = isStationary;
      if (isStationary) {
        Serial.println(F("[PWR] Stationary - peripherals stay ON"));
      } else {
        Serial.println(F("[PWR] Moving - peripherals stay ON"));
      }
    }
    if (!peripheralPower) setPower(true);
    checkCriticalBattery();
  }

  if ((long)(now - nextTxMs) >= 0) {
    transmitPacket(nextTxMode);
    scheduleNextTx(now);
  } else if (gpsTxSlotDue()) {
    transmitPacket("gps");
    scheduleNextTx(now);
  }

  yield();
}
