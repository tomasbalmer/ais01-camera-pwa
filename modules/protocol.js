import { CMDS, FRAME_SYNC, CMD_GROUP_REGISTER, CMD_ID_REG_READ, CMD_ID_REG_WRITE, SENSOR_CTRL } from './constants.js';
import { state } from './state.js';
import { log } from './ui.js';

// === Send raw bytes to sensor via FTDI UART TX ===
export async function sendRawBytes(bytes) {
    if (!state.device || !state.epOutNum) { log('Not connected'); return; }
    const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    log(`TX → ${hex}`);
    try {
        const result = await state.device.transferOut(state.epOutNum, new Uint8Array(bytes));
        log(`TX OK: ${result.bytesWritten} bytes`);
    } catch (err) {
        log(`TX ERROR: ${err.message}`);
    }
}

// === Send named command to sensor ===
export async function sendCommand(name) {
    const cmd = CMDS[name];
    if (!cmd) { log(`Unknown command: ${name}`); return; }
    log(`CMD: ${name}`);
    await sendRawBytes(cmd);
}

// === Sensor state — tracks current values for friendly controls ===
const sensorState = {};
for (const [key, def] of Object.entries(SENSOR_CTRL)) {
    sensorState[key] = def.default;
}

// === Register Read (Spec Section 2, Group 0x04) — 16-bit addressing ===
export async function readRegister(addr) {
    const cmd = [...FRAME_SYNC, CMD_GROUP_REGISTER, CMD_ID_REG_READ,
        (addr >> 8) & 0xFF, addr & 0xFF, 0x00];
    log(`READ REG 0x${addr.toString(16).padStart(4, '0')}`);
    await sendRawBytes(cmd);
}

// === Register Write (Spec Section 2, Group 0x04) — 16-bit addressing ===
export async function writeRegister(addr, value) {
    const cmd = [...FRAME_SYNC, CMD_GROUP_REGISTER, CMD_ID_REG_WRITE,
        (addr >> 8) & 0xFF, addr & 0xFF, value & 0xFF];
    log(`WRITE REG 0x${addr.toString(16).padStart(4, '0')} = 0x${(value & 0xFF).toString(16).padStart(2, '0')}`);
    await sendRawBytes(cmd);
}

// === Adjust sensor parameter by delta (called from +/- buttons) ===
export async function adjustSensor(param, delta) {
    const def = SENSOR_CTRL[param];
    if (!def) { log(`Unknown sensor param: ${param}`); return; }
    const clamped = Math.max(def.min, Math.min(def.max, sensorState[param] + delta));
    sensorState[param] = clamped;
    const el = document.getElementById(`ctrl-val-${param}`);
    if (el) el.textContent = clamped;
    await writeRegister(def.addr, clamped);
}

// === Advanced: read register from hex input ===
export function onAdvancedReadRegister() {
    const addrStr = document.getElementById('advRegAddr').value.trim();
    const addr = addrStr.startsWith('0x') ? parseInt(addrStr, 16) : parseInt(addrStr, 10);
    if (isNaN(addr) || addr < 0 || addr > 0xFFFF) { log('Invalid address (0x0000–0xFFFF)'); return; }
    readRegister(addr);
}

// === Advanced: write register from hex inputs ===
export function onWriteRegister() {
    const addrStr = document.getElementById('advRegAddr').value.trim();
    const valStr = document.getElementById('advRegVal').value.trim();
    const addr = addrStr.startsWith('0x') ? parseInt(addrStr, 16) : parseInt(addrStr, 10);
    const val = valStr.startsWith('0x') ? parseInt(valStr, 16) : parseInt(valStr, 10);
    if (isNaN(addr) || addr < 0 || addr > 0xFFFF) { log('Invalid address (0x0000–0xFFFF)'); return; }
    if (isNaN(val) || val < 0 || val > 0xFF) { log('Invalid value (0x00–0xFF)'); return; }
    writeRegister(addr, val);
}

export async function toggleRAW() {
    state.rawEnabled = !state.rawEnabled;
    await sendCommand(state.rawEnabled ? 'ENABLE_RAW' : 'DISABLE_RAW');
    const btn = document.getElementById('btnRAW');
    btn.classList.toggle('active', state.rawEnabled);
}
