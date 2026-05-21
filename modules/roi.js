import { CMDS, ROI, CAL_W, CAL_H } from './constants.js';
import { log } from './ui.js';
import { sendRawBytes, sendCommand } from './protocol.js';

// Clamp coordinate to calibration space (0..CAL_W / 0..CAL_H)
function clampCoord(v, max) { return Math.max(0, Math.min(max, v)); }

// ============================================================================
// ROI Payload Builder — 80 bytes, Little Endian
// ============================================================================
// Byte map (validated against Windows software UART capture):
//
//   Offset  Size  Field              Source
//   ------  ----  -----------------  ------------------------------------------
//    0-31   32B   ROI Points         8 × u16LE {x, y} — 4 refs × 2 corners
//   32-33    2B   numDigits          u16LE — number of integer digits (4-8)
//   34-35    2B   numDials           u16LE — always 0 in Windows captures
//   36-43    8B   Reserved           zeros (flags / padding)
//   44-75   32B   Dial Refs          8 × u16LE {x, y} — dial reference points
//   76-77    2B   boundary_x         u16LE — digit boundary width
//   78-79    2B   boundary_y         u16LE — digit boundary height
//
// Windows reference payload (6 digits, boundary 70×70):
//   [ROI 32B] 06 00 00 00 00 00 00 00 00 00 00 00 [Dial 32B] 46 00 46 00
// ============================================================================
export function buildRoiPayload(config) {
    const payload = new Uint8Array(ROI.PAYLOAD_SIZE);  // 80 bytes, all zeros
    const view = new DataView(payload.buffer);

    // --- Bytes 0-31: ROI Points (8 × u16LE x,y = 32 bytes) ---
    let outOfRange = false;
    for (let i = 0; i < ROI.NUM_POINTS; i++) {
        const pt = config.digits[i] || { x: 0, y: 0 };
        if (pt.x < 0 || pt.x > CAL_W || pt.y < 0 || pt.y > CAL_H) {
            log(`WARNING: P${i+1} (${pt.x},${pt.y}) out of 0-${CAL_W}/0-${CAL_H} range — clamping`);
            outOfRange = true;
        }
        const x = clampCoord(pt.x, CAL_W);
        const y = clampCoord(pt.y, CAL_H);
        view.setUint16(ROI.POINTS_OFFSET + i * 4, x, true);       // offset 0,4,8,...,28
        view.setUint16(ROI.POINTS_OFFSET + i * 4 + 2, y, true);   // offset 2,6,10,...,30
    }
    if (outOfRange) log('WARNING: Coordinates clamped — payload may not match intended ROI');

    // --- Byte 32-33: numDigits (u16LE) ---
    view.setUint16(32, config.numDigits, true);

    // --- Byte 34-35: numDials (u16LE) — 0, no dial calibration ---
    view.setUint16(ROI.NUM_DIALS_OFFSET, 0, true);

    // --- Bytes 36-39: reserved (4 bytes zeros) — already zero from Uint8Array init ---

    // --- Bytes 40-71: dial refs (32 bytes) — fixed digit wheel values ---
    // 4 dials × {org_x, org_y, c_x, c_y} u16LE = 32 bytes
    // These are factory/installation values that must not be zeroed out.
    const DIAL_REFS = [
        124, 206, 123, 221,  // dial 1: org(124,206) center(123,221)
        169, 217, 167, 234,  // dial 2: org(169,217) center(167,234)
        212, 195, 209, 211,  // dial 3: org(212,195) center(209,211)
        227, 150, 227, 164,  // dial 4: org(227,150) center(227,164)
    ];
    for (let i = 0; i < DIAL_REFS.length; i++) {
        view.setUint16(40 + i * 2, DIAL_REFS[i], true);
    }

    // --- Byte 72-73: boundary_x (u16LE) ---
    // --- Byte 74-75: boundary_y (u16LE) ---
    const bx = clampCoord(config.boundaryX, CAL_W);
    const by = clampCoord(config.boundaryY, CAL_H);
    if (bx !== config.boundaryX || by !== config.boundaryY) {
        log(`WARNING: Boundary (${config.boundaryX},${config.boundaryY}) clamped to (${bx},${by})`);
    }
    view.setUint16(ROI.BOUNDARY_X_OFFSET, bx, true);
    view.setUint16(ROI.BOUNDARY_Y_OFFSET, by, true);

    return payload;
}

export async function sendRoiConfig(config) {
    await sendRawBytes(CMDS.SET_MODE);
    await new Promise(r => setTimeout(r, ROI.SETUP_DELAY_MS));
    const payload = buildRoiPayload(config);
    const frame = new Uint8Array(ROI.DATA_HDR.length + payload.length);
    frame.set(ROI.DATA_HDR);
    frame.set(payload, ROI.DATA_HDR.length);

    // Log decoded payload
    const pv = new DataView(payload.buffer);
    log('--- ROI PAYLOAD ---');
    for (let d = 0; d < ROI.NUM_POINTS; d++) {
        const px = pv.getUint16(ROI.POINTS_OFFSET + d * 4, true);
        const py = pv.getUint16(ROI.POINTS_OFFSET + d * 4 + 2, true);
        log('  P' + (d + 1) + ': x=' + px + ' y=' + py);
    }
    log(`  numDigits: ${pv.getUint16(ROI.NUM_DIGITS_OFFSET, true)}`);
    log(`  numDials: ${pv.getUint16(ROI.NUM_DIALS_OFFSET, true)}`);
    log(`  Boundary: ${pv.getUint16(ROI.BOUNDARY_X_OFFSET, true)} x ${pv.getUint16(ROI.BOUNDARY_Y_OFFSET, true)}`);
    const hexRows = [];
    for (let i = 0; i < payload.length; i += 16) {
        const slice = Array.from(payload.slice(i, Math.min(i + 16, payload.length)));
        hexRows.push(`  Hex[${String(i).padStart(2,'0')}-${String(Math.min(i+15, payload.length-1)).padStart(2,'0')}]: ${slice.map(b => b.toString(16).padStart(2,'0')).join(' ')}`);
    }
    hexRows.forEach(r => log(r));
    log('--- END ---');

    await sendRawBytes(Array.from(frame));
    log(`ROI sent: ${config.numDigits} digits, ${ROI.NUM_DIALS_DEFAULT} dials`);

    // Re-initialize sensor session after calibration to prevent camera freeze.
    // Without this, subsequent SHOW_ROI/SHOW_FULL_IMAGE commands hang the sensor.
    log('Re-initializing sensor session...');
    await new Promise(r => setTimeout(r, 200));
    await sendCommand('START');
    await new Promise(r => setTimeout(r, 200));
    await sendCommand('SEND');
    log('Sensor session restored');
}

export function onSendROI() {
    const numDigits = parseInt(document.getElementById('roiNumDigits').value) || 6;
    const digits = [];
    for (let i = 0; i < ROI.NUM_POINTS; i++) {
        const xEl = document.getElementById(`roiX${i}`);
        const yEl = document.getElementById(`roiY${i}`);
        digits.push({
            x: xEl ? parseInt(xEl.value) || 0 : 0,
            y: yEl ? parseInt(yEl.value) || 0 : 0,
        });
    }
    const boundaryX = parseInt(document.getElementById('roiBoundX').value) || 0;
    const boundaryY = parseInt(document.getElementById('roiBoundY').value) || 0;
    sendRoiConfig({ numDigits, digits, boundaryX, boundaryY });
}
