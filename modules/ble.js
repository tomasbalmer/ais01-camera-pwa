/*
 * BLE Installation Mode — Web Bluetooth connection to BT24 module
 *
 * Connects to the AIS01-CB device via BLE (BT24 transparent UART bridge),
 * sends AT+INSTALL command, and receives JPEG frames for camera positioning.
 *
 * The BT24 exposes a Nordic UART Service (NUS) or similar transparent UART:
 *   Service:  FFE0 (or 6E400001-...)
 *   TX char:  FFE1 (notify — device → phone)
 *   RX char:  FFE1 (write  — phone → device)
 */

import { state } from './state.js';
import { dom, log } from './ui.js';
import { findMarker } from './helpers.js';
import { JPEG_SOI, JPEG_EOI } from './constants.js';

/* BT24 typically uses FFE0/FFE1 for transparent UART */
const BLE_SERVICE_UUID = 0xFFE0;
const BLE_CHAR_UUID = 0xFFE1;

/* Fallback: Nordic UART Service */
const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; /* notify */
const NUS_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; /* write */

let bleDevice = null;
let bleRxChar = null; /* write to device */
let bleTxChar = null; /* notify from device */
let accumulator = [];
let frameCount = 0;
let fpsCount = 0;
let lastFpsTime = 0;

/* ── Connect via Web Bluetooth ── */
export async function connectBLE() {
    /* Reuse existing connection if still active */
    if (bleDevice && bleDevice.gatt.connected) {
        log('BLE already connected');
        return true;
    }
    log('Scanning for BLE devices...');

    try {
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [
                { namePrefix: '8691' },   /* Match IMEI-based names */
                { namePrefix: 'BT24' },   /* Match default BT24 name */
                { namePrefix: 'Dragino' },
                { namePrefix: 'AIS01' },  /* Match AIS01-LB-LoRawan etc. */
                { services: [BLE_SERVICE_UUID] },
            ],
            optionalServices: [BLE_SERVICE_UUID, NUS_SERVICE_UUID],
        });

        log(`Found: ${bleDevice.name || 'Unknown'}`);
        const server = await bleDevice.gatt.connect();
        log('GATT connected');

        /* Try FFE0 first (BT24), then NUS */
        let service, rxChar, txChar;
        try {
            service = await server.getPrimaryService(BLE_SERVICE_UUID);
            const char = await service.getCharacteristic(BLE_CHAR_UUID);
            rxChar = char; /* BT24: same characteristic for read/write */
            txChar = char;
            log('BT24 service (FFE0/FFE1)');
        } catch (e) {
            service = await server.getPrimaryService(NUS_SERVICE_UUID);
            rxChar = await service.getCharacteristic(NUS_RX_CHAR_UUID);
            txChar = await service.getCharacteristic(NUS_TX_CHAR_UUID);
            log('Nordic UART service');
        }

        bleRxChar = rxChar;
        bleTxChar = txChar;

        /* Subscribe to notifications */
        await bleTxChar.startNotifications();
        bleTxChar.addEventListener('characteristicvaluechanged', onBleData);

        log('BLE ready — notifications active');
        return true;

    } catch (err) {
        log('BLE error: ' + err.message);
        return false;
    }
}

/* ── Send string command via BLE ── */
async function bleSend(cmd) {
    if (!bleRxChar) return;
    const encoder = new TextEncoder();
    const data = encoder.encode(cmd + '\r\n');

    /* BLE has 20-byte MTU limit — send in chunks */
    for (let i = 0; i < data.length; i += 20) {
        const chunk = data.slice(i, i + 20);
        await bleRxChar.writeValueWithoutResponse(chunk);
    }
    log('Sent: ' + cmd);
}

/* ── Handle incoming BLE data (notifications) ── */
let totalBleBytes = 0;
let notifyCount = 0;

function onBleData(event) {
    const value = new Uint8Array(event.target.value.buffer);
    totalBleBytes += value.length;
    notifyCount++;
    for (let i = 0; i < value.length; i++) {
        accumulator.push(value[i]);
    }

    /* Log every 50 notifications to show data is flowing */
    if (notifyCount % 50 === 0) {
        log(`BLE: ${notifyCount} notifs, ${totalBleBytes}B, buf=${accumulator.length}`);
    }

    extractAndDisplayFrames();
}

/* ── JPEG frame extraction (reuses same logic as stream.js) ── */
function extractAndDisplayFrames() {
    while (true) {
        const soi = findMarker(accumulator, 0, JPEG_SOI);
        if (soi === -1) {
            /* Keep buffer bounded */
            if (accumulator.length > 8192) accumulator.splice(0, accumulator.length - 8192);
            return;
        }

        /* Discard bytes before SOI */
        if (soi > 0) accumulator.splice(0, soi);

        /* Find EOI after SOI */
        const eoi = findMarker(accumulator, 2, JPEG_EOI);
        if (eoi === -1) return;

        /* Extract complete JPEG frame */
        const jpeg = new Uint8Array(accumulator.slice(0, eoi + 2));
        accumulator.splice(0, eoi + 2);

        displayFrame(jpeg);
    }
}

/* ── Display JPEG frame ── */
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

    if (frameCount === 1) {
        log(`First BLE frame: ${jpegBytes.length} bytes`);
    }

    /* Update stats */
    const now = performance.now();
    if (now - lastFpsTime >= 1000) {
        const fps = fpsCount / ((now - lastFpsTime) / 1000);
        fpsCount = 0;
        lastFpsTime = now;
        dom.stats.textContent = `BLE #${frameCount} | ${fps.toFixed(2)} fps | ${jpegBytes.length}B`;
    }
}

/* ── Start installation mode ── */
export async function startInstallMode() {
    accumulator = [];
    frameCount = 0;
    fpsCount = 0;
    lastFpsTime = performance.now();

    /* Show camera view */
    dom.connectScreen.style.display = 'none';
    dom.cam.style.display = 'block';
    dom.stats.className = 'active';
    dom.statusDot.classList.add('connected');
    dom.stats.textContent = 'BLE Installation Mode — waiting for frames...';

    /* Send AT+INSTALL to enter installation mode */
    await bleSend('AT+INSTALL');

    state.running = true;
    state.bleMode = true;
}

/* ── Stop installation mode ── */
export async function stopInstallMode() {
    if (bleRxChar) {
        try { await bleSend('AT+STOP'); } catch (e) {}
    }

    state.running = false;
    state.bleMode = false;

    dom.cam.style.display = 'none';
    dom.connectScreen.style.display = 'flex';
    dom.stats.className = '';
    dom.stats.textContent = 'Disconnected';
    dom.statusDot.classList.remove('connected');

    if (bleTxChar) {
        try {
            bleTxChar.removeEventListener('characteristicvaluechanged', onBleData);
            await bleTxChar.stopNotifications();
        } catch (e) {}
    }

    if (bleDevice && bleDevice.gatt.connected) {
        bleDevice.gatt.disconnect();
    }

    bleDevice = null;
    bleRxChar = null;
    bleTxChar = null;
    accumulator = [];
    frameCount = 0;

    log('BLE disconnected');
}

/* ── Start calibration mode ── */
let calibRetryInterval = null;

export async function startCalibMode() {
    accumulator = [];
    frameCount = 0;
    fpsCount = 0;
    lastFpsTime = performance.now();

    /* Show camera view */
    dom.connectScreen.style.display = 'none';
    dom.cam.style.display = 'block';
    dom.stats.className = 'active';
    dom.statusDot.classList.add('connected');
    dom.stats.textContent = 'BLE Calibration — reset device now, waiting...';

    state.running = true;
    state.bleMode = true;
    state.bleCalibMode = true;

    /* Send AT+CALIB every 2s until frames arrive.
     * The device only processes AT commands when awake (5s boot window
     * or brief RTC wakes). Retrying ensures the command lands. */
    log('Starting AT+CALIB retry loop (every 2s)...');
    let retryCount = 0;

    const sendCalib = async () => {
        retryCount++;
        log(`AT+CALIB attempt #${retryCount} (frames=${frameCount}, bleRx=${!!bleRxChar})`);
        if (frameCount > 0) {
            log('Frames detected! Stopping retry.');
            clearInterval(calibRetryInterval);
            calibRetryInterval = null;
            return;
        }
        if (!bleRxChar) {
            log('WARNING: bleRxChar is null — BLE not ready');
            return;
        }
        try {
            await bleSend('AT+CALIB');
        } catch (e) {
            log('AT+CALIB send error: ' + e.message);
        }
    };

    await sendCalib();
    calibRetryInterval = setInterval(sendCalib, 2000);
}

/* ── Send AT command over BLE (for calibration sub-commands) ── */
export async function bleSendATCommand(cmd) {
    await bleSend(cmd);
}

/* ── Send camera command name over BLE ── */
export async function bleSendCameraCommand(name) {
    const cmdMap = {
        'SHOW_FULL_IMAGE': 'AT+FULLIMG',
        'SHOW_ROI': 'AT+ROIIMG',
        'START': 'AT+CALIB',
    };
    const atCmd = cmdMap[name];
    if (atCmd) {
        await bleSend(atCmd);
    } else {
        log('BLE: unsupported camera command: ' + name);
    }
}

/* ── Send ROI calibration payload over BLE ── */
export async function bleSendRoiPayload(payloadBytes) {
    /* Convert 80 bytes to hex string */
    const hex = Array.from(payloadBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    await bleSend('AT+SETROI=' + hex);
}

/* ── Stop calibration mode ── */
export async function stopCalibMode() {
    if (calibRetryInterval) {
        clearInterval(calibRetryInterval);
        calibRetryInterval = null;
    }

    if (bleRxChar) {
        try { await bleSend('AT+STOP'); } catch (e) {}
    }

    state.running = false;
    state.bleMode = false;
    state.bleCalibMode = false;

    dom.cam.style.display = 'none';
    dom.connectScreen.style.display = 'flex';
    dom.stats.className = '';
    dom.stats.textContent = 'Disconnected';
    dom.statusDot.classList.remove('connected');

    if (bleTxChar) {
        try {
            bleTxChar.removeEventListener('characteristicvaluechanged', onBleData);
            await bleTxChar.stopNotifications();
        } catch (e) {}
    }

    if (bleDevice && bleDevice.gatt.connected) {
        bleDevice.gatt.disconnect();
    }

    bleDevice = null;
    bleRxChar = null;
    bleTxChar = null;
    accumulator = [];
    frameCount = 0;

    log('BLE calibration disconnected');
}

/* ── Check if in BLE calibration mode ── */
export function isBleCalibMode() {
    return state.bleCalibMode && bleRxChar != null;
}

/* ── Check Web Bluetooth availability ── */
export function hasBluetooth() {
    return !!navigator.bluetooth;
}
