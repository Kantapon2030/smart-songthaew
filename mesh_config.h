// mesh_config.h - safe to commit
// Non-secret hardware, LoRa, timing, and mesh settings.
// Put WiFi credentials, server URL, vehicle ID, route ID, and route direction in songthaew_secrets.h.

#ifndef MESH_CONFIG_H
#define MESH_CONFIG_H

#define FW_BUILD_ID    "2026-07-07-rxdiag-02"

// Ground station location (can be overridden in songthaew_secrets.h)
#ifndef GROUND_LAT
#define GROUND_LAT    8.4304
#endif
#ifndef GROUND_LNG
#define GROUND_LNG    99.9631
#endif
#ifndef GROUND_ID
#define GROUND_ID     "GROUND_01"
#endif

// Vehicles
#define VEHICLE_ID_LIST { "BUS_01", "BUS_02", "BUS_03", "BUS_04", "BUS_05", "BUS_06", "BUS_07", "BUS_08", "BUS_09", "BUS_10" }
#define VEHICLE_COUNT   10

// LoRa pin mapping: ESP8266 NodeMCU + SX1276/Ra-02
#define LORA_SS_PIN    15   // D8
#define LORA_RST_PIN   16   // D0
#define LORA_DIO0_PIN   4   // D2
#define LORA_SS         LORA_SS_PIN
#define LORA_RST        LORA_RST_PIN
#define LORA_DIO0       LORA_DIO0_PIN

// LoRa RF settings
#define LORA_FREQ       923E6
#define LORA_BW         125E3
#define LORA_SF         9
#define LORA_CR         5
#define LORA_SYNC       0x34
#define LORA_TX_DBM     20

// Packet priority limits
#define MAX_LORA_PACKET_BYTES 170
#define LORA_TIER1_LIMIT      140
#define LORA_TIER2_LIMIT      170
#define LORA_TIER3_LIMIT      180
#define LORA_TIER4_LIMIT      195

// GPS
#define GPS_RX_PIN      2    // D4 <- GPS TX
#define GPS_PPS_PIN     5    // D1 <- GPS PPS / 1PPS
#define GPS_BAUD        9600
#define GPS_MIN_SATS    4
#define GPS_TIMEOUT_MS  60000UL
#define GPS_LOCATION_FRESH_MS 3000UL
#define GPS_TIME_FRESH_MS     3000UL
#define GPS_FIX_HOLD_MS       86400000UL

// Battery sense voltage divider
#define BAT_PIN         A0
#define BAT_R1          330000.0
#define BAT_R2          82000.0
#define BAT_VCC         3.3
#define BAT_DIVIDER_RATIO 6.8833  // Calibrated: 4.13V battery -> 0.60V at A0
#define BAT_EMPTY_V     3.30
#define BAT_FULL_V      4.13
#define BAT_AUTO_CALIBRATE true
#define BAT_CAL_CUTOFF_TEST_MODE true
#define BAT_CAL_MIN_RANGE_V 0.50
#define BAT_CAL_SAVE_INTERVAL_MS 60000UL
#define BAT_CAL_UPDATE_STEP_V 0.01

// TDMA and timing
#define TX_INTERVAL_MS        5000UL
#define TX_SLOT_COUNT         3
#define TX_SLOT_SPACING_MS    1600UL
#define TX_JITTER_MS          30UL
#define TX_SYNC_GUARD_MS      200UL
#define GPS_TX_WINDOW_MS      250UL
#define BEACON_INTERVAL_MS    10000UL
#define NEIGHBOR_EXPIRE_MS    30000UL
#define WIFI_RETRY_MS         30000UL
#define WIFI_RECONNECT_MS     10000UL
#define WIFI_SETUP_TIMEOUT_MS 20000UL
#define FLUSH_INTERVAL_MS     5000UL
#define HTTP_TIMEOUT_MS       8000
#define HTTP_CONNECT_TIMEOUT  5000
#define HTTPS_RX_BUFFER_SIZE  512
#define HTTPS_TX_BUFFER_SIZE  512
#define GND_COEXIST_SCHEDULER_ENABLED false
#define GND_SLOT_WINDOW_BEFORE_MS 120UL
#define GND_SLOT_WINDOW_AFTER_MS 650UL
#define GND_HTTP_MIN_SAFE_GAP_MS 300UL
#define GND_MAX_UPLOAD_PER_IDLE_WINDOW 1
#define GND_NO_RX_BEACON_INTERVAL_MS 60000UL
#define GND_LORA_RX_KICK_MS 1000UL
#define GND_LORA_NO_RX_REINIT_MS 60000UL
#define WIFI_MAX_RETRIES      10
#define FLUSH_MAX_PER_CALL    3
#define GND_HEARTBEAT_MS      30000UL
#define GND_WDT_TIMEOUT_MS    8000
#define EXPIRE_INTERVAL_MS    5000UL
#define CARRY_RETRY_MS        7000UL
#define CARRY_PACKET_TTL_MS   180000UL
#define WDT_TIMEOUT_MS        8000
#define LORA_HEALTH_CHECK_MS  30000UL
#define LORA_REINIT_RETRIES   3
#define LORA_TX_FAIL_LIMIT    3
#define LORA_BEGIN_TIMEOUT_MS 5000UL
#define LORA_BEGIN_MAX_FAILURES LORA_REINIT_RETRIES
#define GPS_POWER_WAIT_MS     2000UL
#define GPS_EEPROM_MAGIC      0xBEEF1234UL
#define GPS_SAVE_INTERVAL_MS  60000UL
#define BOOT_TX_DELAY_MS      500UL
#define COMMAND_POLL_MS       (24UL * 60UL * 60UL * 1000UL)
#define ADAPTIVE_STATUS_MS    30000UL

// Adaptive LoRa - disabled by default for stability.
// Enable only when vehicle count exceeds threshold.
#define ADAPTIVE_LORA_ENABLED   false
#define ADAPTIVE_DEFAULT_SF     9
#define ADAPTIVE_DEFAULT_TP     20
#define ADAPTIVE_DEFAULT_TI     5000UL
#define ADAPTIVE_THRESHOLD_VC   3
#define ADAPTIVE_HIGH_SF        8
#define ADAPTIVE_HIGH_TP        17
#define ADAPTIVE_HIGH_TI        5000UL

// Mesh sizing
#define MAX_NEIGHBORS         10
#define MESH_MAX_NEIGHBORS    MAX_NEIGHBORS
#define SHARED_STATE_SIZE     10
#define VERSION_SUMMARY_LIMIT 5
#define CARRY_BUFFER_SIZE     8
#define CARRY_MAX_ATTEMPTS    5
#define DEDUP_BUFFER          10
#define BUFFER_SIZE           20
#define MAX_HOPS              3
#define MESH_DEFAULT_TTL      MAX_HOPS
#define MESH_CACHE_SIZE       BUFFER_SIZE
#define MESH_CACHE_TTL_MS     NEIGHBOR_EXPIRE_MS
#define MESH_SEEN_TIMEOUT_MS  NEIGHBOR_EXPIRE_MS

// Relay policy
#define RELAY_DISTANCE_MARGIN_M 20.0f
#define MIN_RELAY_LINK_QUALITY  20
#define RELAY_SUPPRESS_WHEN_GROUND_NEARBY true

// Optional current sensor placeholder
#define INA219_ENABLED false

// Power Management
#define PWR_EN_PIN              0     // D3 / GPIO0 - IRF9540N Gate
#define PWR_ON                  LOW   // LOW = MOSFET conducts = power ON
#define PWR_OFF                 HIGH  // HIGH = MOSFET off = power OFF

// Battery thresholds
#define BAT_CRITICAL_PCT        20    // below this -> deep sleep
#define BAT_LOW_PCT             30    // below this -> reduce TX frequency

// Adaptive TX intervals (ms)
#define WEB_OFFLINE_TIMEOUT_MS  90000UL
#define STATIONARY_TX_MARGIN_MS 30000UL
#define TX_INTERVAL_NORMAL      5000UL
#define TX_INTERVAL_LOW_BAT     15000UL
#define TX_INTERVAL_STATIONARY  (WEB_OFFLINE_TIMEOUT_MS - STATIONARY_TX_MARGIN_MS)
#define SLEEP_CHECK_MS          60000UL // check sleep condition every 60s
#define STATIONARY_POWER_OFF_ENABLED 0
#define STATIONARY_MAX_MS       (30UL * 60UL * 1000UL)
#define HEARTBEAT_INTERVAL_MS   60000UL

// Stationary detection
#define STATIONARY_DIST_M       5.0f  // meters - if moved less than this
#define STATIONARY_COUNT        3     // consecutive readings before stationary

#endif // MESH_CONFIG_H
