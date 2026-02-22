import { CMDS, FRAME_SYNC, CMD_GROUP_REGISTER, CMD_ID_REG_READ } from './constants.js';
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

    if (name === 'SHOW_FULL_IMAGE') {
        document.getElementById('btnFullImg').classList.add('active');
        document.getElementById('btnROI').classList.remove('active');
    } else if (name === 'SHOW_ROI') {
        document.getElementById('btnROI').classList.add('active');
        document.getElementById('btnFullImg').classList.remove('active');
    }
}

// === Register Read (Spec Section 2, Group 0x04) ===
export async function readRegister(addr) {
    const cmd = [...FRAME_SYNC, CMD_GROUP_REGISTER, CMD_ID_REG_READ, 0x00, addr & 0xFF, 0x00];
    log(`READ REG 0x${addr.toString(16).padStart(2, '0')}`);
    await sendRawBytes(cmd);
}

export function onReadRegister() {
    const addrStr = document.getElementById('regAddr').value.trim();
    const addr = addrStr.startsWith('0x') ? parseInt(addrStr, 16) : parseInt(addrStr, 10);
    if (isNaN(addr) || addr < 0 || addr > 0xFF) { log('Invalid address'); return; }
    readRegister(addr);
}

export async function toggleRAW() {
    state.rawEnabled = !state.rawEnabled;
    await sendCommand(state.rawEnabled ? 'ENABLE_RAW' : 'DISABLE_RAW');
    const btn = document.getElementById('btnRAW');
    btn.classList.toggle('active', state.rawEnabled);
}
