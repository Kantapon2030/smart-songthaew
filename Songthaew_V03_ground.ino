// Songthaew_V03_ground.ino
/*
  Smart Songthaew VIBE Mesh - Ground Station Firmware V03

  ESP8266 NodeMCU -> SX1276 Ra-02
  D5 (GPIO14) -> SCK
  D6 (GPIO12) -> MISO
  D7 (GPIO13) -> MOSI
  D8 (GPIO15) -> NSS/CS
  D0 (GPIO16) -> RESET
  D2 (GPIO4)  -> DIO0
  3V3         -> VCC
  GND         -> GND

  Power: USB 5V -> NodeMCU USB port
  WiFi: connects to WIFI_SSID from songthaew_secrets.h
*/

#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266WiFi.h>
#include <LoRa.h>
#include <SPI.h>
#include <WiFiClientSecure.h>
#if __has_include("songthaew_secrets.h")
#include "songthaew_secrets.h"
#else
#error "Create songthaew_secrets.h from songthaew_secrets.example.h before flashing."
#endif
#include "mesh_config.h"

struct BufferedPacket {
  String body;
  bool used;
  unsigned long timestamp;
};

#define DEDUP_CACHE_SIZE 30
#define DEDUP_EXPIRE_MS  30000UL
#define DEDUP_PACKET_ID_LEN 48
#define SEEN_VEHICLE_SIZE 20
#define HEARTBEAT_INTERVAL_MS 30000UL
#define SEEN_VEHICLE_EXPIRE_MS 90000UL

struct DedupEntry {
  char packetId[DEDUP_PACKET_ID_LEN];
  uint32_t seenAtMs;
};

struct SeenVehicle {
  char vehicleId[16];
  float rssi;
  float snr;
  unsigned long lastSeenMs;
  unsigned long lastHeartbeatMs;
  bool used;
};

BufferedPacket packetBuffer[BUFFER_SIZE];
DedupEntry dedupCache[DEDUP_CACHE_SIZE];
SeenVehicle seenVehicles[SEEN_VEHICLE_SIZE];
int dedupHead = 0;

bool wifiConnected = false;
bool loraReady = false;
unsigned long lastWifiCheckMs = 0;
unsigned long lastBeaconMs = 0;
unsigned long lastFlushMs = 0;
unsigned long lastLoRaRetryMs = 0;
unsigned long lastHttpLatencyMs = 0;
unsigned long ledPulseUntilMs = 0;
String lastHttpResponse = "";
bool ledPulseActive = false;

bool isVehiclePacket(JsonDocument& doc) {
  const char* type = doc["type"] | "";
  const char* compactType = doc["t"] | "";
  return strcmp(type, "vehicle_data") == 0 || strcmp(compactType, "vd") == 0;
}

bool isValidThailandCoord(float lat, float lng);
int postToServer(String body);

void beginLedPulse(unsigned long durationMs) {
  ledPulseActive = true;
  ledPulseUntilMs = millis() + durationMs;
  digitalWrite(LED_BUILTIN, LOW);
}

void serviceStatusLed() {
  if (ledPulseActive && (long)(millis() - ledPulseUntilMs) >= 0) {
    ledPulseActive = false;
    digitalWrite(LED_BUILTIN, HIGH);
  }
}

bool isCompactVehiclePacket(JsonDocument& doc) {
  return doc["id"].is<const char*>() && doc["pk"].is<const char*>() && doc.containsKey("ts");
}

String expandDirection(const char* code) {
  if (!code || code[0] == '\0') return "unknown";
  if (code[0] == 'I') return "inbound";
  if (code[0] == 'O') return "outbound";
  return "unknown";
}

String expandRouteId(const char* shortId) {
  if (!shortId || shortId[0] == '\0') return "unassigned";
  if (shortId[0] == 'R') {
    int number = atoi(shortId + 1);
    if (number > 0) {
      char route[16];
      snprintf(route, sizeof(route), "route_%03d", number);
      return String(route);
    }
  }
  return String(shortId);
}

String expandVehicleId(const char* shortId) {
  if (!shortId || shortId[0] == '\0') return "";
  if (strncmp(shortId, "BUS_", 4) == 0 ||
      strncmp(shortId, "DEMO_", 5) == 0 ||
      strncmp(shortId, "GROUND_", 7) == 0) {
    return String(shortId);
  }

  int number = atoi(shortId + 1);
  char out[16];
  if (shortId[0] == 'B' && number > 0) {
    snprintf(out, sizeof(out), "BUS_%02d", number);
    return String(out);
  }
  if (shortId[0] == 'D' && number > 0) {
    snprintf(out, sizeof(out), "DEMO_%d", number);
    return String(out);
  }
  if (shortId[0] == 'G' && number > 0) {
    snprintf(out, sizeof(out), "GROUND_%02d", number);
    return String(out);
  }
  return String(shortId);
}

String decodeNeighborsCompact(const String& compact) {
  if (compact.length() == 0) return "[]";

  String result = "[";
  bool first = true;
  int start = 0;

  while (start < (int)compact.length()) {
    int comma = compact.indexOf(',', start);
    String entry = (comma < 0) ? compact.substring(start) : compact.substring(start, comma);
    start = (comma < 0) ? compact.length() : comma + 1;

    int c1 = entry.indexOf(':');
    int c2 = entry.indexOf(':', c1 + 1);
    if (c1 < 0 || c2 < 0) continue;

    String nbId = expandVehicleId(entry.substring(0, c1).c_str());
    int nbRssi = entry.substring(c1 + 1, c2).toInt();
    float nbSnr = entry.substring(c2 + 1).toInt() / 10.0f;

    if (!first) result += ",";
    result += "{\"vehicle_id\":\"" + nbId + "\",";
    result += "\"rssi\":" + String(nbRssi) + ",";
    result += "\"snr\":" + String(nbSnr, 1) + "}";
    first = false;
  }

  result += "]";
  return result;
}

String decodeRelayChainCompact(const String& compact) {
  if (compact.length() == 0) return "[]";

  String result = "[";
  bool first = true;
  int start = 0;

  while (start < (int)compact.length()) {
    int comma = compact.indexOf(',', start);
    String entry = (comma < 0) ? compact.substring(start) : compact.substring(start, comma);
    start = (comma < 0) ? compact.length() : comma + 1;
    entry.trim();
    if (entry.length() == 0) continue;

    if (!first) result += ",";
    result += "\"" + expandVehicleId(entry.c_str()) + "\"";
    first = false;
  }

  result += "]";
  return result;
}

String decodeVersionSummary(const String& compact) {
  if (compact.length() == 0) return "[]";

  String result = "[";
  bool first = true;
  int start = 0;

  while (start < (int)compact.length()) {
    int comma = compact.indexOf(',', start);
    String entry = (comma < 0) ? compact.substring(start) : compact.substring(start, comma);
    start = (comma < 0) ? compact.length() : comma + 1;

    int c1 = entry.indexOf(':');
    int c2 = entry.indexOf(':', c1 + 1);
    if (c1 < 0) continue;

    String vsId = expandVehicleId(entry.substring(0, c1).c_str());
    int vsSeq = c2 < 0 ? entry.substring(c1 + 1).toInt() : entry.substring(c1 + 1, c2).toInt();
    String vsBootPx = c2 < 0 ? "" : entry.substring(c2 + 1);

    if (!first) result += ",";
    result += "{\"vehicle_id\":\"" + vsId + "\",";
    result += "\"seq\":" + String(vsSeq);
    if (vsBootPx.length() > 0) result += ",\"boot_id_prefix\":\"" + vsBootPx + "\"";
    result += "}";
    first = false;
  }

  result += "]";
  return result;
}

void copyArrayJsonField(JsonDocument& out, const char* key, const String& arrayJson) {
  if (arrayJson.length() <= 2) return;

  StaticJsonDocument<384> temp;
  DeserializationError err = deserializeJson(temp, arrayJson);
  if (err || !temp.is<JsonArray>()) return;
  out[key] = temp.as<JsonArray>();
}

bool decodeCompactPacket(const String& raw, JsonDocument& out) {
  StaticJsonDocument<512> compact;
  DeserializationError err = deserializeJson(compact, raw);
  if (err) return false;
  if (!compact.containsKey("id") || !compact.containsKey("ts") || !compact.containsKey("pk")) return false;

  String vehicleId = expandVehicleId(compact["id"] | "");
  uint32_t packetSeq = compact["sq"] | 0UL;
  const char* bootId = compact["bi"] | "";
  const char* packetHash = compact["pk"] | "";
  String packetId = vehicleId + "_" + String(packetSeq) + "_" + String(bootId) + "_" + String(packetHash);

  out.clear();
  out["vehicleId"] = vehicleId;
  out["vehicle_id"] = vehicleId;
  out["seq"] = packetSeq;
  out["boot_id"] = bootId;
  out["gps_timestamp"] = compact["ts"] | 0UL;
  float lat = compact["la"].is<const char*>() ? atof(compact["la"] | "0") : (compact["la"] | 0.0f);
  float lng = compact["ln"].is<const char*>() ? atof(compact["ln"] | "0") : (compact["ln"] | 0.0f);
  bool coordValid = isValidThailandCoord(lat, lng);
  bool gpsFix = compact.containsKey("fx") ? ((compact["fx"] | 0) == 1) : coordValid;
  if (gpsFix && coordValid) {
    out["lat"] = lat;
    out["lng"] = lng;
  }
  out["speed"] = compact["sp"] | 0;
  out["battery"] = compact["bt"] | -1;
  out["hop"] = compact["hp"] | 0;
  out["packet_id"] = packetId;
  out["packet_hash"] = packetHash;
  out["ttl"] = compact["tt"] | 0;

  if (compact.containsKey("hd")) out["heading"] = compact["hd"].as<int>();
  if (compact.containsKey("ri")) out["routeId"] = expandRouteId(compact["ri"].as<const char*>());
  if (compact.containsKey("ri")) out["route_id"] = expandRouteId(compact["ri"].as<const char*>());
  if (compact.containsKey("dr")) out["direction"] = expandDirection(compact["dr"].as<const char*>());
  if (compact.containsKey("rf")) out["relay_from"] = expandVehicleId(compact["rf"].as<const char*>());
  if (compact.containsKey("lq")) out["link_quality"] = compact["lq"].as<int>();
  if (compact.containsKey("sf")) out["store_forward"] = compact["sf"].as<int>() == 1;

  if (!out.containsKey("routeId")) {
    out["routeId"] = ROUTE_ID;
    out["route_id"] = ROUTE_ID;
  }
  if (!out.containsKey("direction")) out["direction"] = ROUTE_DIR;

  if (compact.containsKey("nb")) copyArrayJsonField(out, "neighbors", decodeNeighborsCompact(compact["nb"].as<String>()));
  if (compact.containsKey("rc")) copyArrayJsonField(out, "relay_chain", decodeRelayChainCompact(compact["rc"].as<String>()));
  if (compact.containsKey("vs")) copyArrayJsonField(out, "version_summary", decodeVersionSummary(compact["vs"].as<String>()));

  out["source"] = "ground_station";
  out["relay_via"] = "lora";
  out["gps_fix"] = gpsFix && coordValid;
  out["received_rssi"] = LoRa.packetRssi();
  out["received_snr"] = LoRa.packetSnr();
  out["received_at"] = millis();

  return true;
}

bool isValidThailandCoord(float lat, float lng) {
  return lat >= 5.5f && lat <= 20.5f && lng >= 97.5f && lng <= 105.7f;
}

bool isDuplicate(const char* packetId) {
  if (packetId == nullptr || packetId[0] == '\0') return false;
  uint32_t now = millis();

  for (int i = 0; i < DEDUP_CACHE_SIZE; i++) {
    if (dedupCache[i].packetId[0] == '\0') continue;

    if (now - dedupCache[i].seenAtMs > DEDUP_EXPIRE_MS) {
      dedupCache[i].packetId[0] = '\0';
      dedupCache[i].seenAtMs = 0;
      continue;
    }

    if (strcmp(dedupCache[i].packetId, packetId) == 0) return true;
  }

  strncpy(dedupCache[dedupHead].packetId, packetId, DEDUP_PACKET_ID_LEN - 1);
  dedupCache[dedupHead].packetId[DEDUP_PACKET_ID_LEN - 1] = '\0';
  dedupCache[dedupHead].seenAtMs = now;
  dedupHead = (dedupHead + 1) % DEDUP_CACHE_SIZE;
  return false;
}

int findSeenVehicleIndex(const char* vehicleId) {
  if (vehicleId == nullptr || vehicleId[0] == '\0') return -1;
  for (int i = 0; i < SEEN_VEHICLE_SIZE; i++) {
    if (seenVehicles[i].used && strncmp(seenVehicles[i].vehicleId, vehicleId, sizeof(seenVehicles[i].vehicleId)) == 0) {
      return i;
    }
  }
  return -1;
}

int seenVehicleSlotFor(const char* vehicleId) {
  int index = findSeenVehicleIndex(vehicleId);
  if (index >= 0) return index;

  for (int i = 0; i < SEEN_VEHICLE_SIZE; i++) {
    if (!seenVehicles[i].used) return i;
  }

  int oldest = 0;
  for (int i = 1; i < SEEN_VEHICLE_SIZE; i++) {
    if (seenVehicles[i].lastSeenMs < seenVehicles[oldest].lastSeenMs) oldest = i;
  }
  return oldest;
}

void noteVehicleSeen(const char* vehicleId, float rssi, float snr) {
  if (vehicleId == nullptr || vehicleId[0] == '\0') return;
  int index = seenVehicleSlotFor(vehicleId);
  if (index < 0) return;

  strncpy(seenVehicles[index].vehicleId, vehicleId, sizeof(seenVehicles[index].vehicleId) - 1);
  seenVehicles[index].vehicleId[sizeof(seenVehicles[index].vehicleId) - 1] = '\0';
  seenVehicles[index].rssi = rssi;
  seenVehicles[index].snr = snr;
  seenVehicles[index].lastSeenMs = millis();
  seenVehicles[index].used = true;
}

void serviceVehicleHeartbeats() {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) return;

  unsigned long now = millis();
  for (int i = 0; i < SEEN_VEHICLE_SIZE; i++) {
    if (!seenVehicles[i].used) continue;
    if (now - seenVehicles[i].lastSeenMs > SEEN_VEHICLE_EXPIRE_MS) {
      seenVehicles[i].used = false;
      seenVehicles[i].vehicleId[0] = '\0';
      continue;
    }
    if (now - seenVehicles[i].lastHeartbeatMs < HEARTBEAT_INTERVAL_MS) continue;

    StaticJsonDocument<256> hb;
    hb["vehicleId"] = seenVehicles[i].vehicleId;
    hb["heartbeat"] = true;
    hb["source"] = "ground_station";
    hb["relay_via"] = "lora";
    hb["routeId"] = ROUTE_ID;
    hb["route_id"] = ROUTE_ID;
    hb["direction"] = ROUTE_DIR;
    hb["received_rssi"] = seenVehicles[i].rssi;
    hb["received_snr"] = seenVehicles[i].snr;

    String body;
    serializeJson(hb, body);
    seenVehicles[i].lastHeartbeatMs = now;
    int code = postToServer(body);
    Serial.printf("[HEARTBEAT] %s code:%d rssi:%.0f snr:%.1f\n",
                  seenVehicles[i].vehicleId, code, seenVehicles[i].rssi, seenVehicles[i].snr);
    yield();
  }
}

int oldestBufferIndex() {
  int oldest = -1;
  for (int i = 0; i < BUFFER_SIZE; i++) {
    if (!packetBuffer[i].used) continue;
    if (oldest < 0 || packetBuffer[i].timestamp < packetBuffer[oldest].timestamp) {
      oldest = i;
    }
  }
  return oldest;
}

int firstFreeBufferIndex() {
  for (int i = 0; i < BUFFER_SIZE; i++) {
    if (!packetBuffer[i].used) return i;
  }
  return -1;
}

void bufferPacket(String body) {
  int slot = firstFreeBufferIndex();
  if (slot < 0) {
    slot = oldestBufferIndex();
    Serial.printf("[BUFFER] full, dropping oldest slot:%d\n", slot);
  }

  if (slot < 0) return;
  packetBuffer[slot].body = body;
  packetBuffer[slot].used = true;
  packetBuffer[slot].timestamp = millis();
  Serial.printf("[BUFFER] queued slot:%d\n", slot);
}

void freeBufferSlot(int index) {
  if (index < 0 || index >= BUFFER_SIZE) return;
  packetBuffer[index].body = "";
  packetBuffer[index].used = false;
  packetBuffer[index].timestamp = 0;
}

int postToServer(String body) {
  lastHttpLatencyMs = 0;
  lastHttpResponse = "";
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) return -1;

  unsigned long started = millis();
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  int code = -1;
  if (http.begin(client, SERVER_URL)) {
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(8000);
    code = http.POST(body);
    lastHttpResponse = http.getString();
    http.end();
  }

  lastHttpLatencyMs = millis() - started;
  Serial.printf("[HTTP] %d %lums\n", code, lastHttpLatencyMs);
  if (lastHttpResponse.length() > 0) {
    Serial.print("[HTTP_BODY] ");
    Serial.println(lastHttpResponse.substring(0, 180));
  }
  if (code < 200 || code >= 300) Serial.printf("[POST] fail code:%d\n", code);
  return code;
}

void flushBuffer() {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) return;

  while (WiFi.status() == WL_CONNECTED) {
    int index = oldestBufferIndex();
    if (index < 0) return;

    int code = postToServer(packetBuffer[index].body);
    if (code >= 200 && code < 300) {
      freeBufferSlot(index);
    } else if (code >= 400 && code < 500) {
      Serial.printf("[BUFFER] dropping bad packet code:%d slot:%d\n", code, index);
      freeBufferSlot(index);
    } else {
      return;
    }
    yield();
  }

  wifiConnected = false;
}

void serviceWiFi() {
  unsigned long now = millis();
  if (now - lastWifiCheckMs < WIFI_RETRY_MS && lastWifiCheckMs != 0) return;
  lastWifiCheckMs = now;

  wifiConnected = WiFi.status() == WL_CONNECTED;
  if (wifiConnected) return;

  Serial.println("[WiFi] reconnecting");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void waitInitialWiFi() {
  unsigned long started = millis();
  while (millis() - started < WIFI_SETUP_TIMEOUT_MS) {
    wifiConnected = WiFi.status() == WL_CONNECTED;
    if (wifiConnected) {
      Serial.printf("[WiFi] connected IP:%s\n", WiFi.localIP().toString().c_str());
      return;
    }
    yield();
  }
  wifiConnected = false;
  Serial.println("[WiFi] setup timeout, continuing offline");
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

void sendBeacon() {
  if (!loraReady) return;

  StaticJsonDocument<160> doc;
  doc["type"] = "beacon";
  doc["sid"] = GROUND_ID;
  doc["lat"] = GROUND_LAT;
  doc["lng"] = GROUND_LNG;
  doc["ts"] = millis();

  char payload[160];
  serializeJson(doc, payload, sizeof(payload));

  LoRa.idle();
  LoRa.beginPacket();
  LoRa.print(payload);
  LoRa.endPacket();
  LoRa.receive();
  Serial.println("[BEACON] sent");
}

void addRelayChain(JsonDocument& source, JsonDocument& target) {
  JsonArray sourceChain;
  if (source["relay_chain"].is<JsonArray>()) sourceChain = source["relay_chain"].as<JsonArray>();
  if (source["rc"].is<JsonArray>()) sourceChain = source["rc"].as<JsonArray>();
  if (sourceChain.isNull()) return;

  JsonArray out = target.createNestedArray("relay_chain");
  for (JsonVariant item : sourceChain) {
    out.add(item.as<const char*>());
  }
}

void addNeighbors(JsonDocument& source, JsonDocument& target) {
  JsonArray out = target.createNestedArray("neighbors");
  if (source["neighbors"].is<JsonArray>()) {
    for (JsonVariant item : source["neighbors"].as<JsonArray>()) {
      out.add(item);
    }
    return;
  }

  if (source["nb"].is<JsonArray>()) {
    for (JsonVariant item : source["nb"].as<JsonArray>()) {
      JsonObject neighbor = out.createNestedObject();
      neighbor["vehicle_id"] = item["id"] | "";
      neighbor["rssi"] = item["rs"] | 0;
      neighbor["snr"] = item["sn"] | 0.0f;
    }
  }

  if (out.size() == 0) target.remove("neighbors");
}

void addVersionSummary(JsonDocument& source, JsonDocument& target) {
  if (!source["vs"].is<JsonArray>()) return;

  JsonArray out = target.createNestedArray("version_summary");
  for (JsonVariant item : source["vs"].as<JsonArray>()) {
    if (!item.is<JsonArray>()) continue;
    JsonArray values = item.as<JsonArray>();
    JsonObject row = out.createNestedObject();
    row["vehicle_id"] = values[0] | "";
    row["seq"] = values[1] | 0;
    if (values.size() > 2) row["gps_timestamp"] = values[2] | 0UL;
  }

  if (out.size() == 0) target.remove("version_summary");
}

String buildServerPayload(JsonDocument& rx, float receivedRssi, float receivedSnr) {
  StaticJsonDocument<1024> out;
  float lat = rx["lat"] | 0.0f;
  float lng = rx["lng"] | 0.0f;
  bool gpsFix = (rx["fix"] | true) && isValidThailandCoord(lat, lng);

  out["vehicleId"] = rx["vid"] | "";
  out["vehicle_id"] = rx["vid"] | "";
  if (gpsFix) {
    out["lat"] = lat;
    out["lng"] = lng;
  }
  out["speed"] = rx["spd"] | 0.0f;
  out["battery"] = rx["bat"] | -1;
  out["routeId"] = rx["rid"] | ROUTE_ID;
  out["route_id"] = rx["rid"] | ROUTE_ID;
  out["direction"] = rx["dir"] | ROUTE_DIR;
  out["rssi"] = receivedRssi;
  out["snr"] = receivedSnr;
  out["hop"] = rx["hop"] | 0;
  out["link_quality"] = rx["lq"] | 0;
  out["seq"] = rx["seq"] | 0;
  out["boot_id"] = rx["bid"] | "";
  out["packet_id"] = rx["pid"] | "";
  out["gps_timestamp"] = rx["gt"] | 0UL;
  out["ttl"] = rx["ttl"] | -1;
  out["store_forward"] = (rx["sf"] | 0) == 1;
  out["source"] = "vehicle";
  out["gps_fix"] = gpsFix;
  out["received_rssi"] = receivedRssi;
  out["received_snr"] = receivedSnr;
  out["received_at"] = millis();

  if (rx["hdg"].is<int>()) out["heading"] = rx["hdg"];
  if (rx["rf"].is<const char*>()) out["relay_from"] = rx["rf"];
  if (rx["sats"].is<int>()) out["sats"] = rx["sats"];
  if (rx["hdop"].is<float>()) out["hdop"] = rx["hdop"];

  addRelayChain(rx, out);
  addNeighbors(rx, out);
  addVersionSummary(rx, out);

  String body;
  serializeJson(out, body);
  return body;
}

void printReceiveLog(JsonDocument& rx, float rssi, float snr, int code) {
  const char* vid = rx["vid"] | "?";
  int hop = rx["hop"] | 0;
  float lat = rx["lat"] | 0.0f;
  float lng = rx["lng"] | 0.0f;
  float spd = rx["spd"] | 0.0f;
  int bat = rx["bat"] | -1;

  Serial.println("--------------------");
  Serial.printf("[RX] %s | hop:%d | rssi:%.0f | snr:%.1f\n", vid, hop, rssi, snr);
  Serial.printf("lat:%.6f lng:%.6f | spd:%.1fkm/h | bat:%d%%\n", lat, lng, spd, bat);
  if (code >= 200 && code < 300) {
    Serial.printf("-> HTTP %d (%lums)\n", code, lastHttpLatencyMs);
  } else if (code >= 400 && code < 500) {
    Serial.printf("-> HTTP %d drop (%lums)\n", code, lastHttpLatencyMs);
  } else {
    Serial.printf("-> buffered code:%d wifi_status:%d\n", code, WiFi.status());
  }
  Serial.println("--------------------");
}

void printPostLog(JsonDocument& post, int code) {
  const char* vid = post["vehicleId"].is<const char*>() ? post["vehicleId"] : (post["vehicle_id"] | "?");
  int hop = post["hop"] | 0;
  float lat = post["lat"] | 0.0f;
  float lng = post["lng"] | 0.0f;
  float spd = post["speed"] | 0.0f;
  int bat = post["battery"] | -1;
  float rssi = post["received_rssi"] | 0.0f;
  float snr = post["received_snr"] | 0.0f;

  Serial.println("--------------------");
  Serial.printf("[RX] %s | hop:%d | rssi:%.0f | snr:%.1f\n", vid, hop, rssi, snr);
  Serial.printf("lat:%.6f lng:%.6f | spd:%.1fkm/h | bat:%d%%\n", lat, lng, spd, bat);
  if (code >= 200 && code < 300) {
    Serial.printf("-> HTTP %d (%lums)\n", code, lastHttpLatencyMs);
  } else if (code >= 400 && code < 500) {
    Serial.printf("-> HTTP %d drop (%lums)\n", code, lastHttpLatencyMs);
  } else {
    Serial.printf("-> buffered code:%d wifi_status:%d\n", code, WiFi.status());
  }
  Serial.println("--------------------");
}

void onLoRaReceive(int packetSize) {
  if (packetSize <= 0) return;

  char payload[256];
  int len = 0;
  while (LoRa.available() && len < (int)sizeof(payload) - 1) {
    payload[len++] = (char)LoRa.read();
  }
  payload[len] = '\0';

  float receivedRssi = LoRa.packetRssi();
  float receivedSnr = LoRa.packetSnr();

  String raw(payload);
  StaticJsonDocument<768> rx;
  DeserializationError error = deserializeJson(rx, payload);
  if (error) {
    Serial.printf("[RX] invalid json: %s\n", error.c_str());
    return;
  }

  StaticJsonDocument<1536> postDoc;
  String body;
  bool compactPacket = isCompactVehiclePacket(rx);
  if (compactPacket) {
    if (!decodeCompactPacket(raw, postDoc)) {
      Serial.println("[RX] compact decode failed");
      return;
    }
    serializeJson(postDoc, body);
  } else {
    if (!isVehiclePacket(rx)) return;
    body = buildServerPayload(rx, receivedRssi, receivedSnr);
  }

  const char* packetId = compactPacket ? (postDoc["packet_id"] | "") : (rx["pid"] | "");
  const char* seenVehicleId = compactPacket ? (postDoc["vehicleId"] | "") : (rx["vid"] | "");
  noteVehicleSeen(seenVehicleId, receivedRssi, receivedSnr);
  if (isDuplicate(packetId)) {
    Serial.printf("[DEDUP] skip duplicate: %s\n", packetId[0] ? packetId : "?");
    return;
  }

  int code = wifiConnected && WiFi.status() == WL_CONNECTED ? postToServer(body) : -1;
  bool ok = code >= 200 && code < 300;
  bool badPacket = code >= 400 && code < 500;

  if (!ok && !badPacket) bufferPacket(body);
  beginLedPulse(ok ? 80UL : (badPacket ? 800UL : 250UL));
  if (compactPacket) {
    printPostLog(postDoc, code);
  } else {
    printReceiveLog(rx, receivedRssi, receivedSnr, code);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.printf("\nSmart Songthaew Ground V03 | %s\n", GROUND_ID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  waitInitialWiFi();

  loraReady = initLoRa();
}

void loop() {
  serviceStatusLed();
  serviceWiFi();

  if (!loraReady && millis() - lastLoRaRetryMs >= 5000UL) {
    lastLoRaRetryMs = millis();
    loraReady = initLoRa();
  }

  if (loraReady) {
    int packetSize = LoRa.parsePacket();
    if (packetSize > 0) onLoRaReceive(packetSize);
  }

  unsigned long now = millis();
  if (now - lastBeaconMs >= BEACON_INTERVAL_MS) {
    lastBeaconMs = now;
    sendBeacon();
  }

  if (now - lastFlushMs >= FLUSH_INTERVAL_MS) {
    lastFlushMs = now;
    flushBuffer();
  }

  serviceVehicleHeartbeats();

  yield();
}
