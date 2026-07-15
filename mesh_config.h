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
#define VEHICLE_COUNT   3

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

// Packet size limit
#define MAX_LORA_PACKET_BYTES 200

// GPS
#define GPS_RX_PIN      2    // D4 <- GPS TX
#define GPS_BAUD        9600

// Battery sense voltage divider
#define BAT_PIN         A0

// TDMA and timing
#define TX_INTERVAL_MS        10000UL
#define TX_SLOT_SPACING_MS    500UL
#define TX_JITTER_MS          30UL
#define TX_SYNC_GUARD_MS      100UL
#define BEACON_INTERVAL_MS    TX_INTERVAL_MS
#define RELAY_WINDOW_START_MS 1800UL
#define RELAY_SLOT_SPACING_MS 350UL
#define RELAY_SLOT_COUNT      VEHICLE_COUNT
#define GROUND_RX_WINDOW_MS   4000UL
#define GROUND_HTTP_TIMEOUT_MS 5000UL
#define GROUND_BATCH_SIZE     6
#define NEIGHBOR_EXPIRE_MS    30000UL
#define WIFI_RETRY_MS         30000UL
#define WIFI_SETUP_TIMEOUT_MS 20000UL
#define EXPIRE_INTERVAL_MS    5000UL

// Mesh sizing
#define MAX_NEIGHBORS         10
#define SHARED_STATE_SIZE     10
#define VERSION_SUMMARY_LIMIT 5
#define RELAY_QUEUE_SIZE      4
#define DEDUP_BUFFER          10
#define BUFFER_SIZE           40
#define MAX_HOPS              2
#define MESH_SEEN_TIMEOUT_MS  NEIGHBOR_EXPIRE_MS

// Relay policy
#define RELAY_DISTANCE_MARGIN_M 20.0f
#define MIN_RELAY_LINK_QUALITY  20

// Forced-hop test (disabled in normal operation).
// When enabled, telemetry from FORCED_HOP_TEST_SOURCE must travel through
// FORCED_HOP_TEST_RELAY_1 and FORCED_HOP_TEST_RELAY_2 before Ground accepts it.
#define FORCED_HOP_TEST_ENABLED       0
#define FORCED_HOP_TEST_SOURCE        "BUS_03"
#define FORCED_HOP_TEST_RELAY_1       "BUS_02"
#define FORCED_HOP_TEST_RELAY_2       "BUS_01"
#define FORCED_HOP_TEST_EXPECTED_HOPS 2

// Power Management
#define PWR_EN_PIN              0     // D3 / GPIO0 - IRF9540N Gate
#define PWR_ON                  LOW   // LOW = MOSFET conducts = power ON

#endif // MESH_CONFIG_H
