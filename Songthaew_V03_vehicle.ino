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
#include <math.h>
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

TinyGPSPlus gps;
SoftwareSerial gpsSerial(GPS_RX_PIN, -1);

Neighbor neighbors[MAX_NEIGHBORS];
int neighborCount = 0;

char seenPackets[DEDUP_BUFFER][32];
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

unsigned long lastTxMs = 0;
unsigned long lastExpireMs = 0;
unsigned long lastLoRaRetryMs = 0;
bool loraReady = false;

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

int linkQuality(float rssi, float snr) {
  int lq = constrain(map((long)rssi, -120, -60, 0, 100), 0, 100);
  if (snr < 0.0f) lq = constrain(lq - 10, 0, 100);
  return lq;
}

bool sameId(const char* a, const char* b) {
  return strncmp(a, b, 15) == 0;
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

  for (int i = 0; i < neighborCount; i++) {
    if (neighborExpired(neighbors[i], now)) continue;
    if (sameId(neighbors[i].vehicleId, GROUND_ID)) continue;
    if (neighbors[i].lat == 0.0f && neighbors[i].lng == 0.0f) continue;

    float distance = haversineDistance(neighbors[i].lat, neighbors[i].lng, GROUND_LAT, GROUND_LNG);
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
  snprintf(out, outSize, "%s_%lu_%s", VEHICLE_ID, (unsigned long)seq, bootId);
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
  return measureJson(doc) <= MAX_LORA_PACKET_BYTES;
}

bool serializeMeshPacket(JsonDocument& doc, char* out, size_t outSize) {
  if (!packetFits(doc)) return false;
  size_t len = serializeJson(doc, out, outSize);
  return len > 0 && len <= MAX_LORA_PACKET_BYTES;
}

bool sendJson(JsonDocument& doc) {
  if (!loraReady) return false;

  char payload[MAX_LORA_PACKET_BYTES + 1];
  if (!serializeMeshPacket(doc, payload, sizeof(payload))) {
    Serial.println("[TX] drop oversized packet");
    return false;
  }

  LoRa.idle();
  LoRa.beginPacket();
  LoRa.print(payload);
  int result = LoRa.endPacket();
  LoRa.receive();
  return result == 1;
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
  if (gpsValid) {
    gpsLat = gps.location.lat();
    gpsLng = gps.location.lng();
  }
  gpsSpeed = gps.speed.isValid() ? gps.speed.kmph() : 0.0f;
  gpsHeading = gps.course.isValid() ? gps.course.deg() : 0.0f;
  gpsSats = gps.satellites.isValid() ? gps.satellites.value() : 0;
  gpsHdop = gps.hdop.isValid() ? gps.hdop.hdop() : 99.9f;
}

void transmitPacket() {
  Neighbor* ground = findGroundStation();
  Neighbor* relay = ground == nullptr ? findBestRelay() : nullptr;
  bool direct = ground != nullptr;
  int hop = direct ? 0 : (relay ? constrain(relay->hop + 1, 1, MAX_HOPS) : 0);
  float bestRssi = direct ? ground->rssi : (relay ? relay->rssi : 0.0f);
  float bestSnr = direct ? ground->snr : (relay ? relay->snr : 0.0f);

  seq++;
  char packetId[32];
  buildPacketId(packetId, sizeof(packetId));
  markSeen(packetId);

  StaticJsonDocument<512> doc;
  doc["type"] = "vehicle_data";
  doc["vid"] = VEHICLE_ID;
  doc["pid"] = packetId;
  doc["seq"] = seq;
  doc["bid"] = bootId;
  doc["lat"] = gpsValid ? gpsLat : 0.0f;
  doc["lng"] = gpsValid ? gpsLng : 0.0f;
  doc["spd"] = gpsSpeed;
  doc["hdg"] = (int)gpsHeading;
  doc["bat"] = (int)round(readBattery());
  doc["rid"] = ROUTE_ID;
  doc["dir"] = ROUTE_DIR;
  doc["hop"] = hop;
  doc["src"] = "vehicle";
  doc["lq"] = linkQuality(bestRssi, bestSnr);
  doc["fix"] = gpsValid;
  if (bestRssi != 0.0f) doc["rssi"] = (int)bestRssi;
  if (bestSnr != 0.0f) doc["snr"] = bestSnr;
  if (gpsSats > 0) doc["sats"] = gpsSats;
  if (gpsHdop < 99.0f) doc["hdop"] = gpsHdop;
  if (!direct && relay != nullptr) doc["to"] = relay->vehicleId;
  addNeighborArray(doc);

  bool sent = sendJson(doc);
  Serial.printf("[TX] %s hop:%d rssi:%.0f %s\n",
                VEHICLE_ID, hop, bestRssi, sent ? "sent" : "failed");
}

bool chainContainsSelf(JsonVariantConst rc) {
  if (!rc.is<JsonArrayConst>()) return false;
  for (JsonVariantConst item : rc.as<JsonArrayConst>()) {
    const char* id = item.as<const char*>();
    if (id != nullptr && sameId(id, VEHICLE_ID)) return true;
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

  if (sameId(sourceVid, VEHICLE_ID)) return false;
  if (sameId(relayFrom, VEHICLE_ID)) return false;
  if (relayTo[0] != '\0' && !sameId(relayTo, VEHICLE_ID)) return false;
  if (chainContainsSelf(doc["rc"])) return false;
  if (hop >= MAX_HOPS) return false;
  if (isGroundStationNearby()) return false;
  return true;
}

void relayVehiclePacket(JsonDocument& doc, int hop, float rssi, float snr) {
  doc["hop"] = hop + 1;
  doc["rf"] = VEHICLE_ID;
  doc["rssi"] = (int)rssi;
  doc["snr"] = snr;
  doc["lq"] = linkQuality(rssi, snr);
  doc.remove("nb");
  doc.remove("to");
  appendSelfToChain(doc);

  bool sent = sendJson(doc);
  Serial.printf("[RELAY] %s hop:%d rssi:%.0f %s\n",
                (const char*)(doc["vid"] | "?"), hop + 1, rssi, sent ? "sent" : "failed");
}

void handleBeacon(JsonDocument& doc, float rssi, float snr) {
  const char* stationId = doc["sid"] | GROUND_ID;
  float lat = doc["lat"] | GROUND_LAT;
  float lng = doc["lng"] | GROUND_LNG;
  updateNeighbor(stationId, rssi, snr, lat, lng);
  Serial.printf("[RX] beacon %s rssi:%.0f snr:%.1f\n", stationId, rssi, snr);
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

  if (shouldRelay(doc, hop)) {
    relayVehiclePacket(doc, hop, rssi, snr);
  }
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

  StaticJsonDocument<512> doc;
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

void setup() {
  Serial.begin(115200);
  gpsSerial.begin(GPS_BAUD);

  randomSeed(analogRead(BAT_PIN) ^ micros() ^ ESP.getChipId());
  snprintf(bootId, sizeof(bootId), "%04X", (unsigned int)random(0, 0x10000));
  seq = 0;

  Serial.printf("\nSmart Songthaew Vehicle V03 | %s | boot:%s\n", VEHICLE_ID, bootId);
  loraReady = initLoRa();
}

void loop() {
  readGPS();

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

  if (now - lastTxMs >= TX_INTERVAL_MS) {
    lastTxMs = now;
    transmitPacket();
  }

  yield();
}
