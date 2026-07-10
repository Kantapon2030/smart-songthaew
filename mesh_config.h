// mesh_config.h - safe to commit
// Non-secret hardware, LoRa, timing, and mesh settings.
// Put WiFi credentials, server URL, vehicle ID, route ID, and route direction in songthaew_secrets.h.

#ifndef MESH_CONFIG_H
#define MESH_CONFIG_H

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
#define LORA_SF         7
#define LORA_CR         5
#define LORA_SYNC       0x34
#define LORA_TX_DBM     17

// Packet priority limits
#define MAX_LORA_PACKET_BYTES 200
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

// Battery sense voltage divider
#define BAT_PIN         A0
#define BAT_R1          330000.0
#define BAT_R2          82000.0
#define BAT_ADC_REF_V   3.3     // NodeMCU/LOLIN A0 pin scale; 0.63V is measured at the board A0 pin
#define BAT_DIVIDER_RATIO 6.6508  // Calibrated: 4.19V battery -> 0.63V at A0
#define BAT_EMPTY_V     3.30
#define BAT_FULL_V      4.19
#define BAT_SAMPLE_COUNT 15
#define BAT_SAMPLE_DELAY_MS 2
#define BAT_FILTER_ALPHA 0.15f

// TDMA and timing
#define TX_INTERVAL_MS        5000UL
#define TX_SLOT_COUNT         VEHICLE_COUNT
#define TX_SLOT_SPACING_MS    500UL
#define TX_JITTER_MS          30UL
#define TX_SYNC_GUARD_MS      100UL
#define GPS_TX_WINDOW_MS      250UL
#define BEACON_INTERVAL_MS    10000UL
#define NEIGHBOR_EXPIRE_MS    30000UL
#define WIFI_RETRY_MS         30000UL
#define WIFI_SETUP_TIMEOUT_MS 20000UL
#define FLUSH_INTERVAL_MS     5000UL
#define EXPIRE_INTERVAL_MS    5000UL
#define CARRY_RETRY_MS        7000UL
#define CARRY_PACKET_TTL_MS   180000UL

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
#define TX_INTERVAL_NORMAL      5000UL
#define TX_INTERVAL_LOW_BAT     15000UL
#define TX_INTERVAL_STATIONARY  30000UL
#define SLEEP_CHECK_MS          60000UL // check sleep condition every 60s

// Stationary detection
#define STATIONARY_DIST_M       5.0f  // meters - if moved less than this
#define STATIONARY_COUNT        3     // consecutive readings before stationary

#endif // MESH_CONFIG_H
