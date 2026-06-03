/*
 * BLE Module — Web Bluetooth connection to BT24 for calibration + install
 *
 * BT24 transparent UART bridge:
 *   Service:  FFE0
 *   Notify:   FFE1 (device → phone)
 *   Write:    FFE2 (phone → device), fallback FFE1
 */

import { state } from './state.js';
import { dom, log } from './ui.js';
import { findMarker } from './helpers.js';
import { JPEG_SOI, JPEG_EOI } from './constants.js';

const BLE_SERVICE_UUID = 0xFFE0;
const BLE_NOTIFY_UUID = 0xFFE1;
const BLE_WRITE_UUID = 0xFFE2;

const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

let bleDevice = null;
let bleWriteChar = null;
let bleNotifyChar = null;
let accumulator = [];
let frameCount = 0;
let fpsCount = 0;
let lastFpsTime = 0;
let calibRetryInterval = null;

/* ── Connect ── */
export async function connectBLE() {
    if (bleDevice && bleDevice.gatt.connected) {
        log('BLE already connected');
        return true;
    }

    log('[v2] Scanning for BLE devices...');

    try {
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [
                { namePrefix: '8691' },
                { namePrefix: 'BT24' },
                { namePrefix: 'Dragino' },
                { namePrefix: 'AIS01' },
                { services: [BLE_SERVICE_UUID] },
            ],
            optionalServices: [BLE_SERVICE_UUID, NUS_SERVICE_UUID],
        });

        log(`Found: ${bleDevice.name || 'Unknown'}`);
        const server = await bleDevice.gatt.connect();
        log('GATT connected');

        let service;
        try {
            service = await server.getPrimaryService(BLE_SERVICE_UUID);
            log('Got BT24 service (FFE0)');
        } catch (e) {
            service = await server.getPrimaryService(NUS_SERVICE_UUID);
            log('Got Nordic UART service');
            bleWriteChar = await service.getCharacteristic(NUS_RX_CHAR_UUID);
            bleNotifyChar = await service.getCharacteristic(NUS_TX_CHAR_UUID);
            await bleNotifyChar.startNotifications();
            bleNotifyChar.addEventListener('characteristicvaluechanged', onBleData);
            log('NUS ready');
            return true;
        }

        /* Get all characteristics and log them */
        const chars = await service.getCharacteristics();
        log(`Service has ${chars.length} characteristic(s)`);
        for (const c of chars) {
            const uuid = c.uuid;
            const p = c.properties;
            const flags = [];
            if (p.read) flags.push('read');
            if (p.write) flags.push('write');
            if (p.writeWithoutResponse) flags.push('writeNoResp');
            if (p.notify) flags.push('notify');
            log(`  ${uuid}: ${flags.join(', ')}`);
        }

        /* Find notify characteristic (FFE1) */
        bleNotifyChar = null;
        for (const c of chars) {
            if (c.properties.notify) {
                bleNotifyChar = c;
                break;
            }
        }
        if (!bleNotifyChar) {
            log('ERROR: no notify characteristic found');
            return false;
        }

        /* Find write characteristic — prefer one that's NOT the notify char */
        bleWriteChar = null;
        for (const c of chars) {
            if ((c.properties.write || c.properties.writeWithoutResponse) && c !== bleNotifyChar) {
                bleWriteChar = c;
                break;
            }
        }
        /* Fallback: use notify char for write too */
        if (!bleWriteChar) {
            if (bleNotifyChar.properties.write || bleNotifyChar.properties.writeWithoutResponse) {
                bleWriteChar = bleNotifyChar;
                log('Using same char for notify + write');
            } else {
                log('ERROR: no writable characteristic found');
                return false;
            }
        }

        log(`Notify: ${bleNotifyChar.uuid}`);
        log(`Write:  ${bleWriteChar.uuid}`);

        await bleNotifyChar.startNotifications();
        bleNotifyChar.addEventListener('characteristicvaluechanged', onBleData);

        /* Give BLE stack time to stabilize before first write */
        await new Promise(r => setTimeout(r, 500));

        log('BLE ready');
        return true;

    } catch (err) {
        log('BLE error: ' + err.message);
        return false;
    }
}

/* ── Send ── */
async function bleSend(cmd) {
    if (!bleWriteChar) {
        log('bleSend: no write char');
        return;
    }

    /* Check GATT is still connected */
    if (!bleDevice || !bleDevice.gatt.connected) {
        log('bleSend: GATT disconnected');
        return;
    }

    const data = new TextEncoder().encode(cmd + '\r\n');

    for (let i = 0; i < data.length; i += 20) {
        const chunk = data.slice(i, i + 20);
        /* Try writeValueWithResponse first (more compatible), fallback to without */
        try {
            if (bleWriteChar.properties.write) {
                await bleWriteChar.writeValueWithResponse(chunk);
            } else {
                await bleWriteChar.writeValueWithoutResponse(chunk);
            }
        } catch (e) {
            log(`bleSend chunk error: ${e.message}`);
            /* Try the other method */
            try {
                if (bleWriteChar.properties.writeWithoutResponse) {
                    await bleWriteChar.writeValueWithoutResponse(chunk);
                } else {
                    await bleWriteChar.writeValueWithResponse(chunk);
                }
            } catch (e2) {
                log(`bleSend fallback error: ${e2.message}`);
                return;
            }
        }
    }
    log('Sent: ' + cmd);
}

/* ── Notifications ── */
let totalBleBytes = 0;
let notifyCount = 0;

function onBleData(event) {
    const value = new Uint8Array(event.target.value.buffer);
    totalBleBytes += value.length;
    notifyCount++;
    for (let i = 0; i < value.length; i++) {
        accumulator.push(value[i]);
    }
    if (notifyCount % 50 === 0) {
        log(`BLE: ${notifyCount} notifs, ${totalBleBytes}B, buf=${accumulator.length}`);
    }
    extractAndDisplayFrames();
}

/* ── JPEG extraction ── */
function extractAndDisplayFrames() {
    while (true) {
        const soi = findMarker(accumulator, 0, JPEG_SOI);
        if (soi === -1) {
            if (accumulator.length > 8192) accumulator.splice(0, accumulator.length - 8192);
            return;
        }
        if (soi > 0) accumulator.splice(0, soi);
        const eoi = findMarker(accumulator, 2, JPEG_EOI);
        if (eoi === -1) return;
        const jpeg = new Uint8Array(accumulator.slice(0, eoi + 2));
        accumulator.splice(0, eoi + 2);
        displayFrame(jpeg);
    }
}

function displayFrame(jpegBytes) {
    const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const prev = dom.cam.src;
    dom.cam.onload = () => {
        if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
    };
    dom.cam.src = url;
    frameCount++;
    fpsCount++;
    if (frameCount === 1) log(`First BLE frame: ${jpegBytes.length} bytes`);
    const now = performance.now();
    if (now - lastFpsTime >= 1000) {
        const fps = fpsCount / ((now - lastFpsTime) / 1000);
        fpsCount = 0;
        lastFpsTime = now;
        dom.stats.textContent = `BLE #${frameCount} | ${fps.toFixed(2)} fps | ${jpegBytes.length}B`;
    }
}

/* ── Install Mode ── */
export async function startInstallMode() {
    accumulator = [];
    frameCount = 0;
    fpsCount = 0;
    lastFpsTime = performance.now();
    dom.connectScreen.style.display = 'none';
    dom.cam.style.display = 'block';
    dom.stats.className = 'active';
    dom.statusDot.classList.add('connected');
    dom.stats.textContent = 'BLE Installation Mode — waiting for frames...';
    await bleSend('AT+INSTALL');
    state.running = true;
    state.bleMode = true;
}

export async function stopInstallMode() {
    try { await bleSend('AT+STOP'); } catch (e) {}
    disconnectBLE();
    state.running = false;
    state.bleMode = false;
    log('BLE install disconnected');
}

/* ── Calibration Mode ── */
export async function startCalibMode() {
    accumulator = [];
    frameCount = 0;
    fpsCount = 0;
    lastFpsTime = performance.now();
    dom.connectScreen.style.display = 'none';
    dom.cam.style.display = 'block';
    dom.stats.className = 'active';
    dom.statusDot.classList.add('connected');
    dom.stats.textContent = 'BLE Calibration — reset device now, waiting...';
    state.running = true;
    state.bleMode = true;
    state.bleCalibMode = true;

    log('Starting AT+CALIB retry (every 2s)...');
    let retryCount = 0;

    const sendCalib = async () => {
        retryCount++;
        if (frameCount > 0) {
            log('Frames detected! Stopping retry.');
            clearInterval(calibRetryInterval);
            calibRetryInterval = null;
            return;
        }
        log(`AT+CALIB #${retryCount}`);
        try {
            await bleSend('AT+CALIB');
        } catch (e) {
            log('Send error: ' + e.message);
        }
    };

    await sendCalib();
    calibRetryInterval = setInterval(sendCalib, 2000);
}

export async function stopCalibMode() {
    if (calibRetryInterval) {
        clearInterval(calibRetryInterval);
        calibRetryInterval = null;
    }
    try { await bleSend('AT+STOP'); } catch (e) {}
    disconnectBLE();
    state.running = false;
    state.bleMode = false;
    state.bleCalibMode = false;
    log('BLE calibration disconnected');
}

/* ── Shared BLE commands ── */
export async function bleSendATCommand(cmd) {
    await bleSend(cmd);
}

export async function bleSendCameraCommand(name) {
    const cmdMap = {
        'SHOW_FULL_IMAGE': 'AT+FULLIMG',
        'SHOW_ROI': 'AT+ROIIMG',
        'START': 'AT+CALIB',
    };
    const atCmd = cmdMap[name];
    if (atCmd) await bleSend(atCmd);
    else log('BLE: unsupported command: ' + name);
}

export async function bleSendRoiPayload(payloadBytes) {
    const hex = Array.from(payloadBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    await bleSend('AT+SETROI=' + hex);
}

export function isBleCalibMode() {
    return state.bleCalibMode && bleWriteChar != null;
}

export function hasBluetooth() {
    return !!navigator.bluetooth;
}

/* ── Disconnect helper ── */
function disconnectBLE() {
    if (bleNotifyChar) {
        try {
            bleNotifyChar.removeEventListener('characteristicvaluechanged', onBleData);
            bleNotifyChar.stopNotifications();
        } catch (e) {}
    }
    if (bleDevice && bleDevice.gatt.connected) {
        bleDevice.gatt.disconnect();
    }
    bleDevice = null;
    bleWriteChar = null;
    bleNotifyChar = null;
    accumulator = [];
    frameCount = 0;
    dom.cam.style.display = 'none';
    dom.connectScreen.style.display = 'flex';
    dom.stats.className = '';
    dom.stats.textContent = 'Disconnected';
    dom.statusDot.classList.remove('connected');
}
