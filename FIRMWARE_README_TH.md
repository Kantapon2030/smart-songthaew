# คู่มือติดตั้ง Firmware รถและสถานีฐาน

คู่มือนี้ใช้กับ Firmware V03.2 สำหรับระบบรถ 3 คัน ได้แก่ `BUS_01`, `BUS_02` และ `BUS_03` รถส่งข้อมูลทุก 10 วินาทีผ่าน LoRa ไปยังสถานีฐาน แล้วสถานีฐานรวมข้อมูลส่งขึ้นเว็บเป็น batch

## สิ่งที่ต้องมี

- รถแต่ละคัน: ESP8266 NodeMCU/LOLIN, LoRa SX1276/SX1278 (Ra-02), GPS NEO-6M และวงจรวัดแบตเตอรี่เข้าขา A0
- สถานีฐาน: ESP8266 NodeMCU/LOLIN, LoRa SX1276/SX1278 และ WiFi ที่ออกอินเทอร์เน็ตได้
- Arduino IDE หรือ PlatformIO

## การต่อสาย LoRa

ใช้ผังเดียวกันทั้งรถและสถานีฐาน

| LoRa | NodeMCU |
| --- | --- |
| SCK | D5 / GPIO14 |
| MISO | D6 / GPIO12 |
| MOSI | D7 / GPIO13 |
| NSS / CS | D8 / GPIO15 |
| RESET | D0 / GPIO16 |
| DIO0 | D2 / GPIO4 |
| VCC | 3V3 |
| GND | GND |

GPS ของรถ: `GPS TX -> D4 / GPIO2`, `VCC -> 3V3`, `GND -> GND` โดยไม่ต้องต่อ GPS RX หรือ PPS

## ตั้งค่าก่อนแฟลช

1. คัดลอก `songthaew_secrets.example.h` เป็น `songthaew_secrets.h`

2. ตั้งค่า WiFi, URL เว็บ และ key ของสถานีฐาน:

```cpp
#define WIFI_SSID "ชื่อ_WiFi"
#define WIFI_PASS "รหัสผ่าน_WiFi"
#define SERVER_URL "https://smart-songthaew.vercel.app/api/update-location"
#define GROUND_KEY "ตั้งเป็นข้อความสุ่มยาวอย่างน้อย-24-ตัวอักษร"
```

3. แฟลชรถทีละคัน โดยแก้เฉพาะ `VEHICLE_ID` ก่อนอัปโหลดแต่ละบอร์ด:

```cpp
#define VEHICLE_ID "BUS_01" // เปลี่ยนเป็น BUS_02 หรือ BUS_03 ตามบอร์ด
#define ROUTE_ID   "route_001"
#define ROUTE_DIR  "outbound"
```

ห้าม commit ไฟล์ `songthaew_secrets.h` เพราะมีรหัส WiFi และ `GROUND_KEY`

## Provision GROUND_KEY บนเว็บ

ต้องทำหลัง deploy server เวอร์ชันนี้แล้ว และทำก่อนเปิดสถานีฐานจริง ใช้ admin token เรียก API นี้ครั้งเดียว:

```http
POST /api/v1/admin/ground-keys/GROUND_01
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{"key":"ค่าเดียวกับ GROUND_KEY ใน songthaew_secrets.h"}
```

ระบบเก็บเฉพาะ hash ของ key ถ้า key ไม่ตรง สถานีฐานจะรับ LoRa ได้ แต่ server จะตอบ `HTTP 403` และข้อมูลจะไม่ขึ้นเว็บ

## ลำดับการอัปโหลดที่ถูกต้อง

1. Push และ deploy server/web ก่อน เพื่อให้มี `/api/v1/ground/telemetry-batch`
2. Provision `GROUND_KEY`
3. อัปโหลด [Songthaew_V03_ground.ino](<E:/01_Software_Development/Smart%20Song%20theaw/smart-songthaew/Songthaew_V03_ground.ino>) ลงสถานีฐาน
4. อัปโหลด [Songthaew_V03_vehicle.ino](<E:/01_Software_Development/Smart%20Song%20theaw/smart-songthaew/Songthaew_V03_vehicle.ino>) ลง `BUS_01`, `BUS_02`, `BUS_03` ทีละบอร์ด
5. เปิด Serial Monitor ที่ `115200` baud และทดสอบรถทั้ง 3 คันพร้อมกัน

## วิธี build

Arduino IDE: ติดตั้งไลบรารี `LoRa 0.8.0`, `TinyGPSPlus 1.0.3` และ `ArduinoJson 7.x` แล้วเปิดไฟล์ `.ino` ที่ต้องการ

PlatformIO มีไฟล์ [platformio.ini](<E:/01_Software_Development/Smart%20Song%20theaw/smart-songthaew/platformio.ini>) สำหรับตรวจ build แยก ground และรถทั้ง 3 ID:

```sh
platformio run
```

การ build สำหรับใช้งานจริงต้องใช้ `songthaew_secrets.h` ของหน้างานเอง จึงไม่มีไฟล์ `.bin` ที่ฝังรหัสจริงให้ดาวน์โหลดจากเว็บ

## สิ่งที่ควรเห็นใน Serial Monitor

รถที่พร้อมทำงาน:

```text
[PWR] Peripherals locked ON
[TX-SLOT] beacon_sync offset:500ms guard:100ms jitter_max:30ms
[RX] beacon GROUND_01 rssi:-73 snr:9.5 next_tx:...
[TX] BUS_02 mode:beacon hop:0 bytes:... a0:201 sent
```

สถานีฐานที่พร้อมทำงาน:

```text
[LoRa] ready
[BEACON] sent
[RX] BUS_01 | hop:0 | rssi:-73 | snr:9.5
-> queued for HTTP after RX window
[BATCH] accepted:3 depth:0
```

ทุกประมาณ 30 วินาทีสถานีฐานจะแสดงสรุป `[GROUND]` และ `[GROUND_RX]` เช่น queue, retry, drop, heap และจำนวนแพ็กเก็ตของแต่ละคัน

## การทำงานของระบบ

- รถทั้ง 3 คันใช้ slot ห่างกัน 500 ms ภายใต้ beacon เดียวจากสถานีฐาน
- รถส่ง raw A0 เช่น `a0:201` เท่านั้น เว็บเป็นผู้คำนวณ A0 voltage, แรงดันแบตเตอรี่ และเปอร์เซ็นต์ตาม calibration ในหน้า Admin
- รถที่ไม่ได้ยินสถานีฐานจะขอ relay ได้สูงสุด 2 hops
- Relay จะรอ relay window หลัง direct slots เพื่อลดการชนกันของสัญญาณ
- สถานีฐานเก็บได้ 40 packet ขณะ WiFi/server มีปัญหา และส่งซ้ำเป็น batch ในรอบถัดไป

## แก้ปัญหาเบื้องต้น

| อาการ | จุดตรวจสอบ |
| --- | --- |
| `[LoRa] init failed` | ตรวจ VCC 3.3V, GND ร่วมกัน, ขา D0/D2/D5/D6/D7/D8 และโมดูล LoRa |
| รถส่งแต่ ground ไม่รับ | ตรวจความถี่ `923 MHz`, sync word `0x34`, SF7 และสาย DIO0 |
| ground รับได้แต่เว็บไม่อัปเดต | ตรวจ WiFi, URL, `GROUND_KEY` และ response `HTTP 403/500` |
| queue เพิ่มต่อเนื่อง | ตรวจ latency ของ server/WiFi และ log `[BATCH]`; อย่าเพิ่มจำนวนรถเกิน 3 ใน profile นี้ |
| ค่าแบตเตอรี่ไม่ตรง | ตรวจ raw A0 ใน log รถ แล้วปรับ calibration ในหน้า Admin ไม่ต้องแก้ firmware |

## ข้อจำกัดของรุ่นนี้

รุ่นนี้ออกแบบให้ใช้งานเสถียรกับ 3 รถและ LoRa ช่องเดียว ไม่ควรเพิ่มเป็น 10 หรือ 300 คันด้วยการแก้ `VEHICLE_COUNT` อย่างเดียว เป้าหมายระดับนั้นควรย้ายสถานีฐานไป ESP32/Raspberry Pi พร้อม SX1302/SX1303 concentrator และใช้ MQTT/queue ฝั่ง server
