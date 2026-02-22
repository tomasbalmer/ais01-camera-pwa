// ============================================================================
// Camera Protocol Constants
// ============================================================================
// Single source of truth for all magic bytes, offsets, and thresholds used
// in the Himax HM0360 / AIS01-LB communication protocol.
//
// Canonical spec: ais01-lorawan-endnode-v2/specs/2026/02/main/
//                 001-camera-protocol-standardization.md
//
// Sections:
//   1. FTDI D2XX — USB chip init (VID/PID, SIO requests, baud, modem ctrl)
//   2. C0 5A Protocol — All 7-byte sensor commands (CMDS object)
//   3. ROI Payload — 80-byte calibration structure layout + 2-frame sequence
//   4. AI Result — Frame header marker and field offsets
//   5. JPEG — SOI/EOI markers
//   6. FTDI Transport — Packet framing (header strip, transfer size)
//   7. Streaming — Buffer limits, FPS interval
//   8. Validation — Image analysis thresholds
// ============================================================================

// === FTDI FT230X constants (matching D2XX driver) === (Spec Section 1)
export const FTDI_VID = 0x0403;
export const FTDI_PID = 0x6015;
export const FTDI_BAUD = 921600;
export const SIO_RESET = 0x00;
export const SIO_SET_MODEM_CTRL = 0x01;
export const SIO_SET_FLOW_CTRL = 0x02;
export const SIO_SET_BAUD_RATE = 0x03;
export const SIO_SET_DATA = 0x04;
export const SIO_SET_LATENCY_TIMER = 0x09;

// === Sensor resolution (JPEG stream is 640x480) ===
export const SENSOR_W = 640;
export const SENSOR_H = 480;

// === Calibration coordinate space (ROI engine expects 320x240, bottom-left origin) ===
export const CAL_W = 320;
export const CAL_H = 240;

// Always 8 ROI points = 4 reference positions x 2 corners (top-left + bottom-left).
// The 4 references are evenly spaced from center of first digit to center of last digit.
// The firmware interpolates all digit locations from these 4 references + boundary.

// === C0 5A Protocol (Spec Section 2) ===
export const FRAME_SYNC = [0xC0, 0x5A];

// Command groups
export const CMD_GROUP_IMAGE    = 0x00;
export const CMD_GROUP_SYSTEM   = 0x03;
export const CMD_GROUP_REGISTER = 0x04;

// Group 0x04 — Register access (dynamic: addr/val are parameters)
export const CMD_ID_REG_READ   = 0x09;  // C0 5A 04 09 00 <addr> 00
export const CMD_ID_REG_WRITE  = 0x0A;  // C0 5A 04 0A 00 <addr> <val> — TODO: implement writeRegister()

// === Himax / AIS01-LB sensor commands (C0 5A protocol) === (Spec Section 2)
// All 7-byte commands: [C0 5A] [Group] [CmdID] [Param1] [Param2] [Trailer]
export const CMDS = {
    // Group 0x03 — System / Control
    START:           [0xC0, 0x5A, 0x03, 0x04, 0x00, 0x00, 0x00],  // Init session (mandatory first)
    SET_MODE:        [0xC0, 0x5A, 0x03, 0x05, 0x00, 0x00, 0x50],  // Select calibration mode (0x50 = 80B payload)
    // Group 0x00 — Image / Output
    SEND:            [0xC0, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x01],  // General operation trigger
    ENABLE_RAW:      [0xC0, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x02],  // Enable RAW + JPEG
    DISABLE_RAW:     [0xC0, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x03],  // JPEG only
    SHOW_FULL_IMAGE: [0xC0, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x04],  // Full 640x480
    SHOW_ROI:        [0xC0, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x05],  // ROI 160x64
};

// === JPEG markers ===
export const JPEG_SOI = [0xFF, 0xD8];
export const JPEG_EOI = [0xFF, 0xD9];

// === AI Result (Spec Section 4) ===
export const AI_HEADER = [0xC0, 0x5A, 0x63, 0xA4];
export const AI_HEADER_RESERVED_BYTES = 3;    // 3 zero bytes after header
export const AI_RESULT_OFFSET = 7;            // offset from header start to integer
export const AI_RESULT_DATA_SIZE = 8;         // integer(4) + decimal(4)
export const AI_DECIMAL_SCALE = 1_000_000;    // decimal_part x 1e-6

// === ROI Payload Layout (Spec Section 3, 80 bytes LE) ===
// 2-frame sequence: CMDS.SET_MODE → wait SETUP_DELAY_MS → DATA_HDR + 80B payload
export const ROI = {
    DATA_HDR:           [0xC0, 0x5A, 0x03, 0x03],  // ROI data frame header (4 bytes)
    SETUP_DELAY_MS:     1000,                       // Wait between SET_MODE and DATA
    PAYLOAD_SIZE:       80,
    NUM_POINTS:         8,       // 4 refs x 2 corners
    POINTS_OFFSET:      0,       // 8 x {u16 x, u16 y} = 32 bytes
    POINTS_SIZE:        32,
    NUM_DIGITS_OFFSET:  32,
    NUM_DIALS_OFFSET:   34,
    NUM_DIALS_DEFAULT:  0,       // Always 0 in Windows UART captures
    RESERVED_OFFSET:    36,      // 8 bytes reserved/flags (always zeros)
    RESERVED_SIZE:      8,
    DIAL_REFS_OFFSET:   44,      // 32 bytes dial references (8 points x 4 bytes)
    DIAL_REFS_SIZE:     32,
    BOUNDARY_X_OFFSET:  76,      // Validated from Windows UART capture
    BOUNDARY_Y_OFFSET:  78,
};

// === FTDI Transport (Spec Section 6) ===
export const FTDI_HEADER_SIZE = 2;
export const FTDI_DEFAULT_PACKET_SIZE = 64;
export const USB_TRANSFER_SIZE = 4096;

// === FTDI D2XX (Spec Section 1) ===
export const FTDI_BASE_CLOCK = 3_000_000;
export const FTDI_FRAC_CODES = [0, 3, 2, 4, 1, 5, 6, 7];
export const FTDI_FRAC_SHIFT = 14;
export const FTDI_DATA_8N1   = 0x0008;
export const FTDI_LATENCY_MS = 1;
export const FTDI_DTR_ON     = 0x0101;
export const FTDI_RTS_ON     = 0x0202;
export const FTDI_PURGE_RX   = 1;
export const FTDI_PURGE_TX   = 2;

// === Streaming ===
export const FRAME_BUFFER_MAX = 4096;
export const FPS_INTERVAL_MS = 1000;
export const AI_LOG_FRAME_LIMIT = 5;

// === Validation thresholds ===
export const VALIDATION = {
    SATURATION_THRESHOLD: 240,
    CENTER_MIN: 0.2,
    CENTER_MAX: 0.8,
    BRIGHTNESS_MIN: 40,
    BRIGHTNESS_MAX: 180,
    FLASH_MAX_PCT: 10,
    CONTRAST_MIN: 20,
    EDGE_STRENGTH_MIN: 3,
    OVERLAY_DURATION_MS: 4000,
};
