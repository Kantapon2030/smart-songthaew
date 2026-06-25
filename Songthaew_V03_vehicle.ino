/*
 * ════════════════════════════════════════
 *  SMART SONGTHAEW — Vehicle Firmware V03
 * ════════════════════════════════════════
 *  ก่อน Flash ให้แก้ mesh_config.h บรรทัดแรก:
 *  #define VEHICLE_ID "BUS_01"
 *
 *  BUS_01 = รถคันที่ 1
 *  BUS_02 = รถคันที่ 2
 *  BUS_03 = รถคันที่ 3
 * ════════════════════════════════════════
 */

/*
 * ============================================================
 * Smart Songthaew V03 Vehicle Firmware - VIBE LoRa Mesh
 * ESP8266 + GPS6MV2 + optional INA219 + LoRa
 * ============================================================
 *
 * Vehicle nodes do not use WiFi. They broadcast compact JSON over LoRa.
 * The ground station expands compact LoRa aliases into the legacy
 * /api/update-location payload, keeping V02 server compatibility.
 *
 * Required libraries:
 * - LoRa by Sandeep Mistry
 * - TinyGPS++ by Mikal Hart, if USE_REAL_GPS is enabled
 * - Adafruit INA219, if USE_INA219 is enabled
 */

#include <Arduino.h>
#include <SPI.h>
#include <LoRa.h>
#include <math.h>
#include "mesh_config.h"

// Uncomment when the real modules are connected.
// #define USE_REAL_GPS
// #define USE_INA219

#ifdef USE_REAL_GPS
  #include <TinyGPS++.h>
  #include <SoftwareSerial.h>
  #define GPS_RX_PIN 4
  #define GPS_TX_PIN 5
  #define GPS_BAUD 9600
  TinyGPSPlus gps;
  SoftwareSerial gpsSerial(GPS_RX_PIN, GPS_TX_PIN);
#endif

#ifdef USE_INA219
  #include <Wire.h>
  #include <Adafruit_INA219.h>
  Adafruit_INA219 ina219;
  bool ina219Found = false;
#endif

const int NUM_WP = 5;
const float ROUTE[NUM_WP][2] = {
  {8.432450f, 99.959129f},
  {8.432796f, 99.888032f},
  {8.463119f, 99.864281f},
  {8.508510f, 99.827826f},
  {8.522536f, 99.825067f},
};

#define DEG_PER_KM (1.0f / 111.0f)
#define ADC_REF_MV 3300.0f
#define ADC_MAX 1024.0f
#define R1_KOHM 100.0f
#define R2_KOHM 47.0f

struct Neighbor {
  String id;
  unsigned long lastHeardMs;
  int rssi;
  float snr;
  float lat;
  float lng;
  bool hasLocation;
};

Neighbor neighbors[VIBE_NEIGHBOR_TABLE_SIZE];
String dedupIds[VIBE_DEDUP_CACHE_SIZE];
byte dedupCursor = 0;

float curLat = ROUTE[0][0];
float curLng = ROUTE[0][1];
int targetIdx = 1;
bool isOutbound = true;
int curSpeed = 30;
int targetSpeed = 35;
int stopTicks = 0;
int battery = 92;
float headingDeg = 0.0f;
String direction = "O";

float measuredVoltMv = -1;
float measuredCurrentMa = -1;
float measuredPowerMw = -1;
uint32_t seq = 0;
uint32_t txCount = 0;
String bootId;

unsigned long lastBroadcastMs = 0;
unsigned long groundLastHeardMs = 0;
int groundRssi = 0;
float groundSnr = 0;

int keyPos(const String& json, const char* key) {
  String token = "\"" + String(key) + "\":";
  return json.indexOf(token);
}

String rawField(const String& json, const char* key, const String& fallback = "") {
  int pos = keyPos(json, key);
  if (pos < 0) return fallback;
  pos = json.indexOf(':', pos) + 1;
  while (pos < (int)json.length() && json[pos] == ' ') pos++;
  if (pos >= (int)json.length()) return fallback;

  if (json[pos] == '"') {
    int end = json.indexOf('"', pos + 1);
    return end > pos ? json.substring(pos, end + 1) : fallback;
  }
  if (json[pos] == '[') {
    int depth = 0;
    bool inString = false;
    for (int i = pos; i < (int)json.length(); i++) {
      char c = json[i];
      if (c == '"' && (i == 0 || json[i - 1] != '\\')) inString = !inString;
      if (!inString && c == '[') depth++;
      if (!inString && c == ']') {
        depth--;
        if (depth == 0) return json.substring(pos, i + 1);
      }
    }
    return fallback;
  }

  int end = pos;
  while (end < (int)json.length() && json[end] != ',' && json[end] != '}') end++;
  return json.substring(pos, end);
}

String stringField(const String& json, const char* key, const String& fallback = "") {
  String raw = rawField(json, key, fallback);
  if (raw.length() >= 2 && raw[0] == '"' && raw[raw.length() - 1] == '"') {
    return raw.substring(1, raw.length() - 1);
  }
  return raw.length() ? raw : fallback;
}

float floatField(const String& json, const char* key, float fallback = 0) {
  String raw = rawField(json, key, "");
  return raw.length() ? raw.toFloat() : fallback;
}

long longField(const String& json, const char* key, long fallback = 0) {
  String raw = rawField(json, key, "");
  return raw.length() ? raw.toInt() : fallback;
}

float radiansF(float deg) {
  return deg * PI / 180.0f;
}

float distanceMeters(float lat1, float lng1, float lat2, float lng2) {
  const float earth = 6371000.0f;
  float dLat = radiansF(lat2 - lat1);
  float dLng = radiansF(lng2 - lng1);
  float a = sin(dLat / 2) * sin(dLat / 2) +
            cos(radiansF(lat1)) * cos(radiansF(lat2)) *
            sin(dLng / 2) * sin(dLng / 2);
  return earth * 2.0f * atan2(sqrt(a), sqrt(1.0f - a));
}

int linkQuality(int rssi, float snr) {
  int rssiScore = map(constrain(rssi, -125, -45), -125, -45, 0, 70);
  int snrScore = map(constrain((int)(snr * 10), -200, 100), -200, 100, 0, 30);
  return constrain(rssiScore + snrScore, 0, 100);
}

bool seenPacket(const String& packetId) {
  if (!packetId.length()) return false;
  for (byte i = 0; i < VIBE_DEDUP_CACHE_SIZE; i++) {
    if (dedupIds[i] == packetId) return true;
  }
  return false;
}

void rememberPacket(const String& packetId) {
  if (!packetId.length() || seenPacket(packetId)) return;
  dedupIds[dedupCursor] = packetId;
  dedupCursor = (dedupCursor + 1) % VIBE_DEDUP_CACHE_SIZE;
}

bool isGroundFresh() {
  return groundLastHeardMs > 0 && millis() - groundLastHeardMs < NEIGHBOR_EXPIRE_MS;
}

void expireNeighbors() {
  unsigned long now = millis();
  for (byte i = 0; i < VIBE_NEIGHBOR_TABLE_SIZE; i++) {
    if (neighbors[i].id.length() && now - neighbors[i].lastHeardMs > NEIGHBOR_EXPIRE_MS) {
      neighbors[i] = Neighbor();
    }
  }
}

void updateNeighbor(const String& id, int rssi, float snr, float lat, float lng, bool hasLocation) {
  if (!id.length() || id == VEHICLE_ID) return;
  int slot = -1;
  for (byte i = 0; i < VIBE_NEIGHBOR_TABLE_SIZE; i++) {
    if (neighbors[i].id == id) slot = i;
    if (slot < 0 && !neighbors[i].id.length()) slot = i;
  }
  if (slot < 0) {
    unsigned long oldest = ULONG_MAX;
    for (byte i = 0; i < VIBE_NEIGHBOR_TABLE_SIZE; i++) {
      if (neighbors[i].lastHeardMs < oldest) {
        oldest = neighbors[i].lastHeardMs;
        slot = i;
      }
    }
  }
  neighbors[slot].id = id;
  neighbors[slot].lastHeardMs = millis();
  neighbors[slot].rssi = rssi;
  neighbors[slot].snr = snr;
  neighbors[slot].lat = lat;
  neighbors[slot].lng = lng;
  neighbors[slot].hasLocation = hasLocation;
}

String relayChainAppend(String chain, const String& id) {
  if (!chain.length() || chain == "[]") return "[\"" + id + "\"]";
  if (chain.indexOf("\"" + id + "\"") >= 0) return chain;
  int end = chain.lastIndexOf(']');
  if (end < 0) return "[\"" + id + "\"]";
  return chain.substring(0, end) + ",\"" + id + "\"]";
}

bool chainContains(const String& chain, const String& id) {
  return chain.indexOf("\"" + id + "\"") >= 0;
}

String chooseNextHop(const String& chain = "") {
  if (isGroundFresh()) return "GROUND";

  float ownDistance = distanceMeters(curLat, curLng, GROUND_LAT, GROUND_LNG);
  int bestScore = -1;
  String bestId = "";
  unsigned long now = millis();

  for (byte i = 0; i < VIBE_NEIGHBOR_TABLE_SIZE; i++) {
    Neighbor& n = neighbors[i];
    if (!n.id.length() || now - n.lastHeardMs > NEIGHBOR_EXPIRE_MS || !n.hasLocation) continue;
    if (chainContains(chain, n.id)) continue;
    float neighborDistance = distanceMeters(n.lat, n.lng, GROUND_LAT, GROUND_LNG);
    if (neighborDistance + MIN_CLOSER_TO_GROUND_METERS >= ownDistance) continue;
    int score = linkQuality(n.rssi, n.snr) + (int)((ownDistance - neighborDistance) / 50.0f);
    if (score > bestScore) {
      bestScore = score;
      bestId = n.id;
    }
  }

  return bestId.length() ? bestId : "GROUND";
}

String compactNeighbors() {
  String out = "[";
  bool first = true;
  unsigned long now = millis();
  for (byte i = 0; i < VIBE_NEIGHBOR_TABLE_SIZE; i++) {
    Neighbor& n = neighbors[i];
    if (!n.id.length() || now - n.lastHeardMs > NEIGHBOR_EXPIRE_MS) continue;
    String item = String(first ? "" : ",") + "[\"" + n.id + "\"," + String(n.rssi) + "," + String(n.snr, 1) + "]";
    if (out.length() + item.length() + 1 > 70) break;
    out += item;
    first = false;
  }
  out += "]";
  return out;
}

void sendLoRa(const String& payload) {
  if (payload.length() > VIBE_PACKET_MAX_BYTES) {
    Serial.printf("[LoRa] Drop oversized packet: %u bytes\n", payload.length());
    return;
  }
  LoRa.idle();
  LoRa.beginPacket();
  LoRa.print(payload);
  LoRa.endPacket();
  LoRa.receive();
  Serial.printf("[LoRa] TX %uB %s\n", payload.length(), payload.c_str());
}

void measurePower() {
  #ifdef USE_INA219
  if (ina219Found) {
    measuredVoltMv = ina219.getBusVoltage_V() * 1000.0f;
    measuredCurrentMa = ina219.getCurrent_mA();
    measuredPowerMw = ina219.getPower_mW();
    return;
  }
  #endif

  int adc = analogRead(A0);
  float vAtPin = (adc / ADC_MAX) * ADC_REF_MV;
  measuredVoltMv = vAtPin * (R1_KOHM + R2_KOHM) / R2_KOHM;
  measuredCurrentMa = 117.0f + random(0, 30);
  measuredPowerMw = (measuredVoltMv / 1000.0f) * measuredCurrentMa;
}

void runSimulation() {
  if (stopTicks > 0) {
    stopTicks--;
    curSpeed = 0;
  } else {
    int dice = random(0, 100);
    if (dice < 5) {
      stopTicks = random(5, 16);
      targetSpeed = 0;
    } else if (dice < 25) {
      targetSpeed = random(15, 26);
    } else {
      targetSpeed = random(30, 46);
    }

    if (curSpeed < targetSpeed) curSpeed = min(curSpeed + 3, targetSpeed);
    if (curSpeed > targetSpeed) curSpeed = max(curSpeed - 3, targetSpeed);

    if (curSpeed > 0) {
      float tLat = ROUTE[targetIdx][0];
      float tLng = ROUTE[targetIdx][1];
      float dLat = tLat - curLat;
      float dLng = tLng - curLng;
      float dist = sqrt(dLat * dLat + dLng * dLng);
      float step = ((float)curSpeed / 3600.0f) * DEG_PER_KM * 5.0f;
      headingDeg = atan2(dLng, dLat) * 180.0f / PI;
      if (headingDeg < 0) headingDeg += 360.0f;

      if (dist <= step) {
        curLat = tLat;
        curLng = tLng;
        stopTicks = random(10, 31);
        curSpeed = 0;
        if (isOutbound) {
          targetIdx++;
          if (targetIdx >= NUM_WP) {
            targetIdx = NUM_WP - 2;
            isOutbound = false;
          }
        } else {
          targetIdx--;
          if (targetIdx < 0) {
            targetIdx = 1;
            isOutbound = true;
          }
        }
      } else {
        curLat += (dLat / dist) * step;
        curLng += (dLng / dist) * step;
      }
    }
  }

  direction = isOutbound ? "O" : "I";
  if (random(0, 50) == 0) battery--;
  if (battery < 10) battery = 92;
}

void readGps() {
  #ifdef USE_REAL_GPS
  while (gpsSerial.available()) gps.encode(gpsSerial.read());
  if (gps.location.isValid() && gps.location.age() < 3000) {
    curLat = (float)gps.location.lat();
    curLng = (float)gps.location.lng();
    curSpeed = gps.speed.isValid() ? (int)gps.speed.kmph() : 0;
    headingDeg = gps.course.isValid() ? (float)gps.course.deg() : headingDeg;
    direction = headingDeg < 180.0f ? "O" : "I";
  }
  #else
  runSimulation();
  #endif
}

bool hasGpsFix() {
  #ifdef USE_REAL_GPS
  return gps.location.isValid() && gps.location.age() < 3000;
  #else
  return true;
  #endif
}

String buildGpsPacket(const String& packetId, long packetSeq, const String& nextHop, int hop,
                      const String& relayFrom, const String& chain, bool includeNeighbors) {
  int bestRssi = isGroundFresh() ? groundRssi : 0;
  float bestSnr = isGroundFresh() ? groundSnr : 0;
  int lq = isGroundFresh() ? linkQuality(groundRssi, groundSnr) : 0;

  String json = "{";
  json += "\"t\":\"g\"";
  json += ",\"v\":\"" + String(VEHICLE_ID) + "\"";
  json += ",\"q\":" + String(packetSeq);
  json += ",\"b\":\"" + bootId + "\"";
  json += ",\"p\":\"" + packetId + "\"";
  json += ",\"a\":" + String(curLat, 6);
  json += ",\"o\":" + String(curLng, 6);
  json += ",\"s\":" + String(curSpeed);
  json += ",\"hd\":" + String((int)headingDeg);
  json += ",\"bt\":" + String(battery);
  json += ",\"r\":\"" + String(ROUTE_ID) + "\"";
  json += ",\"d\":\"" + direction + "\"";
  json += ",\"hp\":" + String(hop);
  json += ",\"lq\":" + String(lq);
  if (nextHop != "GROUND") json += ",\"nh\":\"" + nextHop + "\"";
  if (!hasGpsFix()) json += ",\"gf\":0";
  if (bestRssi != 0) json += ",\"rs\":" + String(bestRssi);
  if (bestSnr != 0) json += ",\"sn\":" + String(bestSnr, 1);
  if (relayFrom.length()) json += ",\"rf\":\"" + relayFrom + "\"";
  if (chain.length() && chain != "[]") json += ",\"c\":" + chain;
  if (includeNeighbors) json += ",\"n\":" + compactNeighbors();
  json += "}";
  return json;
}

String buildRelayPacket(const String& rx, const String& nextHop, int rssi, float snr) {
  String chain = relayChainAppend(rawField(rx, "c", "[]"), VEHICLE_ID);
  int hop = (int)longField(rx, "hp", 0) + 1;
  String vehicleId = stringField(rx, "v");

  String json = "{";
  json += "\"t\":\"g\"";
  json += ",\"v\":\"" + vehicleId + "\"";
  json += ",\"q\":" + rawField(rx, "q", "0");
  json += ",\"b\":" + rawField(rx, "b", "\"\"");
  json += ",\"p\":" + rawField(rx, "p", "\"\"");
  json += ",\"a\":" + rawField(rx, "a", "0");
  json += ",\"o\":" + rawField(rx, "o", "0");
  json += ",\"s\":" + rawField(rx, "s", "0");
  json += ",\"hd\":" + rawField(rx, "hd", "0");
  json += ",\"bt\":" + rawField(rx, "bt", "-1");
  json += ",\"r\":" + rawField(rx, "r", "\"unassigned\"");
  json += ",\"d\":" + rawField(rx, "d", "\"unknown\"");
  json += ",\"hp\":" + String(hop);
  if (nextHop != "GROUND") json += ",\"nh\":\"" + nextHop + "\"";
  if (nextHop == "GROUND") json += ",\"rf\":\"" + String(VEHICLE_ID) + "\"";
  json += ",\"c\":" + chain;
  json += ",\"lq\":" + String(linkQuality(rssi, snr));
  json += ",\"rs\":" + String(rssi);
  json += ",\"sn\":" + String(snr, 1);
  if (longField(rx, "gf", 1) == 0) json += ",\"gf\":0";
  json += "}";
  return json;
}

void broadcastOwnGps() {
  readGps();
  measurePower();
  expireNeighbors();

  seq++;
  txCount++;
  String packetId = String(VEHICLE_ID) + "-" + bootId + "-" + String(seq);
  rememberPacket(packetId);

  String nextHop = chooseNextHop();
  String packet = buildGpsPacket(packetId, seq, nextHop, 0, "", "[]", true);
  if (packet.length() > VIBE_PACKET_MAX_BYTES) {
    packet = buildGpsPacket(packetId, seq, nextHop, 0, "", "[]", false);
  }
  sendLoRa(packet);

  Serial.printf("[GPS] %s seq:%lu %.6f,%.6f %dkm/h hop:0 next:%s ground:%s\n",
                VEHICLE_ID, (unsigned long)seq, curLat, curLng, curSpeed,
                nextHop.c_str(), isGroundFresh() ? "yes" : "no");
}

void handleBeacon(const String& rx, int rssi, float snr) {
  groundLastHeardMs = millis();
  groundRssi = rssi;
  groundSnr = snr;
  Serial.printf("[Mesh] Beacon %s rssi:%d snr:%.1f lq:%d\n",
                stringField(rx, "sid", "GROUND").c_str(), rssi, snr, linkQuality(rssi, snr));
}

void handleGpsPacket(const String& rx, int rssi, float snr) {
  String packetId = stringField(rx, "p");
  String sourceVehicle = stringField(rx, "v");
  if (!packetId.length() || sourceVehicle == VEHICLE_ID || seenPacket(packetId)) return;
  rememberPacket(packetId);

  float lat = floatField(rx, "a", 0);
  float lng = floatField(rx, "o", 0);
  bool hasLocation = lat != 0 && lng != 0;
  updateNeighbor(sourceVehicle, rssi, snr, lat, lng, hasLocation);

  String nextHop = stringField(rx, "nh", "GROUND");
  int hop = (int)longField(rx, "hp", 0);
  if (nextHop != VEHICLE_ID || hop >= VIBE_MAX_HOPS) return;

  String chain = relayChainAppend(rawField(rx, "c", "[]"), VEHICLE_ID);
  String relayNext = chooseNextHop(chain);
  String relayPacket = buildRelayPacket(rx, relayNext, rssi, snr);
  if (relayPacket.length() <= VIBE_PACKET_MAX_BYTES) {
    sendLoRa(relayPacket);
    Serial.printf("[Relay] %s via %s hop:%d next:%s\n",
                  packetId.c_str(), VEHICLE_ID, hop + 1, relayNext.c_str());
  } else {
    Serial.printf("[Relay] Drop oversized relay %s %uB\n", packetId.c_str(), relayPacket.length());
  }
}

void receiveLoRa() {
  int packetSize = LoRa.parsePacket();
  if (!packetSize) return;

  String rx = "";
  while (LoRa.available()) rx += (char)LoRa.read();
  int rssi = LoRa.packetRssi();
  float snr = LoRa.packetSnr();
  String type = stringField(rx, "t");

  if (type == "b") handleBeacon(rx, rssi, snr);
  if (type == "g") handleGpsPacket(rx, rssi, snr);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  randomSeed(analogRead(A0) ^ micros());
  bootId = String(random(0x1000, 0xFFFF), HEX);
  bootId.toUpperCase();

  Serial.printf("\n=== Smart Songthaew V03 Vehicle %s ===\n", VEHICLE_ID);

  #ifdef USE_REAL_GPS
  gpsSerial.begin(GPS_BAUD);
  #endif

  #ifdef USE_INA219
  ina219Found = ina219.begin();
  if (ina219Found) ina219.setCalibration_32V_2A();
  #endif

  LoRa.setPins(LORA_SS_PIN, LORA_RST_PIN, LORA_DIO0_PIN);
  if (!LoRa.begin(LORA_FREQUENCY)) {
    Serial.println("[LoRa] init failed");
    while (true) yield();
  }
  LoRa.setSignalBandwidth(LORA_BANDWIDTH);
  LoRa.setSpreadingFactor(LORA_SPREADING_FACTOR);
  LoRa.setCodingRate4(LORA_CODING_RATE_DENOMINATOR);
  LoRa.setSyncWord(LORA_SYNC_WORD);
  LoRa.setTxPower(LORA_TX_POWER_DBM);
  LoRa.enableCrc();
  LoRa.receive();

  Serial.println("[LoRa] mesh radio ready");
}

void loop() {
  receiveLoRa();

  #ifdef USE_REAL_GPS
  readGps();
  #endif

  unsigned long now = millis();
  if (now - lastBroadcastMs >= VEHICLE_BROADCAST_INTERVAL_MS) {
    lastBroadcastMs = now;
    broadcastOwnGps();
  }

  yield();
}
