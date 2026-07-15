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
#if defined(SONGTHAEW_CI_BUILD)
#include "songthaew_secrets.example.h"
#elif __has_include("songthaew_secrets.h")
#include "songthaew_secrets.h"
#else
#error "Create songthaew_secrets.h from songthaew_secrets.example.h before flashing."
#endif
#include "mesh_config.h"

#ifndef GROUND_KEY
#define GROUND_KEY ""
#endif

struct BufferedPacket {
  char payload[MAX_LORA_PACKET_BYTES + 1];
  float rssi;
  float snr;
  bool used;
  uint8_t attempts;
  unsigned long timestamp;
};

#define DEDUP_CACHE_SIZE 12
#define DEDUP_EXPIRE_MS  30000UL
#define DEDUP_PACKET_ID_LEN 48
#define SEEN_VEHICLE_SIZE VEHICLE_COUNT
#define SEEN_VEHICLE_EXPIRE_MS 90000UL
#define GROUND_RX_QUIET_MS 500UL
#define GROUND_HTTP_FLUSH_INTERVAL_MS 500UL
#define GROUND_METRICS_INTERVAL_MS 30000UL

struct DedupEntry {
  char packetId[DEDUP_PACKET_ID_LEN];
  uint32_t seenAtMs;
};

struct SeenVehicle {
  char vehicleId[16];
  float rssi;
  float snr;
  unsigned long lastSeenMs;
  uint32_t rxCount;
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
unsigned long lastBatchBeaconMs = 0;
unsigned long lastLoRaRetryMs = 0;
unsigned long lastHttpLatencyMs = 0;
unsigned long ledPulseUntilMs = 0;
unsigned long lastRxMs = 0;
bool ledPulseActive = false;
uint8_t consecutiveHttpFailures = 0;
unsigned long lastForcedWifiReconnectMs = 0;
unsigned long lastMetricsMs = 0;
uint32_t packetsQueued = 0;
uint32_t packetsSent = 0;
uint32_t packetsRetried = 0;
uint32_t packetsDropped = 0;

bool isVehiclePacket(JsonDocument& doc) {
  const char* type = doc["type"] | "";
  const char* compactType = doc["t"] | "";
  return strcmp(type, "vehicle_data") == 0 || strcmp(compactType, "vd") == 0;
}

bool isValidForcedHopCompletion(JsonDocument& doc, bool compactPacket) {
  int hop = compactPacket ? (doc["hop"] | -1) : (doc["hop"] | -1);
  const char* relayFrom = compactPacket ? (doc["relay_from"] | "") : (doc["rf"] | "");
  if (hop != FORCED_HOP_TEST_EXPECTED_HOPS || strcmp(relayFrom, FORCED_HOP_TEST_RELAY_2) != 0) return false;

  JsonArray chain = compactPacket ? doc["relay_chain"].as<JsonArray>() : doc["rc"].as<JsonArray>();
  if (chain.isNull() || chain.size() != 2) return false;
  const char* firstRelay = chain[0] | "";
  const char* secondRelay = chain[1] | "";
  return strcmp(firstRelay, FORCED_HOP_TEST_RELAY_1) == 0 &&
         strcmp(secondRelay, FORCED_HOP_TEST_RELAY_2) == 0;
}

bool isValidThailandCoord(float lat, float lng);
int postBatchToServer(const String& body);
void bufferPacket(const char* payload, float rssi, float snr);
int bufferCount();
bool decodeCompactPacket(const String& raw, JsonDocument& out);
String buildServerPayload(JsonDocument& rx, float receivedRssi, float receivedSnr);

void forceWifiReconnect(const char* reason) {
  unsigned long now = millis();
  if (now - lastForcedWifiReconnectMs < 10000UL && lastForcedWifiReconnectMs != 0) return;
  lastForcedWifiReconnectMs = now;
  wifiConnected = false;
  Serial.printf("[WiFi] force reconnect reason:%s status:%d failures:%u\n",
                reason ? reason : "unknown", WiFi.status(), consecutiveHttpFailures);
  WiFi.disconnect();
  delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

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
  out["battVoltage"] = compact["bv"] | -1;
  out["batteryRaw"] = compact["ar"] | -1;
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
  if (compact.containsKey("ft")) out["forced_hop_test"] = compact["ft"].as<int>() == 1;
  if (compact.containsKey("fc")) out["forced_hop_complete"] = compact["fc"].as<int>() == 1;
  if (compact.containsKey("to")) out["relay_target"] = expandVehicleId(compact["to"].as<const char*>());

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
  seenVehicles[index].rxCount++;
  seenVehicles[index].used = true;
}

void serviceMetrics() {
  unsigned long now = millis();
  if (now - lastMetricsMs < GROUND_METRICS_INTERVAL_MS) return;
  lastMetricsMs = now;
  Serial.printf("[GROUND] up:%lus wifi:%s queue:%d queued:%lu sent:%lu retry:%lu drop:%lu heap:%u\n",
                now / 1000UL, WiFi.status() == WL_CONNECTED ? "OK" : "DOWN", bufferCount(),
                (unsigned long)packetsQueued, (unsigned long)packetsSent,
                (unsigned long)packetsRetried, (unsigned long)packetsDropped, ESP.getFreeHeap());
  for (int i = 0; i < SEEN_VEHICLE_SIZE; i++) {
    if (!seenVehicles[i].used) continue;
    if (now - seenVehicles[i].lastSeenMs > SEEN_VEHICLE_EXPIRE_MS) {
      seenVehicles[i].used = false;
      continue;
    }
    Serial.printf("[GROUND_RX] %s count:%lu age:%lus rssi:%.0f snr:%.1f\n",
                  seenVehicles[i].vehicleId, (unsigned long)seenVehicles[i].rxCount,
                  (now - seenVehicles[i].lastSeenMs) / 1000UL,
                  seenVehicles[i].rssi, seenVehicles[i].snr);
  }
}

bool isLoRaRxWindow(unsigned long now = millis()) {
  bool beaconWindow = lastBeaconMs != 0 && now - lastBeaconMs < GROUND_RX_WINDOW_MS;
  bool rxQuietWindow = lastRxMs != 0 && now - lastRxMs < GROUND_RX_QUIET_MS;
  return beaconWindow || rxQuietWindow;
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

int bufferCount() {
  int count = 0;
  for (int i = 0; i < BUFFER_SIZE; i++) if (packetBuffer[i].used) count++;
  return count;
}

void bufferPacket(const char* payload, float rssi, float snr) {
  if (payload == nullptr || payload[0] == '\0') return;
  int slot = firstFreeBufferIndex();
  if (slot < 0) {
    slot = oldestBufferIndex();
    Serial.printf("[BUFFER] full, dropping oldest slot:%d\n", slot);
    packetsDropped++;
  }

  if (slot < 0) return;
  strncpy(packetBuffer[slot].payload, payload, sizeof(packetBuffer[slot].payload) - 1);
  packetBuffer[slot].payload[sizeof(packetBuffer[slot].payload) - 1] = '\0';
  packetBuffer[slot].rssi = rssi;
  packetBuffer[slot].snr = snr;
  packetBuffer[slot].used = true;
  packetBuffer[slot].attempts = 0;
  packetBuffer[slot].timestamp = millis();
  packetsQueued++;
  Serial.printf("[BUFFER] queued slot:%d depth:%d\n", slot, bufferCount());
}

void freeBufferSlot(int index) {
  if (index < 0 || index >= BUFFER_SIZE) return;
  packetBuffer[index].payload[0] = '\0';
  packetBuffer[index].used = false;
  packetBuffer[index].attempts = 0;
  packetBuffer[index].timestamp = 0;
}

String groundBatchUrl() {
  String url = SERVER_URL;
  int apiIndex = url.indexOf("/api/");
  if (apiIndex >= 0) url.remove(apiIndex);
  url += "/api/v1/ground/telemetry-batch";
  return url;
}

int postBatchToServer(const String& body) {
  lastHttpLatencyMs = 0;
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) return -1;

  unsigned long started = millis();
  WiFiClientSecure client;
  client.setBufferSizes(1024, 512);
  client.setInsecure();
  client.setTimeout(GROUND_HTTP_TIMEOUT_MS);

  HTTPClient http;
  int code = -1;
  String url = groundBatchUrl();
  if (http.begin(client, url)) {
    http.addHeader("Content-Type", "application/json");
    if (strlen(GROUND_KEY) > 0) http.addHeader("X-Ground-Key", GROUND_KEY);
    http.setTimeout(GROUND_HTTP_TIMEOUT_MS);
    http.setReuse(false);
    code = http.POST(body);
    String response = http.getString();
    if (response.length() > 0) {
      Serial.print("[HTTP_BODY] ");
      Serial.println(response.substring(0, 180));
    }
    http.end();
  }

  lastHttpLatencyMs = millis() - started;
  Serial.printf("[HTTP] %d %lums\n", code, lastHttpLatencyMs);
  if (code >= 200 && code < 300) {
    consecutiveHttpFailures = 0;
  } else {
    if (consecutiveHttpFailures < 255) consecutiveHttpFailures++;
    Serial.printf("[POST] fail code:%d failures:%u\n", code, consecutiveHttpFailures);
    if (code < 0 || consecutiveHttpFailures >= 3) {
      forceWifiReconnect(code < 0 ? "http_negative" : "http_failures");
    }
  }
  return code;
}

bool bufferedPayloadToServerJson(const BufferedPacket& packet, String& out) {
  StaticJsonDocument<768> rx;
  DeserializationError error = deserializeJson(rx, packet.payload);
  if (error) return false;

  if (isCompactVehiclePacket(rx)) {
    StaticJsonDocument<1536> postDoc;
    if (!decodeCompactPacket(String(packet.payload), postDoc)) return false;
    postDoc["received_rssi"] = packet.rssi;
    postDoc["received_snr"] = packet.snr;
    serializeJson(postDoc, out);
    return out.length() > 0;
  }

  if (!isVehiclePacket(rx)) return false;
  out = buildServerPayload(rx, packet.rssi, packet.snr);
  return out.length() > 0;
}

int collectOldestBufferIndexes(int* indexes, int maxItems) {
  int count = 0;
  while (count < maxItems) {
    int oldest = -1;
    for (int i = 0; i < BUFFER_SIZE; i++) {
      if (!packetBuffer[i].used) continue;
      bool selected = false;
      for (int j = 0; j < count; j++) if (indexes[j] == i) selected = true;
      if (selected) continue;
      if (oldest < 0 || (long)(packetBuffer[i].timestamp - packetBuffer[oldest].timestamp) < 0) oldest = i;
    }
    if (oldest < 0) break;
    indexes[count++] = oldest;
  }
  return count;
}

void flushBuffer(uint8_t maxPosts = GROUND_BATCH_SIZE) {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) return;

  int indexes[GROUND_BATCH_SIZE];
  int count = collectOldestBufferIndexes(indexes, min((int)maxPosts, (int)GROUND_BATCH_SIZE));
  if (count == 0) return;

  String body;
  body.reserve(4096);
  body = "{\"ground_id\":\"";
  body += GROUND_ID;
  body += "\",\"packets\":[";
  int includedIndexes[GROUND_BATCH_SIZE];
  int included = 0;
  for (int i = 0; i < count; i++) {
    String packetJson;
    packetJson.reserve(768);
    if (!bufferedPayloadToServerJson(packetBuffer[indexes[i]], packetJson)) {
      Serial.printf("[BUFFER] drop invalid slot:%d\n", indexes[i]);
      packetsDropped++;
      freeBufferSlot(indexes[i]);
      continue;
    }
    if (included > 0) body += ',';
    body += packetJson;
    includedIndexes[included++] = indexes[i];
  }
  body += "]}";
  if (included == 0) return;

  int code = postBatchToServer(body);
  if (code >= 200 && code < 300) {
    for (int i = 0; i < included; i++) freeBufferSlot(includedIndexes[i]);
    packetsSent += included;
    Serial.printf("[BATCH] accepted:%d depth:%d\n", included, bufferCount());
    return;
  }

  packetsRetried += included;
  for (int i = 0; i < included; i++) {
    int index = includedIndexes[i];
    if (packetBuffer[index].attempts < 255) packetBuffer[index].attempts++;
  }
}

void serviceWiFi() {
  unsigned long now = millis();
  bool connectedNow = WiFi.status() == WL_CONNECTED;
  if (connectedNow) {
    if (!wifiConnected) Serial.printf("[WiFi] restored IP:%s\n", WiFi.localIP().toString().c_str());
    wifiConnected = true;
    consecutiveHttpFailures = 0;
    return;
  }

  wifiConnected = false;
  if (now - lastWifiCheckMs < WIFI_RETRY_MS && lastWifiCheckMs != 0) return;
  lastWifiCheckMs = now;

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
  out["battVoltage"] = rx["bv"] | -1;
  out["batteryRaw"] = rx["ar"] | -1;
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
  out["forced_hop_test"] = (rx["ft"] | 0) == 1;
  out["forced_hop_complete"] = (rx["fc"] | 0) == 1;
  out["source"] = "vehicle";
  out["gps_fix"] = gpsFix;
  out["received_rssi"] = receivedRssi;
  out["received_snr"] = receivedSnr;
  out["received_at"] = millis();

  if (rx["hdg"].is<int>()) out["heading"] = rx["hdg"];
  if (rx["rf"].is<const char*>()) out["relay_from"] = rx["rf"];
  if (rx["to"].is<const char*>()) out["relay_target"] = rx["to"];
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
  int battVoltage = rx["bv"] | -1;
  int batteryRaw = rx["ar"] | -1;

  Serial.println("--------------------");
  Serial.printf("[RX] %s | hop:%d | rssi:%.0f | snr:%.1f\n", vid, hop, rssi, snr);
  Serial.printf("lat:%.6f lng:%.6f | spd:%.1fkm/h | bat:%d%% | vbat:%dmV | a0:%d\n",
                lat, lng, spd, bat, battVoltage, batteryRaw);
  if (code >= 200 && code < 300) {
    Serial.printf("-> HTTP %d (%lums)\n", code, lastHttpLatencyMs);
  } else if (code >= 400 && code < 500) {
    Serial.printf("-> HTTP %d drop (%lums)\n", code, lastHttpLatencyMs);
  } else if (code == -2) {
    Serial.println("-> queued for HTTP after RX window");
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
  int battVoltage = post["battVoltage"] | -1;
  int batteryRaw = post["batteryRaw"] | -1;
  float rssi = post["received_rssi"] | 0.0f;
  float snr = post["received_snr"] | 0.0f;

  Serial.println("--------------------");
  Serial.printf("[RX] %s | hop:%d | rssi:%.0f | snr:%.1f\n", vid, hop, rssi, snr);
  Serial.printf("lat:%.6f lng:%.6f | spd:%.1fkm/h | bat:%d%% | vbat:%dmV | a0:%d\n",
                lat, lng, spd, bat, battVoltage, batteryRaw);
  if (code >= 200 && code < 300) {
    Serial.printf("-> HTTP %d (%lums)\n", code, lastHttpLatencyMs);
  } else if (code >= 400 && code < 500) {
    Serial.printf("-> HTTP %d drop (%lums)\n", code, lastHttpLatencyMs);
  } else if (code == -2) {
    Serial.println("-> queued for HTTP after RX window");
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
  lastRxMs = millis();

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
  bool forcedHopTest = compactPacket ? (postDoc["forced_hop_test"] | false) : ((rx["ft"] | 0) == 1);
  bool forcedHopComplete = compactPacket ? (postDoc["forced_hop_complete"] | false) : ((rx["fc"] | 0) == 1);
  if (forcedHopTest && !forcedHopComplete) {
    Serial.printf("[HOP_TEST] ignore intermediate %s hop:%d target:%s\n", seenVehicleId,
                  compactPacket ? (postDoc["hop"] | 0) : (rx["hop"] | 0),
                  compactPacket ? (postDoc["relay_target"] | "?") : (rx["to"] | "?"));
    return;
  }
  if (forcedHopTest) {
    bool validCompletion = compactPacket
      ? isValidForcedHopCompletion(postDoc, true)
      : isValidForcedHopCompletion(rx, false);
    if (!validCompletion) {
      Serial.printf("[HOP_TEST] reject invalid completion %s\n", seenVehicleId[0] ? seenVehicleId : "?");
      return;
    }
  }
  noteVehicleSeen(seenVehicleId, receivedRssi, receivedSnr);
  if (isDuplicate(packetId)) {
    Serial.printf("[DEDUP] skip duplicate: %s\n", packetId[0] ? packetId : "?");
    return;
  }

  bufferPacket(payload, receivedRssi, receivedSnr);
  int code = -2; // queued for HTTP after the LoRa receive window
  beginLedPulse(80UL);
  if (compactPacket) {
    printPostLog(postDoc, code);
  } else {
    printReceiveLog(rx, receivedRssi, receivedSnr, code);
  }
  if (forcedHopTest) {
    Serial.printf("[HOP_TEST] PASS %s hop:%d via:%s\n", seenVehicleId,
                  compactPacket ? (postDoc["hop"] | 0) : (rx["hop"] | 0),
                  compactPacket ? (postDoc["relay_from"] | "?") : (rx["rf"] | "?"));
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.printf("\nSmart Songthaew Ground V03 | %s\n", GROUND_ID);
  if (strlen(GROUND_KEY) < 24) {
    Serial.println("[CONFIG] GROUND_KEY missing or too short; batch API will reject uploads");
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  waitInitialWiFi();

  loraReady = initLoRa();
  if (loraReady) {
    sendBeacon();
    lastBeaconMs = millis();
  }
}

void loop() {
  serviceStatusLed();
  serviceWiFi();
  serviceMetrics();

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

  bool rxWindow = isLoRaRxWindow(now);
  if (!rxWindow && wifiConnected && bufferCount() > 0 &&
      lastBatchBeaconMs != lastBeaconMs && now - lastFlushMs >= GROUND_HTTP_FLUSH_INTERVAL_MS) {
    lastFlushMs = now;
    lastBatchBeaconMs = lastBeaconMs;
    flushBuffer(GROUND_BATCH_SIZE);
  }

  yield();
}
