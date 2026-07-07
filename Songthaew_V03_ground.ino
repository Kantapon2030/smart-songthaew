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

#define GND_HTTP_BODY_SIZE 768
#define GND_BUFFER_SIZE    BUFFER_SIZE

struct BufferedPacket {
  char body[GND_HTTP_BODY_SIZE];
  bool used;
  unsigned long timestamp;
};

#define DEDUP_CACHE_SIZE 30
#define DEDUP_EXPIRE_MS  30000UL
#define DEDUP_PACKET_ID_LEN 48
#define SEEN_VEHICLE_SIZE 20
#define SEEN_HEARTBEAT_INTERVAL_MS 30000UL
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

BufferedPacket packetBuffer[GND_BUFFER_SIZE];
DedupEntry dedupCache[DEDUP_CACHE_SIZE];
SeenVehicle seenVehicles[SEEN_VEHICLE_SIZE];
int dedupHead = 0;

bool wifiConnected = false;
bool loraReady = false;
bool flushBufferRequested = false;
unsigned long lastWifiCheckMs = 0;
unsigned long lastGroundHeartbeatMs = 0;
unsigned long lastBeaconMs = 0;
unsigned long lastFlushMs = 0;
unsigned long lastLoRaRetryMs = 0;
unsigned long lastCommandPollMs = 0;
unsigned long lastAdaptiveStatusMs = 0;
unsigned long lastHttpLatencyMs = 0;
unsigned long lastRxCycleLogMs = 0;
unsigned long lastUploadBlockedLogMs = 0;
unsigned long lastLoRaRxMs = 0;
unsigned long lastLoRaRxKickMs = 0;
unsigned long ledPulseUntilMs = 0;
bool ledPulseActive = false;
int wifiReconnectAttempts = 0;
int totalReceived = 0;
int totalForwarded = 0;
bool httpInProgress = false;
unsigned long httpStartMs = 0;
WiFiEventHandler wifiGotIpHandler;
WiFiEventHandler wifiDisconnectedHandler;
int activeLoRaSf = ADAPTIVE_DEFAULT_SF;
int activeLoRaTxPower = ADAPTIVE_DEFAULT_TP;
unsigned long activeLoRaInterval = ADAPTIVE_DEFAULT_TI;
bool commandPending = false;
char commandTarget[16] = "";
char commandName[20] = "";
long commandValue = 0;
uint32_t commandTs = 0;
bool rxCycleBusSeen[3] = { false, false, false };

bool isVehiclePacket(JsonDocument& doc) {
  const char* type = doc["type"] | "";
  const char* compactType = doc["t"] | "";
  return strcmp(type, "vehicle_data") == 0 || strcmp(compactType, "vd") == 0;
}

bool isValidThailandCoord(float lat, float lng);
int postToServer(const char* body);

uint32_t groundSlotOffset(uint8_t index) {
  if (index == 0) return 200UL;
  if (index == 1) return 1800UL;
  if (index == 2) return 3400UL;
  return 0UL;
}

int trackedBusIndex(const char* vehicleId) {
  if (vehicleId == nullptr) return -1;
  if (strcmp(vehicleId, "BUS_01") == 0) return 0;
  if (strcmp(vehicleId, "BUS_02") == 0) return 1;
  if (strcmp(vehicleId, "BUS_03") == 0) return 2;
  return -1;
}

void markRxCycleSeen(const char* vehicleId) {
  int index = trackedBusIndex(vehicleId);
  if (index >= 0) rxCycleBusSeen[index] = true;
}

uint32_t groundCyclePhase(unsigned long now) {
  if (lastBeaconMs == 0) return now % TX_INTERVAL_MS;
  return (uint32_t)((now - lastBeaconMs) % TX_INTERVAL_MS);
}

bool phaseInRxWindow(uint32_t phase, uint32_t slotOffset) {
  uint32_t windowStart = slotOffset > GND_SLOT_WINDOW_BEFORE_MS ? slotOffset - GND_SLOT_WINDOW_BEFORE_MS : 0;
  uint32_t windowEnd = slotOffset + GND_SLOT_WINDOW_AFTER_MS;
  if (windowEnd >= TX_INTERVAL_MS) {
    return phase >= windowStart || phase <= (windowEnd % TX_INTERVAL_MS);
  }
  return phase >= windowStart && phase <= windowEnd;
}

bool inGroundRxWindow(unsigned long now) {
  if (!GND_COEXIST_SCHEDULER_ENABLED) return false;
  uint32_t phase = groundCyclePhase(now);
  for (uint8_t i = 0; i < 3; i++) {
    if (phaseInRxWindow(phase, groundSlotOffset(i))) return true;
  }
  return false;
}

uint32_t msUntilNextRxWindow(unsigned long now) {
  if (!GND_COEXIST_SCHEDULER_ENABLED) return TX_INTERVAL_MS;
  uint32_t phase = groundCyclePhase(now);
  uint32_t best = TX_INTERVAL_MS;
  for (uint8_t i = 0; i < 3; i++) {
    uint32_t slotOffset = groundSlotOffset(i);
    uint32_t windowStart = slotOffset > GND_SLOT_WINDOW_BEFORE_MS ? slotOffset - GND_SLOT_WINDOW_BEFORE_MS : 0;
    uint32_t delta = windowStart >= phase ? windowStart - phase : (TX_INTERVAL_MS - phase) + windowStart;
    if (delta < best) best = delta;
  }
  return best;
}

bool schedulerCanStartNetworkTask() {
  if (!GND_COEXIST_SCHEDULER_ENABLED) return true;
  unsigned long now = millis();
  if (inGroundRxWindow(now)) return false;
  return msUntilNextRxWindow(now) >= GND_HTTP_MIN_SAFE_GAP_MS;
}

bool schedulerCanStartLoRaTxTask() {
  if (!GND_COEXIST_SCHEDULER_ENABLED) return true;
  return !inGroundRxWindow(millis());
}

bool parseUrl(const char* url, bool* https, char* host, size_t hostSize,
              char* path, size_t pathSize, uint16_t* port) {
  if (https == nullptr || host == nullptr || path == nullptr || port == nullptr) return false;
  if (hostSize == 0 || pathSize == 0) return false;
  *https = false;
  *port = 0;
  host[0] = '\0';
  path[0] = '\0';
  if (url == nullptr || url[0] == '\0') return false;

  const char* hostStart = nullptr;
  if (strncmp(url, "https://", 8) == 0) {
    *https = true;
    *port = 443;
    hostStart = url + 8;
  } else if (strncmp(url, "http://", 7) == 0) {
    *https = false;
    *port = 80;
    hostStart = url + 7;
  } else {
    return false;
  }

  const char* pathStart = strchr(hostStart, '/');
  const char* hostEnd = pathStart != nullptr ? pathStart : url + strlen(url);
  const char* portStart = strchr(hostStart, ':');
  if (portStart != nullptr && portStart < hostEnd) {
    hostEnd = portStart;
    *port = (uint16_t)atoi(portStart + 1);
  }

  size_t hostLen = (size_t)(hostEnd - hostStart);
  if (hostLen == 0 || hostLen >= hostSize) return false;
  memcpy(host, hostStart, hostLen);
  host[hostLen] = '\0';

  if (pathStart != nullptr && pathStart[0] != '\0') {
    strlcpy(path, pathStart, pathSize);
  } else {
    strlcpy(path, "/", pathSize);
  }

  return true;
}

const char* httpErrorText(int code) {
  switch (code) {
    case -1: return "connect_failed";
    case -2: return "send_header_failed";
    case -3: return "send_payload_failed";
    case -4: return "not_connected";
    case -5: return "connection_lost";
    case -6: return "dns_failed";
    case -7: return "invalid_url";
    case -8: return "low_ram";
    case -11: return "read_timeout";
    default: return code >= 200 && code < 300 ? "ok" : "http_error";
  }
}

bool resolveHost(const char* host, IPAddress& ip) {
  int result = WiFi.hostByName(host, ip);
  if (result != 1) {
    Serial.printf("[HTTP] dns failed host:%s wifi:%d rssi:%d heap:%u\n",
                  host, WiFi.status(), WiFi.RSSI(), ESP.getFreeHeap());
    return false;
  }
  return true;
}

void prepareSecureClient(WiFiClientSecure& client) {
  client.setInsecure();
  client.setBufferSizes(HTTPS_RX_BUFFER_SIZE, HTTPS_TX_BUFFER_SIZE);
  client.setTimeout(HTTP_CONNECT_TIMEOUT);
}

bool readHttpLine(Client& client, char* line, size_t lineSize, unsigned long timeoutMs) {
  if (lineSize == 0) return false;
  size_t len = 0;
  unsigned long start = millis();
  while (millis() - start < timeoutMs) {
    ESP.wdtFeed();
    while (client.available()) {
      char c = (char)client.read();
      if (c == '\r') continue;
      if (c == '\n') {
        line[len] = '\0';
        return true;
      }
      if (len < lineSize - 1) line[len++] = c;
    }
    if (!client.connected() && !client.available()) break;
    yield();
  }
  line[len] = '\0';
  return len > 0;
}

int readHttpResponse(Client& client, char* responseBody, size_t responseBodySize) {
  char line[128];
  if (!readHttpLine(client, line, sizeof(line), HTTP_TIMEOUT_MS)) return -11;
  if (strncmp(line, "HTTP/", 5) != 0) return -11;
  int statusCode = atoi(line + 9);

  while (readHttpLine(client, line, sizeof(line), HTTP_TIMEOUT_MS)) {
    if (line[0] == '\0') break;
  }

  if (responseBody != nullptr && responseBodySize > 0) {
    size_t len = 0;
    unsigned long start = millis();
    while ((client.connected() || client.available()) && millis() - start < HTTP_TIMEOUT_MS) {
      ESP.wdtFeed();
      while (client.available()) {
        char c = (char)client.read();
        if (len < responseBodySize - 1) responseBody[len++] = c;
      }
      if (!client.connected() && !client.available()) break;
      yield();
    }
    responseBody[len] = '\0';
  }

  return statusCode > 0 ? statusCode : -11;
}

template <typename TClient>
int postBodyWithClient(TClient& client, const char* url, const char* body) {
  bool https = false;
  char host[80];
  char path[128];
  uint16_t port = 0;
  if (!parseUrl(url, &https, host, sizeof(host), path, sizeof(path), &port)) {
    Serial.println(F("[HTTP] invalid SERVER_URL"));
    return -7;
  }

  IPAddress ip;
  if (!resolveHost(host, ip)) return -6;

  if (!client.connect(host, port)) {
    Serial.printf("[HTTP] connect failed host:%s ip:%u.%u.%u.%u port:%u wifi:%d rssi:%d heap:%u\n",
                  host, ip[0], ip[1], ip[2], ip[3], port, WiFi.status(), WiFi.RSSI(), ESP.getFreeHeap());
    return -1;
  }

  size_t bodyLen = strlen(body);
  client.print(F("POST "));
  client.print(path);
  client.print(F(" HTTP/1.1\r\nHost: "));
  client.print(host);
  client.print(F("\r\nUser-Agent: SongthaewGround/3\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: "));
  client.print(bodyLen);
  client.print(F("\r\n\r\n"));
  size_t written = client.write((const uint8_t*)body, bodyLen);
  if (written != bodyLen) {
    client.stop();
    return -3;
  }

  int code = readHttpResponse(client, nullptr, 0);
  client.stop();
  return code;
}

template <typename TClient>
int getBodyWithClient(TClient& client, const char* url, char* responseBody, size_t responseBodySize) {
  bool https = false;
  char host[80];
  char path[128];
  uint16_t port = 0;
  if (!parseUrl(url, &https, host, sizeof(host), path, sizeof(path), &port)) return -7;

  IPAddress ip;
  if (!resolveHost(host, ip)) return -6;

  if (!client.connect(host, port)) {
    Serial.printf("[HTTP] command connect failed host:%s ip:%u.%u.%u.%u port:%u wifi:%d rssi:%d heap:%u\n",
                  host, ip[0], ip[1], ip[2], ip[3], port, WiFi.status(), WiFi.RSSI(), ESP.getFreeHeap());
    return -1;
  }

  client.print(F("GET "));
  client.print(path);
  client.print(F(" HTTP/1.1\r\nHost: "));
  client.print(host);
  client.print(F("\r\nUser-Agent: SongthaewGround/3\r\nConnection: close\r\n\r\n"));

  int code = readHttpResponse(client, responseBody, responseBodySize);
  client.stop();
  return code;
}

template <typename TClient>
void pollCommandWithClient(TClient& client, const char* url) {
  char response[512];
  int code = getBodyWithClient(client, url, response, sizeof(response));
  if (code == 200) {
    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, response);
    if (!err && doc["command"].is<JsonObject>()) {
      strlcpy(commandTarget, doc["command"]["vehicleId"] | "all", sizeof(commandTarget));
      strlcpy(commandName, doc["command"]["cmd"] | "", sizeof(commandName));
      commandValue = doc["command"]["val"] | 0L;
      commandTs = (uint32_t)millis();
      commandPending = commandName[0] != '\0';
      if (commandPending) {
        Serial.printf("[CMD] queued target:%s cmd:%s val:%ld\n", commandTarget, commandName, commandValue);
      }
    }
  } else if (code < 0) {
    Serial.printf("[HTTP] command fail code:%d %s\n", code, httpErrorText(code));
  }
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

void expandVehicleIdToBuffer(const char* shortId, char* out, size_t outSize) {
  if (outSize == 0) return;
  out[0] = '\0';
  if (!shortId || shortId[0] == '\0') return;
  if (strncmp(shortId, "BUS_", 4) == 0 ||
      strncmp(shortId, "DEMO_", 5) == 0 ||
      strncmp(shortId, "GROUND_", 7) == 0) {
    strlcpy(out, shortId, outSize);
    return;
  }

  int number = atoi(shortId + 1);
  if (shortId[0] == 'B' && number > 0) {
    snprintf(out, outSize, "BUS_%02d", number);
  } else if (shortId[0] == 'D' && number > 0) {
    snprintf(out, outSize, "DEMO_%d", number);
  } else if (shortId[0] == 'G' && number > 0) {
    snprintf(out, outSize, "GROUND_%02d", number);
  } else {
    strlcpy(out, shortId, outSize);
  }
}

void expandRouteIdToBuffer(const char* shortId, char* out, size_t outSize) {
  if (outSize == 0) return;
  out[0] = '\0';
  if (!shortId || shortId[0] == '\0') {
    strlcpy(out, "unassigned", outSize);
    return;
  }
  if (shortId[0] == 'R') {
    int number = atoi(shortId + 1);
    if (number > 0) {
      snprintf(out, outSize, "route_%03d", number);
      return;
    }
  }
  strlcpy(out, shortId, outSize);
}

const char* expandDirectionCode(const char* code) {
  if (!code || code[0] == '\0') return "unknown";
  if (code[0] == 'I') return "inbound";
  if (code[0] == 'O') return "outbound";
  return "unknown";
}

bool buildCompactServerPayload(JsonDocument& compact, char* body, size_t bodySize,
                               char* packetIdOut, size_t packetIdSize,
                               char* vehicleIdOut, size_t vehicleIdSize,
                               float receivedRssi, float receivedSnr) {
  if (body == nullptr || bodySize == 0 || packetIdOut == nullptr || packetIdSize == 0 ||
      vehicleIdOut == nullptr || vehicleIdSize == 0) return false;
  body[0] = '\0';
  packetIdOut[0] = '\0';
  vehicleIdOut[0] = '\0';
  if (!compact.containsKey("id") || !compact.containsKey("ts") || !compact.containsKey("pk")) return false;

  expandVehicleIdToBuffer(compact["id"] | "", vehicleIdOut, vehicleIdSize);
  uint32_t packetSeq = compact["sq"] | 0UL;
  const char* bootId = compact["bi"] | "";
  const char* packetHash = compact["pk"] | "";
  snprintf(packetIdOut, packetIdSize, "%s_%lu_%s_%s",
           vehicleIdOut, (unsigned long)packetSeq, bootId, packetHash);

  float lat = compact["la"].is<const char*>() ? atof(compact["la"] | "0") : (compact["la"] | 0.0f);
  float lng = compact["ln"].is<const char*>() ? atof(compact["ln"] | "0") : (compact["ln"] | 0.0f);
  bool coordValid = isValidThailandCoord(lat, lng);
  bool gpsFix = compact.containsKey("fx") ? ((compact["fx"] | 0) == 1) : coordValid;
  const char* status = compact["st"] | "";
  bool lastKnownPosition = strcmp(status, "last_known") == 0 || strcmp(status, "gps_hold") == 0;

  char routeId[24];
  char relayFrom[16];
  expandRouteIdToBuffer(compact["ri"] | "", routeId, sizeof(routeId));
  expandVehicleIdToBuffer(compact["rf"] | "", relayFrom, sizeof(relayFrom));

  StaticJsonDocument<1024> out;
  out["vehicleId"] = vehicleIdOut;
  out["vehicle_id"] = vehicleIdOut;
  out["seq"] = packetSeq;
  out["boot_id"] = bootId;
  out["gps_timestamp"] = compact["ts"] | 0UL;
  if ((gpsFix || lastKnownPosition) && coordValid) {
    out["lat"] = lat;
    out["lng"] = lng;
  }
  if (status[0] != '\0') out["status"] = status;
  if (compact.containsKey("le")) out["lora_error"] = (compact["le"] | 0) == 1;
  out["speed"] = compact["sp"] | 0;
  out["battery"] = compact["bt"] | -1;
  out["battVoltage"] = compact["bv"] | -1;
  out["hop"] = compact["hp"] | 0;
  out["packet_id"] = packetIdOut;
  out["packet_hash"] = packetHash;
  out["ttl"] = compact["tt"] | 0;
  if (compact.containsKey("hd")) out["heading"] = compact["hd"].as<int>();
  out["routeId"] = routeId[0] ? routeId : ROUTE_ID;
  out["route_id"] = routeId[0] ? routeId : ROUTE_ID;
  out["direction"] = compact.containsKey("dr") ? expandDirectionCode(compact["dr"] | "") : ROUTE_DIR;
  if (relayFrom[0] != '\0') out["relay_from"] = relayFrom;
  if (compact.containsKey("lq")) out["link_quality"] = compact["lq"].as<int>();
  if (compact.containsKey("sf")) out["store_forward"] = compact["sf"].as<int>() == 1;
  out["source"] = "ground_station";
  out["relay_via"] = "lora";
  out["gps_fix"] = gpsFix && coordValid;
  out["received_rssi"] = receivedRssi;
  out["received_snr"] = receivedSnr;
  out["received_at"] = millis();

  size_t len = serializeJson(out, body, bodySize);
  return len > 0 && len < bodySize;
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
  if (activeBufferCount() > 0) return;
  if (!schedulerCanStartNetworkTask()) return;

  unsigned long now = millis();
  for (int i = 0; i < SEEN_VEHICLE_SIZE; i++) {
    if (!seenVehicles[i].used) continue;
    if (now - seenVehicles[i].lastSeenMs > SEEN_VEHICLE_EXPIRE_MS) {
      seenVehicles[i].used = false;
      seenVehicles[i].vehicleId[0] = '\0';
      continue;
    }
    if (now - seenVehicles[i].lastHeartbeatMs < SEEN_HEARTBEAT_INTERVAL_MS) continue;

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

    char body[GND_HTTP_BODY_SIZE];
    size_t bodyLen = serializeJson(hb, body, sizeof(body));
    if (bodyLen == 0 || bodyLen >= sizeof(body)) continue;
    seenVehicles[i].lastHeartbeatMs = now;
    Serial.printf("[TASK] HTTP heartbeat %s\n", seenVehicles[i].vehicleId);
    int code = postToServer(body);
    ESP.wdtFeed();
    Serial.printf("[HEARTBEAT] %s code:%d rssi:%.0f snr:%.1f\n",
                  seenVehicles[i].vehicleId, code, seenVehicles[i].rssi, seenVehicles[i].snr);
    yield();
    return;
  }
}

int oldestBufferIndex() {
  int oldest = -1;
  for (int i = 0; i < GND_BUFFER_SIZE; i++) {
    if (!packetBuffer[i].used) continue;
    if (oldest < 0 || packetBuffer[i].timestamp < packetBuffer[oldest].timestamp) {
      oldest = i;
    }
  }
  return oldest;
}

int activeBufferCount() {
  int count = 0;
  for (int i = 0; i < GND_BUFFER_SIZE; i++) {
    if (packetBuffer[i].used) count++;
  }
  return count;
}

void printGroundHeartbeat() {
  unsigned long now = millis();
  if (now - lastGroundHeartbeatMs < GND_HEARTBEAT_MS) return;
  lastGroundHeartbeatMs = now;
  Serial.printf("[GND HEARTBEAT] uptime:%lus wifi:%s buf:%d rxTotal:%d fwdOK:%d heap:%u next_rx:%lums\n",
                (unsigned long)(now / 1000UL),
                wifiConnected ? "OK" : "FAIL",
                activeBufferCount(),
                totalReceived,
                totalForwarded,
                ESP.getFreeHeap(),
                (unsigned long)msUntilNextRxWindow(now));
  ESP.wdtFeed();
}

int seenVehicleAgeSeconds(const char* vehicleId) {
  int index = findSeenVehicleIndex(vehicleId);
  if (index < 0) return -1;
  return (int)((millis() - seenVehicles[index].lastSeenMs) / 1000UL);
}

void printRxCycleStatus() {
  unsigned long now = millis();
  if (now - lastRxCycleLogMs < TX_INTERVAL_MS) return;
  lastRxCycleLogMs = now;
  Serial.printf("[RX cycle] BUS_01:%s/%ds BUS_02:%s/%ds BUS_03:%s/%ds buf:%d heap:%u\n",
                rxCycleBusSeen[0] ? "Y" : "-",
                seenVehicleAgeSeconds("BUS_01"),
                rxCycleBusSeen[1] ? "Y" : "-",
                seenVehicleAgeSeconds("BUS_02"),
                rxCycleBusSeen[2] ? "Y" : "-",
                seenVehicleAgeSeconds("BUS_03"),
                activeBufferCount(),
                ESP.getFreeHeap());
  rxCycleBusSeen[0] = false;
  rxCycleBusSeen[1] = false;
  rxCycleBusSeen[2] = false;
}

int firstFreeBufferIndex() {
  for (int i = 0; i < GND_BUFFER_SIZE; i++) {
    if (!packetBuffer[i].used) return i;
  }
  return -1;
}

void bufferPacket(const char* body) {
  if (body == nullptr || body[0] == '\0') return;
  int slot = firstFreeBufferIndex();
  if (slot < 0) {
    slot = oldestBufferIndex();
    Serial.printf("[BUFFER] full, dropping oldest slot:%d\n", slot);
  }

  if (slot < 0) return;
  strlcpy(packetBuffer[slot].body, body, sizeof(packetBuffer[slot].body));
  packetBuffer[slot].used = true;
  packetBuffer[slot].timestamp = millis();
  Serial.printf("[BUFFER] queued slot:%d\n", slot);
}

void freeBufferSlot(int index) {
  if (index < 0 || index >= GND_BUFFER_SIZE) return;
  packetBuffer[index].body[0] = '\0';
  packetBuffer[index].used = false;
  packetBuffer[index].timestamp = 0;
}

int postToServer(const char* body) {
  lastHttpLatencyMs = 0;
  if (body == nullptr || body[0] == '\0') return -1;
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) return -1;

  unsigned long started = millis();
  httpInProgress = true;
  httpStartMs = started;
  int code = -1;
  bool https = false;
  char host[80];
  char path[128];
  uint16_t port = 0;
  if (!parseUrl(SERVER_URL, &https, host, sizeof(host), path, sizeof(path), &port)) {
    code = -7;
  } else if (https) {
    WiFiClientSecure client;
    prepareSecureClient(client);
    code = postBodyWithClient(client, SERVER_URL, body);
  } else {
    WiFiClient client;
    client.setTimeout(HTTP_CONNECT_TIMEOUT);
    code = postBodyWithClient(client, SERVER_URL, body);
  }

  lastHttpLatencyMs = millis() - started;
  httpInProgress = false;
  if (lastHttpLatencyMs > (HTTP_TIMEOUT_MS + 1000UL)) {
    Serial.printf("[HTTP] TIMEOUT after %lums - skipping\n", lastHttpLatencyMs);
    return -1;
  }
  if (code >= 200 && code < 300) totalForwarded++;
  if (code == 200 || code == 201) {
    Serial.printf("[OK] Packet forwarded code:%d latency:%lums heap:%u\n",
                  code, lastHttpLatencyMs, ESP.getFreeHeap());
  } else {
    Serial.printf("[FAIL] code:%d %s latency:%lums wifi:%d heap:%u\n",
                  code, httpErrorText(code), lastHttpLatencyMs,
                  WiFi.status(), ESP.getFreeHeap());
  }
  return code;
}

void buildApiUrl(const char* apiPath, char* out, size_t outSize) {
  if (outSize == 0) return;
  const char* apiStart = strstr(SERVER_URL, "/api/");
  if (apiStart == nullptr) {
    snprintf(out, outSize, "%s", apiPath);
    return;
  }
  size_t baseLen = (size_t)(apiStart - SERVER_URL);
  if (baseLen >= outSize) baseLen = outSize - 1;
  memcpy(out, SERVER_URL, baseLen);
  out[baseLen] = '\0';
  strncat(out, apiPath, outSize - strlen(out) - 1);
}

int activeVehicleCount() {
  int count = 0;
  unsigned long now = millis();
  for (int i = 0; i < SEEN_VEHICLE_SIZE; i++) {
    if (!seenVehicles[i].used) continue;
    if (now - seenVehicles[i].lastSeenMs > SEEN_VEHICLE_EXPIRE_MS) continue;
    count++;
  }
  return count;
}

void updateAdaptiveProfile() {
  int vehicleCount = activeVehicleCount();
  int nextSf = ADAPTIVE_DEFAULT_SF;
  int nextTxPower = ADAPTIVE_DEFAULT_TP;
  unsigned long nextInterval = ADAPTIVE_DEFAULT_TI;

  if (ADAPTIVE_LORA_ENABLED && vehicleCount > ADAPTIVE_THRESHOLD_VC) {
    nextSf = ADAPTIVE_HIGH_SF;
    nextTxPower = ADAPTIVE_HIGH_TP;
    nextInterval = ADAPTIVE_HIGH_TI;
  }

  if (nextSf == activeLoRaSf && nextTxPower == activeLoRaTxPower && nextInterval == activeLoRaInterval) return;
  activeLoRaSf = nextSf;
  activeLoRaTxPower = nextTxPower;
  activeLoRaInterval = nextInterval;
  LoRa.setSpreadingFactor(activeLoRaSf);
  LoRa.setTxPower(activeLoRaTxPower);
  Serial.printf("[CFG] Ground profile SF%d tp:%d ti:%lums vc:%d adaptive:%d\n",
                activeLoRaSf, activeLoRaTxPower, activeLoRaInterval, vehicleCount, ADAPTIVE_LORA_ENABLED);
}

void printAdaptiveStatus() {
  unsigned long now = millis();
  if (now - lastAdaptiveStatusMs < ADAPTIVE_STATUS_MS && lastAdaptiveStatusMs != 0) return;
  lastAdaptiveStatusMs = now;

  int vehicleCount = activeVehicleCount();
  Serial.println(F("== VIBE ADAPTIVE CONFIG =="));
  Serial.println(ADAPTIVE_LORA_ENABLED ? F("Mode: ADAPTIVE") : F("Mode: LOCKED (3-vehicle default)"));
  Serial.printf("Active vehicles: %d\n", vehicleCount);
  Serial.printf("Config: SF%d TxPwr%d interval:%lums\n", activeLoRaSf, activeLoRaTxPower, activeLoRaInterval);
  Serial.printf("Airtime: ~200ms x 3 = 600ms / %lums (12%%)\n", activeLoRaInterval);
  Serial.println(F("To enable adaptive: set ADAPTIVE_LORA_ENABLED=true"));
  Serial.println(F("============================"));
}

void pollPendingCommand() {
  if (commandPending) return;
#if COMMAND_POLL_MS >= (24UL * 60UL * 60UL * 1000UL)
  return;
#endif
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) return;
  if (activeBufferCount() > 0) return;
  if (!schedulerCanStartNetworkTask()) return;
  unsigned long now = millis();
  if (now - lastCommandPollMs < COMMAND_POLL_MS && lastCommandPollMs != 0) return;
  lastCommandPollMs = now;

  char url[160];
  buildApiUrl("/api/ground/command", url, sizeof(url));

  bool https = false;
  char host[80];
  char path[128];
  uint16_t port = 0;
  if (!parseUrl(url, &https, host, sizeof(host), path, sizeof(path), &port)) return;
  if (https) {
    WiFiClientSecure client;
    prepareSecureClient(client);
    Serial.println(F("[TASK] command poll"));
    pollCommandWithClient(client, url);
  } else {
    WiFiClient client;
    client.setTimeout(HTTP_CONNECT_TIMEOUT);
    Serial.println(F("[TASK] command poll"));
    pollCommandWithClient(client, url);
  }
}

void sendPendingCommand() {
  if (!commandPending || !loraReady) return;

  StaticJsonDocument<192> doc;
  doc["type"] = "cmd";
  doc["target"] = commandTarget;
  doc["cmd"] = commandName;
  doc["val"] = commandValue;
  doc["ttl"] = 3;
  doc["ts"] = commandTs;

  char payload[192];
  size_t len = serializeJson(doc, payload, sizeof(payload));
  if (len == 0 || len > MAX_LORA_PACKET_BYTES) return;

  LoRa.idle();
  LoRa.beginPacket();
  LoRa.print(payload);
  LoRa.endPacket();
  LoRa.receive();
  commandPending = false;
  Serial.printf("[CMD] broadcast target:%s cmd:%s val:%ld\n", commandTarget, commandName, commandValue);
}

void flushBuffer() {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) return;
  if (!schedulerCanStartNetworkTask()) {
    if (millis() - lastUploadBlockedLogMs >= 5000UL) {
      lastUploadBlockedLogMs = millis();
      Serial.printf("[TASK] HTTP upload waiting safe gap next_rx:%lums buf:%d\n",
                    (unsigned long)msUntilNextRxWindow(millis()), activeBufferCount());
    }
    return;
  }

  int flushed = 0;
  int maxUpload = GND_MAX_UPLOAD_PER_IDLE_WINDOW;
  if (activeBufferCount() >= GND_BUFFER_SIZE - 2) maxUpload = min(FLUSH_MAX_PER_CALL, maxUpload + 1);
  while (WiFi.status() == WL_CONNECTED && flushed < maxUpload) {
    if (!schedulerCanStartNetworkTask()) return;
    int index = oldestBufferIndex();
    if (index < 0) return;

    Serial.printf("[TASK] HTTP upload slot:%d buf:%d\n", index, activeBufferCount());
    int code = postToServer(packetBuffer[index].body);
    if (code >= 200 && code < 300) {
      freeBufferSlot(index);
    } else if (code >= 400 && code < 500) {
      Serial.printf("[BUFFER] dropping bad packet code:%d slot:%d\n", code, index);
      freeBufferSlot(index);
    } else {
      return;
    }
    flushed++;
    ESP.wdtFeed();
    yield();
  }
}

void onWiFiGotIP(const WiFiEventStationModeGotIP& event) {
  IPAddress ip = event.ip;
  Serial.printf("[WiFi] Connected: %u.%u.%u.%u\n", ip[0], ip[1], ip[2], ip[3]);
  wifiConnected = true;
  flushBufferRequested = true;
}

void onWiFiDisconnected(const WiFiEventStationModeDisconnected& event) {
  (void)event;
  Serial.println(F("[WiFi] Disconnected - buffering"));
  wifiConnected = false;
}

void serviceWiFi() {
  unsigned long now = millis();
  if (now - lastWifiCheckMs < WIFI_RECONNECT_MS && lastWifiCheckMs != 0) return;
  lastWifiCheckMs = now;

  bool wasConnected = wifiConnected;
  wifiConnected = WiFi.status() == WL_CONNECTED;
  if (wifiConnected) {
    wifiReconnectAttempts = 0;
    if (!wasConnected) flushBufferRequested = true;
    return;
  }

  wifiReconnectAttempts++;
  Serial.printf("[WiFi] Reconnect attempt #%d\n", wifiReconnectAttempts);
  WiFi.disconnect();
  yield();
  ESP.wdtFeed();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  if (wifiReconnectAttempts > WIFI_MAX_RETRIES) {
    Serial.println(F("[WiFi] Too many failures - restarting"));
    Serial.flush();
    ESP.restart();
  }
}

void waitInitialWiFi() {
  unsigned long started = millis();
  while (millis() - started < WIFI_SETUP_TIMEOUT_MS) {
    wifiConnected = WiFi.status() == WL_CONNECTED;
    if (wifiConnected) {
      IPAddress ip = WiFi.localIP();
      Serial.printf("[WiFi] connected IP:%u.%u.%u.%u\n", ip[0], ip[1], ip[2], ip[3]);
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
  LoRa.setSpreadingFactor(activeLoRaSf);
  LoRa.setCodingRate4(LORA_CR);
  LoRa.setSyncWord(LORA_SYNC);
  LoRa.setTxPower(activeLoRaTxPower);
  LoRa.enableCrc();
  LoRa.receive();
  lastLoRaRxMs = millis();
  lastLoRaRxKickMs = lastLoRaRxMs;
  Serial.println("[LoRa] ready");
  return true;
}

void serviceLoRaRxHealth() {
  if (!loraReady) return;
  unsigned long now = millis();

  if (now - lastLoRaRxKickMs >= GND_LORA_RX_KICK_MS) {
    lastLoRaRxKickMs = now;
    LoRa.receive();
  }

  if (totalReceived == 0 && now - lastLoRaRxMs >= GND_LORA_NO_RX_REINIT_MS) {
    Serial.println(F("[LORA] No RX yet - reinitializing receiver"));
    loraReady = initLoRa();
  }
}

void sendBeacon() {
  if (!loraReady) return;
  if (!schedulerCanStartLoRaTxTask()) return;
  updateAdaptiveProfile();

  StaticJsonDocument<256> doc;
  doc["type"] = "beacon";
  doc["sid"] = GROUND_ID;
  doc["lat"] = GROUND_LAT;
  doc["lng"] = GROUND_LNG;
  doc["ts"] = millis();
  JsonObject cfg = doc.createNestedObject("cfg");
  cfg["sf"] = activeLoRaSf;
  cfg["tp"] = activeLoRaTxPower;
  cfg["ti"] = activeLoRaInterval;
  cfg["vc"] = activeVehicleCount();
  cfg["adaptive"] = ADAPTIVE_LORA_ENABLED;

  char payload[256];
  serializeJson(doc, payload, sizeof(payload));

  LoRa.idle();
  LoRa.beginPacket();
  LoRa.print(payload);
  LoRa.endPacket();
  LoRa.receive();
  lastBeaconMs = millis();
  Serial.println("[TASK] beacon sent");
  sendPendingCommand();
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

bool buildServerPayload(JsonDocument& rx, float receivedRssi, float receivedSnr, char* body, size_t bodySize) {
  if (body == nullptr || bodySize == 0) return false;
  StaticJsonDocument<1024> out;
  float lat = rx["lat"] | 0.0f;
  float lng = rx["lng"] | 0.0f;
  const char* status = rx["status"] | "";
  bool gpsFix = (rx["fix"] | true) && isValidThailandCoord(lat, lng);
  bool lastKnownPosition = strcmp(status, "last_known") == 0 && isValidThailandCoord(lat, lng);

  out["vehicleId"] = rx["vid"] | "";
  out["vehicle_id"] = rx["vid"] | "";
  if (gpsFix || lastKnownPosition) {
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

  if (status[0] != '\0') out["status"] = status;
  if (rx["lora_error"].is<bool>()) out["lora_error"] = rx["lora_error"].as<bool>();
  if (rx["hdg"].is<int>()) out["heading"] = rx["hdg"];
  if (rx["rf"].is<const char*>()) out["relay_from"] = rx["rf"];
  if (rx["sats"].is<int>()) out["sats"] = rx["sats"];
  if (rx["hdop"].is<float>()) out["hdop"] = rx["hdop"];

  addRelayChain(rx, out);
  addNeighbors(rx, out);
  addVersionSummary(rx, out);

  size_t len = serializeJson(out, body, bodySize);
  return len > 0 && len < bodySize;
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
  int battVoltage = post["battVoltage"] | -1;
  float rssi = post["received_rssi"] | 0.0f;
  float snr = post["received_snr"] | 0.0f;

  Serial.println("--------------------");
  Serial.printf("[RX] %s | hop:%d | rssi:%.0f | snr:%.1f\n", vid, hop, rssi, snr);
  Serial.printf("lat:%.6f lng:%.6f | spd:%.1fkm/h | bat:%d%% | vbat:%dmV\n", lat, lng, spd, bat, battVoltage);
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
  Serial.printf("[RF] packet bytes:%d rssi:%.0f snr:%.1f head:%.32s\n",
                len, receivedRssi, receivedSnr, payload);

  StaticJsonDocument<768> rx;
  DeserializationError error = deserializeJson(rx, payload);
  if (error) {
    Serial.printf("[RX] JSON parse error: %s - dropping\n", error.c_str());
    LoRa.receive();
    return;
  }

  StaticJsonDocument<1536> postDoc;
  char body[GND_HTTP_BODY_SIZE];
  char packetId[80] = "";
  char seenVehicleId[16] = "";
  bool compactPacket = isCompactVehiclePacket(rx);
  if (compactPacket) {
    if (!buildCompactServerPayload(rx, body, sizeof(body), packetId, sizeof(packetId),
                                   seenVehicleId, sizeof(seenVehicleId), receivedRssi, receivedSnr)) {
      Serial.println("[RX] compact decode failed");
      LoRa.receive();
      return;
    }
    deserializeJson(postDoc, body);
  } else {
    if (!isVehiclePacket(rx)) {
      Serial.printf("[RX] ignored packet type:%s compact:%s\n",
                    rx["type"] | "", rx["t"] | "");
      LoRa.receive();
      return;
    }
    strlcpy(packetId, rx["pid"] | "", sizeof(packetId));
    strlcpy(seenVehicleId, rx["vid"] | "", sizeof(seenVehicleId));
    if (!buildServerPayload(rx, receivedRssi, receivedSnr, body, sizeof(body))) {
      Serial.println(F("[RX] payload build failed - dropping"));
      LoRa.receive();
      return;
    }
  }

  noteVehicleSeen(seenVehicleId, receivedRssi, receivedSnr);
  lastLoRaRxMs = millis();
  if (isDuplicate(packetId)) {
    Serial.printf("[DEDUP] skip duplicate: %s\n", packetId[0] ? packetId : "?");
    LoRa.receive();
    return;
  }
  totalReceived++;
  markRxCycleSeen(seenVehicleId);

  bufferPacket(body);
  beginLedPulse(80UL);
  LoRa.receive();
  Serial.printf("[TASK] LoRa RX queued id:%s buf:%d\n", seenVehicleId, activeBufferCount());

  if (compactPacket) {
    printPostLog(postDoc, -4);
  } else {
    printReceiveLog(rx, receivedRssi, receivedSnr, -4);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.printf("\nSmart Songthaew Ground V03 | %s\n", GROUND_ID);
  Serial.printf("[BOOT] Build:%s RF:%.0fHz SF%d BW%lu CR4/%d SW:0x%02X pins ss:%d rst:%d dio0:%d\n",
                FW_BUILD_ID, LORA_FREQ, activeLoRaSf, (unsigned long)LORA_BW,
                LORA_CR, LORA_SYNC, LORA_SS, LORA_RST, LORA_DIO0);
  Serial.printf("[BOOT] Heap:%u buffer:%d x %d tls:%d/%d\n",
                ESP.getFreeHeap(), GND_BUFFER_SIZE, GND_HTTP_BODY_SIZE,
                HTTPS_RX_BUFFER_SIZE, HTTPS_TX_BUFFER_SIZE);
  ESP.wdtEnable(GND_WDT_TIMEOUT_MS);
  ESP.wdtFeed();
  Serial.printf("[BOOT] Watchdog enabled (%us)\n", (unsigned int)(GND_WDT_TIMEOUT_MS / 1000UL));

  WiFi.mode(WIFI_STA);
  WiFi.persistent(true);
  WiFi.setAutoReconnect(true);
  WiFi.setAutoConnect(true);
  wifiGotIpHandler = WiFi.onStationModeGotIP(onWiFiGotIP);
  wifiDisconnectedHandler = WiFi.onStationModeDisconnected(onWiFiDisconnected);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  wifiConnected = WiFi.status() == WL_CONNECTED;
  if (wifiConnected) {
    IPAddress ip = WiFi.localIP();
    Serial.printf("[WiFi] Connected: %u.%u.%u.%u\n", ip[0], ip[1], ip[2], ip[3]);
    flushBufferRequested = true;
  } else {
    Serial.println(F("[WiFi] connecting in background - LoRa receive starts now"));
  }

  loraReady = initLoRa();
}

void loop() {
  ESP.wdtFeed();
  if (httpInProgress && millis() - httpStartMs > (HTTP_TIMEOUT_MS + 2000UL)) {
    Serial.println(F("[HTTP] watchdog timeout - restarting"));
    Serial.flush();
    ESP.restart();
  }
  serviceStatusLed();

  if (!loraReady && millis() - lastLoRaRetryMs >= 5000UL) {
    lastLoRaRetryMs = millis();
    loraReady = initLoRa();
  }

  if (loraReady) {
    int packetSize = LoRa.parsePacket();
    if (packetSize > 0) onLoRaReceive(packetSize);
  }

  unsigned long now = millis();
  serviceWiFi();
  serviceLoRaRxHealth();
  printGroundHeartbeat();
  printRxCycleStatus();
  printAdaptiveStatus();

  unsigned long beaconInterval = totalReceived == 0 ? GND_NO_RX_BEACON_INTERVAL_MS : BEACON_INTERVAL_MS;
  if (now - lastBeaconMs >= beaconInterval && schedulerCanStartLoRaTxTask()) {
    sendBeacon();
  }

  if (flushBufferRequested || (activeBufferCount() > 0 && now - lastFlushMs >= 250UL)) {
    flushBufferRequested = false;
    lastFlushMs = now;
    flushBuffer();
  }

  pollPendingCommand();

  yield();
}
