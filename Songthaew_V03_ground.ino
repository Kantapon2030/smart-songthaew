/*
 * ============================================================
 * Smart Songthaew V03 Ground Station Firmware - VIBE LoRa Mesh
 * ESP8266/ESP32 + LoRa + WiFi/4G uplink
 * ============================================================
 *
 * Receives compact LoRa vehicle packets, adds ground metadata, and
 * forwards full legacy-compatible JSON to POST /api/update-location.
 */

#include <Arduino.h>
#include <SPI.h>
#include <LoRa.h>
#include <math.h>
#include "mesh_config.h"

#if defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266HTTPClient.h>
  #include <WiFiClient.h>
  #include <WiFiClientSecure.h>
#elif defined(ESP32)
  #include <WiFi.h>
  #include <HTTPClient.h>
  #include <WiFiClient.h>
  #include <WiFiClientSecure.h>
#else
  #error "Songthaew_V03_ground supports ESP8266 and ESP32."
#endif

struct BufferedPacket {
  String body;
  bool used;
};

BufferedPacket buffer[VIBE_BUFFER_SIZE];
byte bufferHead = 0;
byte bufferCount = 0;
String dedupIds[VIBE_DEDUP_CACHE_SIZE];
byte dedupCursor = 0;

unsigned long lastBeaconMs = 0;
unsigned long lastWifiAttemptMs = 0;
unsigned long lastFlushMs = 0;

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

String expandNeighbors(const String& raw) {
  if (!raw.length() || raw == "[]") return "[]";
  String out = "[";
  bool first = true;
  int pos = 0;

  while (true) {
    int row = raw.indexOf("[\"", pos);
    if (row < 0) break;
    int idStart = row + 2;
    int idEnd = raw.indexOf('"', idStart);
    int comma1 = raw.indexOf(',', idEnd);
    int comma2 = raw.indexOf(',', comma1 + 1);
    int rowEnd = raw.indexOf(']', comma2 + 1);
    if (idEnd < 0 || comma1 < 0 || comma2 < 0 || rowEnd < 0) break;

    String id = raw.substring(idStart, idEnd);
    String rssi = raw.substring(comma1 + 1, comma2);
    String snr = raw.substring(comma2 + 1, rowEnd);
    if (!first) out += ",";
    out += "{\"vehicle_id\":\"" + id + "\",\"rssi\":" + rssi + ",\"snr\":" + snr + "}";
    first = false;
    pos = rowEnd + 1;
  }

  out += "]";
  return out;
}

String directionName(const String& compact) {
  if (compact == "O") return "PROMKHIRI";
  if (compact == "I") return "NAKHON";
  return compact.length() ? compact : "unknown";
}

String lastRelayFrom(const String& chain) {
  int endQuote = chain.lastIndexOf('"');
  if (endQuote <= 0) return "";
  int startQuote = chain.lastIndexOf('"', endQuote - 1);
  if (startQuote < 0) return "";
  return chain.substring(startQuote + 1, endQuote);
}

bool wifiConnected() {
  return WiFi.status() == WL_CONNECTED;
}

void serviceWiFi() {
  if (wifiConnected()) return;
  unsigned long now = millis();
  if (now - lastWifiAttemptMs < WIFI_RECONNECT_INTERVAL_MS && lastWifiAttemptMs != 0) return;
  lastWifiAttemptMs = now;
  Serial.println("[WiFi] reconnecting");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

int postBody(const String& body) {
  if (!wifiConnected() || strlen(SERVER_UPDATE_URL) == 0) return -1;

  HTTPClient http;
  int code = -1;
  String url = String(SERVER_UPDATE_URL);

  if (url.startsWith("https://")) {
    WiFiClientSecure client;
    client.setInsecure();
    if (!http.begin(client, url)) return -1;
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(5000);
    code = http.POST(body);
    http.end();
  } else {
    WiFiClient client;
    if (!http.begin(client, url)) return -1;
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(5000);
    code = http.POST(body);
    http.end();
  }

  return code;
}

void bufferPacket(const String& body) {
  byte slot = (bufferHead + bufferCount) % VIBE_BUFFER_SIZE;
  if (bufferCount == VIBE_BUFFER_SIZE) {
    slot = bufferHead;
    bufferHead = (bufferHead + 1) % VIBE_BUFFER_SIZE;
  } else {
    bufferCount++;
  }
  buffer[slot].body = body;
  buffer[slot].used = true;
  Serial.printf("[Buffer] queued %u/%u\n", bufferCount, VIBE_BUFFER_SIZE);
}

void flushBuffer() {
  if (!wifiConnected() || bufferCount == 0) return;
  unsigned long now = millis();
  if (now - lastFlushMs < BUFFER_FLUSH_INTERVAL_MS) return;
  lastFlushMs = now;

  BufferedPacket& item = buffer[bufferHead];
  if (!item.used) {
    bufferHead = (bufferHead + 1) % VIBE_BUFFER_SIZE;
    bufferCount--;
    return;
  }

  int code = postBody(item.body);
  if ((code >= 200 && code < 300) || (code >= 400 && code < 500)) {
    item.used = false;
    item.body = "";
    bufferHead = (bufferHead + 1) % VIBE_BUFFER_SIZE;
    bufferCount--;
    Serial.printf("[Buffer] %s code:%d, remaining %u\n",
                  code < 300 ? "flushed" : "dropped", code, bufferCount);
  }
}

void sendBeacon() {
  String beacon = "{";
  beacon += "\"t\":\"b\"";
  beacon += ",\"type\":\"beacon\"";
  beacon += ",\"sid\":\"" + String(GROUND_STATION_ID) + "\"";
  beacon += ",\"station_id\":\"" + String(GROUND_STATION_ID) + "\"";
  beacon += ",\"lat\":" + String(GROUND_LAT, 6);
  beacon += ",\"lng\":" + String(GROUND_LNG, 6);
  beacon += ",\"ts\":" + String(millis());
  beacon += "}";

  LoRa.idle();
  LoRa.beginPacket();
  LoRa.print(beacon);
  LoRa.endPacket();
  LoRa.receive();
  Serial.println("[LoRa] beacon");
}

String buildServerBody(const String& rx, int receivedRssi, float receivedSnr) {
  String vehicleId = stringField(rx, "v");
  float lat = floatField(rx, "a", 0);
  float lng = floatField(rx, "o", 0);
  String chain = rawField(rx, "c", "[]");
  String relayFrom = stringField(rx, "rf", lastRelayFrom(chain));
  String neighbors = expandNeighbors(rawField(rx, "n", "[]"));

  String body = "{";
  body += "\"vehicleId\":\"" + vehicleId + "\"";
  body += ",\"vehicle_id\":\"" + vehicleId + "\"";
  body += ",\"seq\":" + rawField(rx, "q", "0");
  body += ",\"boot_id\":" + rawField(rx, "b", "\"\"");
  body += ",\"packet_id\":" + rawField(rx, "p", "\"\"");
  body += ",\"gps_fix\":" + String(longField(rx, "gf", 1) ? "true" : "false");
  body += ",\"lat\":" + String(lat, 6);
  body += ",\"lng\":" + String(lng, 6);
  body += ",\"speed\":" + rawField(rx, "s", "0");
  body += ",\"heading\":" + rawField(rx, "hd", "0");
  body += ",\"battery\":" + rawField(rx, "bt", "-1");
  body += ",\"routeId\":" + rawField(rx, "r", "\"unassigned\"");
  body += ",\"route_id\":" + rawField(rx, "r", "\"unassigned\"");
  body += ",\"direction\":\"" + directionName(stringField(rx, "d")) + "\"";
  body += ",\"hop\":" + rawField(rx, "hp", "0");
  body += ",\"relay_from\":\"" + relayFrom + "\"";
  body += ",\"relay_chain\":" + chain;
  body += ",\"neighbors\":" + neighbors;
  body += ",\"link_quality\":" + rawField(rx, "lq", "0");
  body += ",\"rssi\":" + rawField(rx, "rs", String(receivedRssi));
  body += ",\"snr\":" + rawField(rx, "sn", String(receivedSnr, 1));
  body += ",\"received_rssi\":" + String(receivedRssi);
  body += ",\"received_snr\":" + String(receivedSnr, 1);
  body += ",\"received_at\":" + String(millis());
  body += ",\"source\":\"vibe-mesh\"";
  body += "}";
  return body;
}

void receiveLoRa() {
  int packetSize = LoRa.parsePacket();
  if (!packetSize) return;

  String rx = "";
  while (LoRa.available()) rx += (char)LoRa.read();
  int rssi = LoRa.packetRssi();
  float snr = LoRa.packetSnr();

  if (stringField(rx, "t") != "g") return;

  String packetId = stringField(rx, "p");
  if (seenPacket(packetId)) {
    Serial.printf("[LoRa] duplicate %s ignored\n", packetId.c_str());
    return;
  }
  rememberPacket(packetId);

  String body = buildServerBody(rx, rssi, snr);
  int code = postBody(body);
  bool ok = code >= 200 && code < 300;
  bool badPacket = code >= 400 && code < 500;
  if (!ok && !badPacket) bufferPacket(body);
  if (badPacket) Serial.printf("[HTTP] drop bad packet %s code:%d\n", packetId.c_str(), code);

  float lat = floatField(rx, "a", 0);
  float lng = floatField(rx, "o", 0);
  float dist = (lat != 0 && lng != 0) ? distanceMeters(lat, lng, GROUND_LAT, GROUND_LNG) : -1;
  Serial.printf("[RX] %s dist:%.0fm hop:%ld rssi:%d snr:%.1f forward:%s\n",
                stringField(rx, "v", "?").c_str(), dist, longField(rx, "hp", 0),
                rssi, snr, ok ? "ok" : (badPacket ? "dropped" : "buffered"));
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n=== Smart Songthaew V03 Ground %s ===\n", GROUND_STATION_ID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lastWifiAttemptMs = millis();

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

  Serial.println("[LoRa] ground receiver ready");
}

void loop() {
  serviceWiFi();
  receiveLoRa();
  flushBuffer();

  unsigned long now = millis();
  if (now - lastBeaconMs >= GROUND_BEACON_INTERVAL_MS) {
    lastBeaconMs = now;
    sendBeacon();
  }

  yield();
}
