/**
 * ============================================================
 *  Songthaew.ino — Smart Songthaew Tracker (v3-power)
 *  ESP8266 NodeMCU + GPS6MV2 + Power Self-Measurement
 * ============================================================
 *
 *  ── สิ่งที่เพิ่มใหม่ ─────────────────────────────────────
 *
 *  [NEW] Power Self-Measurement:
 *    วิธี 1 (ง่าย): ใช้ ADC A0 วัดแรงดัน Battery โดยตรง
 *                  ผ่าน Voltage Divider (100kΩ + 47kΩ)
 *    วิธี 2 (แม่น): ใช้ INA219 (I2C) วัดทั้ง V, I, W จริง
 *                  ถ้าไม่มี INA219 → fallback คำนวณประมาณ
 *
 *  [NEW] Power Saving Modes:
 *    SLEEP_NONE     = ส่งทุก 2 วินาที (demo mode)
 *    SLEEP_LIGHT    = Modem Sleep — WiFi ดับระหว่าง tick
 *                    ประหยัด ~20% ใช้เมื่อขยับช้า
 *    SLEEP_ADAPTIVE = ปรับอัตโนมัติตาม speed:
 *                    speed > 5 km/h  → ส่งทุก 2s (ปกติ)
 *                    speed = 0, < 30s → ส่งทุก 5s
 *                    speed = 0, > 30s → ส่งทุก 15s (ประหยัด)
 *                    speed = 0, > 5min → ส่งทุก 30s (Max save)
 *
 *  [NEW] Battery Voltage Divider (วงจร A0):
 *    Battery (+) ──── R1 (100kΩ) ──── A0 ──── R2 (47kΩ) ──── GND
 *    Max input: 3.2V × (100+47)/47 = ~10V
 *    สำหรับ LiPo 7.4V: ใช้ R1=100k, R2=33k
 *
 *  [NEW] ข้อมูล Power ส่งไปยัง Server:
 *    battVoltage (mV), currentMa (mA), powerMw (mW),
 *    sleepMode (0/1/2), txCount (รวม packets ตั้งแต่ boot)
 *
 *  ── การต่อสาย INA219 (optional) ──────────────────────────
 *    INA219        ESP8266 NodeMCU
 *    VCC    →      3.3V
 *    GND    →      GND
 *    SDA    →      D2 (GPIO4)
 *    SCL    →      D1 (GPIO5)
 *    VIN+   →      Battery (+) หรือสาย + จาก Solar
 *    VIN-   →      Load (+) ต่อไปยัง ESP8266
 *
 *  ── Library ที่ต้องติดตั้ง ─────────────────────────────────
 *    - TinyGPS++ by Mikal Hart
 *    - Adafruit INA219  (ถ้าใช้ INA219)
 *    - Wire (built-in)
 * ============================================================
 */

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <WiFiClient.h>
#include <math.h>

// ── Mode เลือก GPS ───────────────────────────────────────────
// #define USE_REAL_GPS   // uncomment เมื่อต่อ GPS6MV2 จริง
// #define USE_INA219     // uncomment เมื่อต่อ INA219

#ifdef USE_REAL_GPS
  #include <TinyGPS++.h>
  #include <SoftwareSerial.h>
  #define GPS_RX_PIN  4
  #define GPS_TX_PIN  5
  #define GPS_BAUD    9600
  TinyGPSPlus    gps;
  SoftwareSerial gpsSerial(GPS_RX_PIN, GPS_TX_PIN);
  bool gpsFix = false;
#endif

#ifdef USE_INA219
  #include <Adafruit_INA219.h>
  Adafruit_INA219 ina219;
  bool ina219Found = false;
#endif

// ── WiFi + Server ────────────────────────────────────────────
const char*  WIFI_SSID  = "Saowapha";
const char*  WIFI_PASS  = "0887682695";
const String SERVER_URL = "https://smart-songthaew-production.up.railway.app/api/update-location";

// ── Route ────────────────────────────────────────────────────
const int   NUM_WP = 5;
const float ROUTE[NUM_WP][2] = {
  {8.432450f, 99.959129f},
  {8.432796f, 99.888032f},
  {8.463119f, 99.864281f},
  {8.508510f, 99.827826f},
  {8.522536f, 99.825067f},
};

// ── Constants ────────────────────────────────────────────────
#define DEG_PER_KM     (1.0f/111.0f)
const String VEHICLE_ID = "songthaew_01";
const String ROUTE_ID   = "nakhon_phromkhiri";

// ── Power Saving Modes ────────────────────────────────────────
// SLEEP_NONE     = demo / presentation mode (ส่งทุก 2s เสมอ)
// SLEEP_ADAPTIVE = ประหยัดพลังงานอัตโนมัติตาม speed
#define SLEEP_NONE     0
#define SLEEP_ADAPTIVE 1

const int POWER_MODE = SLEEP_ADAPTIVE; // ← เปลี่ยนได้

// Interval (ms) ตาม state
#define INTERVAL_ACTIVE   2000   // วิ่งปกติ
#define INTERVAL_IDLE1    5000   // จอด < 30s
#define INTERVAL_IDLE2   15000   // จอด 30s-5min
#define INTERVAL_IDLE3   30000   // จอด > 5min

// ── ADC Voltage Divider ──────────────────────────────────────
// A0 ← Voltage divider จาก Battery
// แก้ค่า R1, R2 ให้ตรงกับวงจรของคุณ
#define R1_KOHM     100.0f   // kΩ (ตัวบน)
#define R2_KOHM      47.0f   // kΩ (ตัวล่าง, ต่อลง GND)
#define ADC_REF_MV 3300.0f   // ADC reference voltage (mV)
#define ADC_MAX     1024.0f  // ESP8266 ADC = 10-bit

// ── Sim State ────────────────────────────────────────────────
float  curLat      = ROUTE[0][0];
float  curLng      = ROUTE[0][1];
int    targetIdx   = 1;
bool   isOutbound  = true;
int    curSpeed    = 30;
int    targetSpeed = 35;
int    stopTicks   = 0;
int    battery     = 92;
String direction   = "พรหมคีรี";

// Power state
float  measuredVoltMv  = -1;
float  measuredCurrentMa = -1;
float  measuredPowerMw = -1;
int    sleepModeActive = SLEEP_NONE;

// Timing
unsigned long stopStartMs    = 0;  // เวลาเริ่มจอด (0 = กำลังวิ่ง)
unsigned long lastSendMs     = 0;
int           txCount        = 0;

// ─────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  delay(200);
  randomSeed(analogRead(A0));

  Serial.println("\n=== Smart Songthaew Tracker v3-power ===");
  Serial.printf("[MODE] GPS: %s | INA219: %s | PowerSave: %s\n",
    #ifdef USE_REAL_GPS
      "REAL",
    #else
      "SIM",
    #endif
    #ifdef USE_INA219
      "YES",
    #else
      "NO (ADC only)",
    #endif
    POWER_MODE == SLEEP_ADAPTIVE ? "ADAPTIVE" : "NONE"
  );

  #ifdef USE_REAL_GPS
    gpsSerial.begin(GPS_BAUD);
    Serial.println("[GPS] Waiting for fix...");
  #endif

  #ifdef USE_INA219
    if (ina219.begin()) {
      ina219Found = true;
      ina219.setCalibration_32V_2A();
      Serial.println("[INA219] Found — measuring V/I/W");
    } else {
      Serial.println("[INA219] Not found — fallback to ADC estimate");
    }
  #endif

  // WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[WiFi] Connecting");
  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 30) {
    delay(500); Serial.print("."); retries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] Failed — restart");
    ESP.restart();
  }
}

// ============================================================
//  POWER MEASUREMENT
// ============================================================

/**
 * measurePower()
 * วัดแรงดัน/กระแส/กำลัง และอัปเดตตัวแปร global
 *
 * Priority:
 *   1. INA219 (ถ้ามี)  — วัดจริง V + I + W
 *   2. ADC A0            — วัด Battery voltage เท่านั้น
 *   3. ประมาณจาก speed  — fallback สุดท้าย
 */
void measurePower() {

  // ── วิธีที่ 1: INA219 ──────────────────────────────────────
  #ifdef USE_INA219
  if (ina219Found) {
    float busV    = ina219.getBusVoltage_V();        // V
    float current = ina219.getCurrent_mA();          // mA
    float power   = ina219.getPower_mW();            // mW

    measuredVoltMv    = busV * 1000.0f;              // → mV
    measuredCurrentMa = current;
    measuredPowerMw   = power;

    Serial.printf("[PWR] INA219: %.0fmV | %.1fmA | %.0fmW\n",
      measuredVoltMv, measuredCurrentMa, measuredPowerMw);
    return;
  }
  #endif

  // ── วิธีที่ 2: ADC A0 (Voltage Divider) ───────────────────
  // อ่านค่าเฉลี่ย 4 ครั้ง ลด noise
  long adcSum = 0;
  for (int i = 0; i < 4; i++) { adcSum += analogRead(A0); delay(2); }
  float adcAvg = adcSum / 4.0f;

  // แปลง ADC → Voltage ที่ A0 pin
  float vAtPin = (adcAvg / ADC_MAX) * ADC_REF_MV;  // mV at A0

  // แปลงกลับเป็น Voltage จริง (Voltage Divider reverse)
  measuredVoltMv = vAtPin * (R1_KOHM + R2_KOHM) / R2_KOHM;

  // ── วิธีที่ 3: ประมาณกระแสจาก state ───────────────────────
  // ESP8266 power model (datasheet + measurement):
  //   Deep Sleep:     ~0.020 mA
  //   Modem Sleep:    ~15 mA
  //   Active idle:    ~70 mA
  //   Active + WiFi:  ~80 mA
  //   WiFi TX burst:  ~170-250 mA (peak)
  //   GPS module:     ~37 mA

  float baseMa = 80.0f + 37.0f;  // ESP8266 active + GPS
  float txBoost = (float)random(0, 50);  // จำลอง WiFi TX burst
  measuredCurrentMa = baseMa + txBoost;

  // กำลังไฟ = V × I
  if (measuredVoltMv > 0) {
    measuredPowerMw = (measuredVoltMv / 1000.0f) * measuredCurrentMa;
  } else {
    // ถ้า ADC ไม่ได้ต่อ — ใช้ค่าประมาณจาก battery %
    float estimatedV = 3.0f + (battery / 100.0f) * 0.6f;  // 3.0-3.6V
    measuredVoltMv   = estimatedV * 1000.0f;
    measuredPowerMw  = estimatedV * measuredCurrentMa;
  }

  Serial.printf("[PWR] ADC: raw=%.0f | %.0fmV | est %.0fmA | %.0fmW\n",
    adcAvg, measuredVoltMv, measuredCurrentMa, measuredPowerMw);
}

// ============================================================
//  ADAPTIVE SLEEP — คืนค่า delay (ms) ที่ควรรอ
// ============================================================
unsigned long getAdaptiveDelay() {
  if (POWER_MODE == SLEEP_NONE) return INTERVAL_ACTIVE;

  if (curSpeed > 0) {
    // กำลังวิ่ง → ส่งถี่
    stopStartMs = 0;
    sleepModeActive = SLEEP_NONE;
    return INTERVAL_ACTIVE;
  }

  // จอดอยู่
  if (stopStartMs == 0) stopStartMs = millis();
  unsigned long stoppedMs = millis() - stopStartMs;

  if (stoppedMs < 30000UL) {
    // จอด < 30 วิ → ส่งทุก 5s
    sleepModeActive = SLEEP_NONE;
    return INTERVAL_IDLE1;
  } else if (stoppedMs < 5UL * 60000UL) {
    // จอด 30s - 5min → Modem Sleep, ส่งทุก 15s
    sleepModeActive = 1;
    WiFi.setSleepMode(WIFI_MODEM_SLEEP);  // ปิด WiFi modem ระหว่าง idle
    return INTERVAL_IDLE2;
  } else {
    // จอด > 5min → Max save, ส่งทุก 30s
    sleepModeActive = 2;
    WiFi.setSleepMode(WIFI_MODEM_SLEEP);
    return INTERVAL_IDLE3;
  }
}

/**
 * ตื่นจาก Modem Sleep ก่อนส่ง WiFi
 * โดยปกติ ESP8266 reconnect เองได้
 */
void wakeWiFiIfNeeded() {
  if (sleepModeActive > 0) {
    WiFi.setSleepMode(WIFI_NONE_SLEEP);
    delay(100);  // รอ modem ตื่น
  }
}

// ============================================================
//  SEND TO SERVER
// ============================================================
bool sendToServer(float lat, float lng, int spd, int bat, String dir) {
  wakeWiFiIfNeeded();
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect(); delay(2000);
    if (WiFi.status() != WL_CONNECTED) return false;
  }

  txCount++;

  String json =
    "{\"vehicleId\":\""  + VEHICLE_ID          + "\""  +
    ",\"routeId\":\""    + ROUTE_ID             + "\""  +
    ",\"direction\":\"" + dir                  + "\""  +
    ",\"lat\":"          + String(lat, 6)                +
    ",\"lng\":"          + String(lng, 6)                +
    ",\"speed\":"        + String(spd)                   +
    ",\"battery\":"      + String(bat)                   +
    // ── Power fields (ใหม่) ──
    ",\"battVoltage\":"  + String((int)measuredVoltMv)    +
    ",\"currentMa\":"    + String((int)measuredCurrentMa) +
    ",\"powerMw\":"      + String((int)measuredPowerMw)   +
    ",\"sleepMode\":"    + String(sleepModeActive)         +
    ",\"txCount\":"      + String(txCount)                 +
    "}";

  HTTPClient http;
  WiFiClientSecure client;    // ← เปลี่ยน WiFiClient → WiFiClientSecure
  client.setInsecure();       // ← เพิ่มบรรทัดนี้
  http.begin(client, SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);
  int code = http.POST(json);
  http.end();

  Serial.printf("[HTTP] %s → %d | tx#%d | sleep:%d | %.0fmV %.0fmA\n",
    VEHICLE_ID.c_str(), code, txCount, sleepModeActive,
    measuredVoltMv, measuredCurrentMa);
  return code == 200;
}

// ============================================================
//  SIMULATION MOVEMENT (เหมือน v2)
// ============================================================
void runSimulation() {
  if (stopTicks > 0) {
    stopTicks--; curSpeed = 0;
  } else {
    int dice = random(0, 100);
    if      (dice < 5)  { stopTicks = random(5,16); targetSpeed = 0; }
    else if (dice < 25) { targetSpeed = random(15,26); }
    else                { targetSpeed = random(30,46); }

    if      (curSpeed < targetSpeed) curSpeed = min(curSpeed+3, targetSpeed);
    else if (curSpeed > targetSpeed) curSpeed = max(curSpeed-3, targetSpeed);

    if (curSpeed > 0) {
      float tLat = ROUTE[targetIdx][0], tLng = ROUTE[targetIdx][1];
      float dLat = tLat-curLat, dLng = tLng-curLng;
      float dist = sqrt(dLat*dLat + dLng*dLng);
      float step = ((float)curSpeed / 3600.0f) * DEG_PER_KM * 2.0f;

      if (dist <= step) {
        curLat = tLat; curLng = tLng;
        stopTicks = random(10,31); curSpeed = 0;
        if (isOutbound) {
          targetIdx++;
          if (targetIdx >= NUM_WP) { targetIdx = NUM_WP-2; isOutbound = false; }
        } else {
          targetIdx--;
          if (targetIdx < 0) { targetIdx = 1; isOutbound = true; }
        }
        targetSpeed = random(30,46);
      } else {
        curLat += (dLat/dist)*step;
        curLng += (dLng/dist)*step;
      }
    }
  }
  direction = isOutbound ? "พรหมคีรี" : "นครศรีธรรมราช";

  // Battery simulation
  if (random(0,50) == 0) battery--;
  if (battery < 10) battery = 92;
}

// ============================================================
//  LOOP
// ============================================================
void loop() {
  // WiFi watchdog
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Reconnecting...");
    WiFi.reconnect(); delay(3000); return;
  }

  // คำนวณ delay ที่เหมาะสม
  unsigned long delayMs = getAdaptiveDelay();

  // วัดพลังงาน (ทำก่อนส่งเพื่อ log ค่า WiFi TX)
  measurePower();

  // ── Simulation ──
  #ifndef USE_REAL_GPS
    runSimulation();
    float nLat = curLat + (random(-5,6)*0.00001f);
    float nLng = curLng + (random(-5,6)*0.00001f);
    sendToServer(nLat, nLng, curSpeed, battery, direction);

  // ── Real GPS ──
  #else
    unsigned long gpsStart = millis();
    while (millis() - gpsStart < 1800) {
      while (gpsSerial.available()) gps.encode(gpsSerial.read());
      yield();
    }
    bool hasFix = gps.location.isValid() && gps.location.age() < 3000;
    if (!hasFix) {
      Serial.println("[GPS] No fix");
      sendToServer(curLat, curLng, 0, battery, direction);  // fallback last pos
    } else {
      curLat  = (float)gps.location.lat();
      curLng  = (float)gps.location.lng();
      curSpeed = gps.speed.isValid() ? (int)gps.speed.kmph() : 0;
      if (curLat > 8.49f) direction = "พรหมคีรี";
      else                direction = "นครศรีธรรมราช";
      Serial.printf("[GPS] Fix | %.6f,%.6f | %dkm/h\n", curLat, curLng, curSpeed);
      sendToServer(curLat, curLng, curSpeed, battery, direction);
    }
  #endif

  // Log power save status
  if (POWER_MODE == SLEEP_ADAPTIVE && curSpeed == 0 && stopStartMs > 0) {
    unsigned long stoppedSec = (millis() - stopStartMs) / 1000;
    Serial.printf("[SLEEP] Stopped %lus → next TX in %lums\n", stoppedSec, delayMs);
  }

  delay(delayMs);
}
