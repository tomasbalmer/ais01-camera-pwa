# Himax WE-I firmware update over USB

Stage: `Implementation`
Last Updated: 2026-10-23

## High-Level Objective

Update the AI camera chip of the Dragino AIS01 (Himax WE-I Plus, HX6537) from an Android phone in Chrome over USB-OTG, through the Dragino AUC
converter in UART mode, instead of Himax's Windows-only `ota.exe`.

## Mid-Level Objectives

- [x] Reuse the calibration flow's FTDI transport (WebUSB, FT230X): no second driver
- [x] A screen "Update firmware over USB" next to "Connect via USB": pick layout.bin and output.img, tap Update, see progress
- [x] Upgrade all only: skip the first two layout entries (1st and 2nd loader); refuse any loader among the rest; never force upgrade
- [x] Work at 921600 only; send Intoupg first, before anything else, and repeat Intoupg + Getstatus up to 10 times
- [x] Every delay, baud and status rule of the protocol below is a constant in `modules/constants.js` (`HIMAX_OTA`)
- [x] Raw replies logged in hex in the Device Log
- [x] First live test on a real AIS01 settles the open questions in section 9 (section 10)

## Implementation

- `modules/himax-ota.js`: CRC-16/MCRF4XX, frame builders, layout.bin parser, reply parser, and `upgradeAll`, which drives an injected link
  (`setBaud`, `purge`, `write`, `read`) and an injected `sleep`. No DOM, so it runs under node.
- `modules/ftdi.js`: `openFtdi` (the D2XX init sequence `connectDevice` always ran, minus the camera's START), `setFtdiBaud`, and
  `ftdiSerial`, a byte link over the bulk endpoints that strips the FTDI status bytes and purges RX before each Getstatus.
- `modules/ota-screen.js` + `#ota-panel` in `index.html`: the screen.
- `firmware/index.json` + `modules/firmware-catalog.js`: the firmwares the screen offers ready to send (today Camera firmware 2023-05,
  application built 2023-05-04). Each file carries its sha256 and the app refuses to send a file that does not match. Its WATERMETER_CONF
  part (80 bytes at 0xC0000) is a full ROI for 5 digits, so the update replaces the camera's calibration; the screen says so.
- `modules/fake-himax-loader.js`: a simulated 2nd loader that re-checks every CRC, records each part, answers in the real reply format,
  and can be silent, in its application, ignoring the first Intoupgs, busy after a burn, or failing a burn. `node modules/himax-ota.test.mjs` runs the tests against it.

Stricter than ota.exe, on purpose: RX is purged (and anything found is logged) before every Getstatus; after each part the app polls
Getstatus until status is 1 or 5 with error 0 (cap 20 s) and stops on any error instead of moving on; the camera is rebooted only when
the final Getstatus says OTA_LOADER_IDLE with no error.

## Protocol (reconstructed from ota.exe by static analysis)


Source: static analysis of `ota.exe` (PE32, MinGW GCC 7.4, built "Sep 5 2022", banner prints version 2.2.1 although the docs say 2.1.0),
its import table, `.rdata`/`.data`, `OTA_time.ini` and the vendor docx/pptx. Nothing was executed. Addresses below are ota.exe VAs.
Confidence tags: **[code]** read directly from the disassembly; **[infer]** reasoned from code shape; **[open]** needs a live capture.

### 1. Transport

- The tool talks to an FTDI chip through D2XX (`ftd2xx.dll`, imported by ordinal). IAT slots resolved from ftd2xx.dll's export table:
  `0x40c1cc FT_Open`, `1d0 FT_Close`, `1d4 FT_Read`, `1d8 FT_Write`, `1dc FT_SetBaudRate`, `1e0 FT_SetDataCharacteristics`,
  `1e4 FT_SetFlowControl`, `1e8 FT_SetTimeouts`, `1ec FT_GetStatus`, `1f0 FT_ListDevices`, `1f4 FT_GetComPortNumber`. **[code]**
- Nothing FTDI-specific is used on the wire (no bit-bang, no GPIO, no DTR/RTS, no break). A plain USB-serial adapter is equivalent. **[code]**
- `_OpenChoiceComPort` (0x401e33): **8 data bits, 1 stop bit, no parity** (`FT_SetDataCharacteristics(h, 8, 0, 0)`), **no flow control**
  (`FT_SetFlowControl(h, FT_FLOW_NONE, 0x11, 0x13)`; XON/XOFF chars are passed but unused), timeouts read 5000 ms / write 1000 ms. **[code]**
- Baud rate: chosen by the user from `_FT_BAUD_LIST` (0x407020): 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200,
  230400, 460800, 921600. **There is no default in the tool**; the right value is whatever the device's application and 2nd loader
  UART are configured for. **[code]** The rate the HX6537 2nd loader expects is **[open]** (115200 and 921600 are the likely candidates).
- The tool never purges RX/TX buffers. Do purge before each request in a reimplementation. **[code]**

### 2. CRC

`_crc16_ccitt` (0x404fdc), bitwise, LSB-first:

```
crc = 0xFFFF
for each byte b: for 8 bits: crc = ((crc ^ b) & 1) ? (crc >> 1) ^ 0x8408 : crc >> 1; b >>= 1
return crc          // no final XOR
```

This is **CRC-16/MCRF4XX**: poly 0x1021 (reflected 0x8408), init 0xFFFF, refin = refout = true, xorout 0x0000. **[code]**
Test vectors: `"123456789"` -> `0x6F91`; empty input -> `0xFFFF`; `50 05 00 00` -> `0xEF8A`. The CRC is always stored little-endian.

### 3. Host -> device frames

#### 3.1 Command frame (7 bytes) — `_RS232_SendCommand` (0x401af2) **[code]**

```
off 0  0xC0              sync byte
off 1  cmd               0x50 = system/status class, 0x51 = upgrade class
off 2  sub               command id inside the class
off 3  len  (u16 LE)     length of the data frame that follows, 0 if none
off 5  crc  (u16 LE)     CRC-16/MCRF4XX over bytes 1..4 (cmd, sub, len) only; the 0xC0 is not covered
```

#### 3.2 Data frame (len + 2 bytes) — `_RS232_SendData` (0x401bb6) **[code]**

```
off 0      payload[len]
off len    crc (u16 LE)  CRC-16/MCRF4XX over payload
```

#### 3.3 How they combine — `_OTA_SENT_COMMAND` (0x40532f) **[code]**

`send(cmd, sub, len, data)`: write the command frame with `len`; if `len != 0`, sleep **8 ms**, then write the data frame.
There is no reply or ACK to either frame. The 8 ms gap is presumably the time the loader needs to re-arm its RX for `len + 2` bytes. **[infer]**

#### 3.4 Command table

| cmd | sub | name (tool string) | data | reply | valid in |
|-----|-----|--------------------|------|-------|----------|
| 0x50 | 0x00 | GetVersion | none | yes, u32 | 2nd loader |
| 0x50 | 0x01 | GetProject id (`GET_PROJID`) | none | yes, u32 | 2nd loader |
| 0x50 | 0x05 | Getstatus | none | yes, u32 status word | application and 2nd loader |
| 0x50 | 0x06 | ReBoot WEI | none | none read | 2nd loader |
| 0x50 | 0x07 | Intoupg (application reboots into 2nd loader) | none | none read | application |
| 0x50 | 0x08 | Read chip id | none | yes, 2 x u32 | application |
| 0x50 | 0x12 | WEI_OTA_FLASH_DUMP | none | raw flash bytes (see 4.3) | "I2C loader" per menu text |
| 0x50 | 0x13 | WEI_OTA_FLASH_ERASE_ALL | none | none read | "I2C loader" per menu text |
| 0x51 | 0x02 | WEI_OTA_START | 16 bytes: the layout entry (5.1) | none | 2nd loader |
| 0x51 | 0x03 | WEI_OTA_DATA | up to 5120 bytes of image | none | 2nd loader |
| 0x51 | 0x04 | WEI_OTA_END | none | none | 2nd loader |

Sub ids 0x02..0x04 and 0x09..0x11 are unused by the tool under 0x50. Mapping is **[code]**; the "valid in" column comes from the menu text.

#### 3.5 Byte-level examples (all computed with the CRC above)

```
GetVersion        C0 50 00 00 00 37 D6
GetProjID         C0 50 01 00 00 EB 8C
Getstatus         C0 50 05 00 00 8A EF
Reboot            C0 50 06 00 00 EE 00
Intoupg           C0 50 07 00 00 32 5A
ReadChipId        C0 50 08 00 00 F5 10
FlashDump         C0 50 12 00 00 1A E6
FlashEraseAll     C0 50 13 00 00 C6 BC
OTA_START header  C0 51 02 10 00 A5 EA
  + data frame    03 00 00 00 01 00 00 00 00 00 02 00 C4 05 00 00 FC 37
                  (type 3 MEMDSP, att 0x00000001 illustrative, addr 0x00020000, size 0x5C4, crc 0x37FC)
OTA_DATA header   C0 51 03 00 14 4D 73          (len 0x1400 = 5120, full chunk)
OTA_DATA header   C0 51 03 C4 05 8F DF          (len 0x05C4, last/short chunk)
  + data frame    <len bytes of output.img> <crc16 LE of those bytes>   e.g. 00 01 02 03 -> 00 01 02 03 D6 58
OTA_END           C0 51 04 00 00 ED A9
```

### 4. Device -> host replies

Only Getstatus, GetVersion, GetProjID, ReadChipId and FlashDump are followed by a read. Every read goes through `_OTA_READ_DATA` (0x405830):
sleep 3 ms, then `_Read_UART_Data` (0x402121). **[code]**

#### 4.1 Read procedure — `_Read_UART_Data` **[code]**

1. Read a **7-byte header** (buffer pre-filled with 0xFF). `N = u32 LE at header[3..6]`.
   Header bytes 0..1 are never checked; header byte 2 is checked only for the value 5 (4.3). There is no CRC on the header.
2. Read `N` bytes of payload, in pieces of at most 5120 bytes (buffer pre-filled with 0xFF).
3. `rx_crc = payload[N-2] | payload[N-1] << 8`.
   If `rx_crc == 0xFFFF` -> print "Device still Updating, waiting for device response!" and return -1. In practice this fires when the
   read timed out and the 0xFF fill is still there, so treat it as "not ready / short read", not as a device code. **[infer]**
4. If `crc16(payload[0 .. N-3]) != rx_crc` -> "check sum error", return -1.
5. If `N > 11` (chip id): `id0 = u32 LE payload[N-10..N-7]`, `id1 = u32 LE payload[N-6..N-3]`, printed, returns 0.
   Else: `value = u32 LE payload[N-6..N-3]`, returned.

The I2C path (`_Read_I2C_Data`, 0x401666) reads a fixed 10-byte (14 for chip id) block shaped `cmd, sub, len(u16 LE), value(u32 LE), crc16`,
with the CRC over everything before it. The UART offsets fit that exact shape when N = 10 (or 14), so the expected UART reply is
**7-byte header + the same I2C-style frame**. **[infer]**

Expected Getstatus reply (N = 10), shape **[infer]**, header bytes 0..2 **[open]**:

```
?? ?? ?? 0A 00 00 00 | 50 05 04 00 | 00 00 01 00 | crc_lo crc_hi
header (N=10)          cmd sub len   value LE      CRC over the 8 bytes before it
value 0x00010000 = status 1 (OTA_LOADER_IDLE), error 0 -> ready to upgrade
```

#### 4.2 Status word (Getstatus) — `_print_result` (0x405766) **[code]**

`status = (value >> 16) & 0xFF`, `error = value & 0xFF`; bits 8..15 and 24..31 are ignored.

Status (`_ota_status_string`, 0x40713c): 0 APPLICATION_IDLE, 1 OTA_LOADER_IDLE, 2 OTA_EIP130_INIT, 3 OTA_DATA_VERIFY, 4 OTA_FLASH_CHECK,
5 OTA_DONE, 6 "OTA_LOADER_INIT/RECEIVE/BURN_FLASH" (three names merged by a missing comma in the vendor source, so in firmware 6, 7, 8 are
most likely LOADER_INIT, LOADER_RECEIVE, LOADER_BURN_FLASH **[infer]**).

Error (`_ota_error_string`, 0x407120): 0 NO_ERROR, 1 SEC_INIT, 2 SEC_TRNG, 3 CHECKSUM, 4 "I2C_DRV" merged with "SEC_VERIFY_ERROR",
5 FLASH_CRC_CHECK_FAIL, 6 UNKNOWN. Same missing-comma problem: firmware numbering from 5 on may be shifted by one **[open]**.

`_print_result` returns 1 if `error != 0` (also prints an EIP130 hint when status is 2 and a signature/OTP hint when status is 3),
2 if `error == 0 && status == 1`, else 0. The upgrade flow proceeds and reboots only on **2**.

#### 4.3 Flash dump

If header byte 2 == 5 the payload is written raw to `flash_dump.bin` and no CRC check happens. Which header byte values the device uses for
normal replies (so that byte 2 is never 5 for a Getstatus reply) is **[open]**.

#### 4.4 Read timeouts **[code]**

- Header and payload reads use `_RS232_Length_PollComport` (0x401a4c): `FT_SetTimeouts(read 1000 ms)`, then busy-polls `FT_GetStatus` up to
  800 001 times until the RX queue is non-empty, then one blocking `FT_Read(len)` (up to 1 s). No data at all -> -1 ("No data receive!!").
  The wall time of 800 001 polls is driver-dependent; use an explicit timeout (2-5 s for a header) **[infer]**.
- `_RS232_PollComport` (300 ms) exists but is never called.
- **No retries anywhere**: no resend of a command, chunk or Getstatus. A failure is printed and the flow moves on (per item) or stops.

### 5. Image files

#### 5.1 layout.bin — `_ParseMEMDSP` (0x404bed) **[code]**

The whole file is copied into a 0x210-byte buffer (16-byte header + up to 32 entries; longer files overflow it in the tool).

```
header (16 bytes):  byte 5 = entry count; every other header byte is ignored by the tool
entry i at offset 16*(i+1), 16 bytes, all u32 little-endian:
  +0 pat_type     index into the type table below
  +4 pat_att      bits 0..3 security format: 0 RAW, 1 BLp, 2 BLw, 3 Hmac
                  bit 4 = member of a multi-entry group; bits 5..7 with bit 4: 0x80 = group start, 0x20 = group end (menu display only)
  +8 start_addr   flash address; also the byte offset inside output.img
  +C pat_size     byte count to send
```

pat_type (`_ota_pat_type_string`, 0x4070c0): 0 1st_LOADER, 1 2nd_LOADER, 2 3rd_LOADER, 3 MEMDSP, 4 APPLICATION, 5 APPLICATION_CONFIG,
6 CUST_ALGO_CONFIG, 7 EMZA_CONFIG, 8 CNN_LUT, 9 LOGER, 10 AUDIO_DATA, 11 FR_DATA, 12 STANDALONE, 13 STANDALONE_RAW, 14 FLASHASSRAM,
15 ALANGO, 16 WATERMETER_CONF, 17 ALGORITHM_MODEL, 18 LOADER_CONFIG.

The 16 bytes of an entry are sent unchanged as the OTA_START payload (the pptx calls them OTA_UPG_TYPE, OTA_UPG_ATT, OTA_UPG_ADDRESS,
OTA_UPG_DATA_LENGTH). Vendor screenshot example: MEMDSP BLp at 0x00020000 size 0x5C4, APPLICATION BLp at 0x00021000 size 0xBE6F0.

#### 5.2 output.img **[code]**

Read whole into memory. It is a flat flash image: the bytes for entry *i* are `output.img[start_addr .. start_addr + pat_size)`.
The tool does not parse or validate it (a version/project-id parser at 0x404b2c exists but is never called).

#### 5.3 Which entries a menu choice sends **[code]**

- FORCE UPGRADE: every entry, index 0..count-1 (both loaders included).
- UPGRADE ALL: entries 2..count-1 (skips the first two, assumed to be 1st and 2nd loader).
- A single menu item: every entry whose menu number equals the choice, plus every entry whose menu number is 3 (the first displayed item,
  MEMDSP in practice). So MEMDSP is always re-sent with any partial upgrade, as the docx states.

### 6. Delays — OTA_time.ini (units: microseconds, per the pptx; values go to `usleep`) **[code]**

`_parsing_time_ini` (0x40282a) reads `.\OTA_time.ini` with GetPrivateProfileStringA and overwrites a built-in default only when a key exists.

| variable | ini key read | built-in default | value with shipped ini |
|---|---|---|---|
| notify_command_dt | `[Basic] command_t` | 5000 | 5000 (key absent) |
| get_data_command_dt | `[Basic] notify_command_t` | 20000 | 5000 |
| QUAL uart general / special | `[QUALMODE] uart_general_t / uart_special_t` | 1000000 / 1000000 | 1000000 / 1000000 |
| DUAL uart general / special | `[DUALMODE] uart_general_t / uart_special_t` | 1000000 / 1000000 | 1000000 / 1000000 |

Note the vendor bug: key names are shifted, and `get_data_command` is never read. QUAL applies to LQFP128 and QFN72, DUAL to WLCSP38.

Where they are used:

- `notify_command_dt` (5 ms): after OTA_START, and after every Getstatus before reading its reply.
- `get_data_command_dt` (5 ms effective): after GetVersion, GetProjID, ReadChipId and FlashDump, before reading.
- Burn wait after OTA_END, `_Waitting_time` (0x405620): if `pat_size <= 0x10000`, sleep `uart_general_t` once (1 s);
  else sleep `uart_special_t` once per started 64 KiB block, i.e. `ceil(pat_size / 65536)` seconds with the shipped values.
- Fixed delays in code: 8 ms between command and data frame; 7 ms after each OTA_DATA chunk (10 ms on I2C); 14 ms after the last chunk;
  3 ms before every reply read; 1.2 s before the final Getstatus (UPGRADE ALL and single items; FORCE uses 5 ms); 2 s after Intoupg.

### 7. Getting into the 2nd loader **[code]**

- The tool never checks or forces this inside the upgrade flow. The user first runs Command -> Intoupg (`C0 50 07 00 00 32 5A`) while the
  application firmware is running. The application must implement this command on its UART; it reboots into the 2nd (OTA) loader.
- After Intoupg the tool waits 2 s, closes and reopens the FTDI port at the same settings (on a plain adapter: wait 2 s and flush RX).
- The upgrade starts only if a Getstatus reply gives status 1 (OTA_LOADER_IDLE) with error 0; otherwise it prints the result and stops.
- `_SECOND_LOADER_CHECK` (0x4058a0, Getstatus -> Intoupg retry loop, 50 ms or 1 s waits) is dead code: its loop condition is always false and
  it has no caller.
- Boot from I2C (bootrom, "Other Tools") is I2C-only and unrelated to the UART path.

### 8. Upgrade sequence (pseudocode, faithful to the tool, with the extra safety a reimplementation should add marked `+`)

```
open(port, baud, 8N1, no flow control)
layout   = read("layout.bin");  count = layout[5]
entries  = [unpack("<IIII", layout[16*(i+1) : 16*(i+2)]) for i in range(count)]
image    = read("output.img")
selected = entries            # FORCE;  entries[2:] for UPGRADE ALL

def cmd(c, s, data=b""):
    + purge_rx()
    write(C0 | c s len16 | crc16(c s len16))
    if data: sleep(8 ms); write(data | crc16(data))

def read_reply():
    sleep(3 ms)
    hdr = read_exact(7, timeout)          ; N = u32le(hdr[3:7])
    p   = read_exact(N, timeout)
    if u16le(p[N-2:]) == 0xFFFF or crc16(p[:N-2]) != u16le(p[N-2:]): fail
    return u32le(p[N-6:N-2])

def get_status():
    cmd(0x50, 0x05); sleep(notify_dt = 5 ms); v = read_reply()
    return (v >> 16) & 0xFF, v & 0xFF      # status, error

# optional: cmd(0x50, 0x07); sleep(2 s); purge_rx()      (application -> 2nd loader)
st, err = get_status();  require st == 1 and err == 0    # OTA_LOADER_IDLE

for (ptype, patt, addr, size) in selected:
    cmd(0x51, 0x02, pack("<IIII", ptype, patt, addr, size));  sleep(5 ms)
    off = 0
    while off < size:
        n = min(5120, size - off)
        cmd(0x51, 0x03, image[addr + off : addr + off + n]);  sleep(7 ms)
        off += n
    sleep(14 ms)
    cmd(0x51, 0x04)
    sleep(1 s if size <= 0x10000 else ceil(size / 0x10000) * 1 s)    # QUAL and DUAL UART values are equal
    st, err = get_status()           # tool only prints it and continues
    + if err != 0: abort, or poll get_status until st == 1 (with a time cap) before the next entry

sleep(1.2 s)                         # 5 ms in FORCE
st, err = get_status()
if st == 1 and err == 0: cmd(0x50, 0x06)       # reboot into the new firmware
```

Throughput estimate at 921600 baud: a 5120-byte chunk takes about 56 ms on the wire plus 15 ms of fixed gaps, about 70 KB/s.
At 115200 baud: about 450 ms per chunk, about 11 KB/s.

### 9. Open questions (need a live capture)

1. Baud rate the HX6537 application and 2nd loader actually use (the tool has no default).
2. Header bytes 0..2 of every reply: is byte 0 = 0xC0 and what are bytes 1..2? Which value marks a flash dump (tool tests byte 2 == 5)?
3. Whether the reply payload really is `cmd, sub, len16, value32, crc16` (shape inferred from the I2C path and the UART offsets).
4. Whether the 2nd loader emits any unsolicited bytes (boot banner, per-chunk ACK, error frames) that the tool silently leaves in the
   RX buffer; the tool never purges, so a later Getstatus could be misparsed.
5. The minimum safe gaps: is 8 ms between header and data, and 7 ms between chunks, needed at the chosen baud, and can the 1 s burn wait be
   replaced by polling Getstatus until status returns to 1 (OTA_LOADER_IDLE) or reaches 5 (OTA_DONE)?
6. Status values seen during and after a burn (does it go 6 -> 7 -> 8 -> 1, or report 5 OTA_DONE?) and the real error numbering above 4.
7. What the application does with Intoupg on UART (reply or none, how long until the loader answers Getstatus).
8. Whether the loader rejects an OTA_DATA chunk larger than 5120 bytes or tolerates smaller fixed sizes (useful for slow links).
9. Real layout.bin header fields other than the count at byte 5, and a real pat_att value for each security format.

### 10. Live results (2026-10-23, AIS01 with the AUC converter)

- 921600 baud for the application and the 2nd loader. Lower rates were never needed.
- A Getstatus reply from the 2nd loader is `C0 5A 01 0B 00 00 00 | C0 50 05 00 04 00 00 01 00 4E 96`: a 7-byte header whose u32 at
  offset 3 is the payload length (11), then `C0 50 05 00 04`, the value (u32 LE, here 0x00010000 = OTA_LOADER_IDLE, no error) and the
  CRC over the 9 bytes before it. The parser above reads it unchanged.
- The loader stays at OTA_LOADER_IDLE after every OTA_END with the shipped waits; no unsolicited bytes, no busy status was seen.
- With the camera already in the 2nd loader, `upgradeAll` written here wrote the full 2023-05 firmware (9 parts, 663 700 bytes) from a Mac
  in 28 s and rebooted it into the application.
- Intoupg is the fragile step. The bytes reach the camera's RX pin intact (checked with a sniffer), yet the application often ignores them.
  It entered the loader from ota.exe on Windows and from the phone, each time shortly after the camera powered up; after it had been
  running and receiving other commands, no number of Intoupgs moved it. So the screen asks for a fresh power-up, sends Intoupg before
  any other command, and retries. From macOS (Apple's FTDI driver) the application never entered the loader; the cause was not found.
- The FT4222 GPIO test items of ota.exe (9 and 10) do not reset the camera, so the app cannot power-cycle it.
