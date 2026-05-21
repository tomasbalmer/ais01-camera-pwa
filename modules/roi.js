import { CMDS, ROI, CAL_W, CAL_H } from './constants.js';
import { log } from './ui.js';
import { sendRawBytes, sendCommand } from './protocol.js';

// Clamp coordinate to calibration space (0..CAL_W / 0..CAL_H)
function clampCoord(v, max) { return Math.max(0, Math.min(max, v)); }

// ============================================================================
// ROI Payload Builder — 80 bytes, Little Endian
// ============================================================================
// Validated against manufacturer tool (HMX_FT4222H_GUI) Read ROI output.
//
//   Offset  Size  Field                       Editable?  What we do
//   ------  ----  --------------------------  ---------  -------------------------
//    0-31   32B   Digit points (8 × u16LE)    YES        Write from calibration rect
//   32-33    2B   Number of digits             YES        Write from user selection
//   34-35    2B   Number of dials              NO         Don't touch (0)
//   36-37    2B   Enable Inference 3 times     YES        Fixed 0 (not needed yet)
//   38-39    2B   Reserved                     NO         Don't touch (0)
//   40-71   32B   Dial refs (4×4 u16LE)        NO         Hardcoded original values
//   72-73    2B   Boundary width               NO         Hardcoded original (70)
//   74-75    2B   Boundary height              NO         Hardcoded original (70)
//   76-79    4B   Reserved                     NO         Don't touch (0)
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

    // --- Byte 34-35: numDials — non-editable, stays 0 ---
    // --- Byte 36-37: Enable Inference 3 times — editable, 0 for now (not needed) ---
    // --- Byte 38-39: reserved — stays 0 ---

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

    // --- Bytes 72-75: boundary — not editable, preserve original values ---
    view.setUint16(ROI.BOUNDARY_X_OFFSET, 70, true);
    view.setUint16(ROI.BOUNDARY_Y_OFFSET, 70, true);

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
