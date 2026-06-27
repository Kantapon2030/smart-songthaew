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
  WiFi: connects to WIFI_SSID from mesh_config.h
*/

#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266WiFi.h>
#include <LoRa.h>
#include <SPI.h>
#include <WiFiClientSecure.h>
#include "mesh_config.h"

struct BufferedPacket {
  String body;
  bool used;
  unsigned long timestamp;
};

BufferedPacket packetBuffer[BUFFER_SIZE];

bool wifiConnected = false;
bool loraReady = false;
unsigned long lastWifiCheckMs = 0;
unsigned long lastBeaconMs = 0;
unsigned long lastFlushMs = 0;
unsigned long lastLoRaRetryMs = 0;
unsigned long lastHttpLatencyMs = 0;

bool isVehiclePacket(JsonDocument& doc) {
  const char* type = doc["type"] | "";
  const char* compactType = doc["t"] | "";
  return strcmp(type, "vehicle_data") == 0 || strcmp(compactType, "vd") == 0;
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
    http.end();
  }

  lastHttpLatencyMs = millis() - started;
  Serial.printf("[HTTP] %d %lums\n", code, lastHttpLatencyMs);
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

String buildServerPayload(JsonDocument& rx, float receivedRssi, float receivedSnr) {
  StaticJsonDocument<1024> out;
  out["vehicleId"] = rx["vid"] | "";
  out["vehicle_id"] = rx["vid"] | "";
  out["lat"] = rx["lat"] | 0.0f;
  out["lng"] = rx["lng"] | 0.0f;
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
  out["source"] = "vehicle";
  out["gps_fix"] = rx["fix"] | true;
  out["received_rssi"] = receivedRssi;
  out["received_snr"] = receivedSnr;
  out["received_at"] = millis();

  if (rx["hdg"].is<int>()) out["heading"] = rx["hdg"];
  if (rx["rf"].is<const char*>()) out["relay_from"] = rx["rf"];
  if (rx["sats"].is<int>()) out["sats"] = rx["sats"];
  if (rx["hdop"].is<float>()) out["hdop"] = rx["hdop"];

  addRelayChain(rx, out);
  addNeighbors(rx, out);

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
    Serial.printf("-> buffered code:%d\n", code);
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

  StaticJsonDocument<768> rx;
  DeserializationError error = deserializeJson(rx, payload);
  if (error) {
    Serial.printf("[RX] invalid json: %s\n", error.c_str());
    return;
  }

  if (!isVehiclePacket(rx)) return;

  String body = buildServerPayload(rx, receivedRssi, receivedSnr);
  int code = wifiConnected && WiFi.status() == WL_CONNECTED ? postToServer(body) : -1;
  bool ok = code >= 200 && code < 300;
  bool badPacket = code >= 400 && code < 500;

  if (!ok && !badPacket) bufferPacket(body);
  printReceiveLog(rx, receivedRssi, receivedSnr, code);
}

void setup() {
  Serial.begin(115200);
  Serial.printf("\nSmart Songthaew Ground V03 | %s\n", GROUND_ID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  waitInitialWiFi();

  loraReady = initLoRa();
}

void loop() {
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

  yield();
}
