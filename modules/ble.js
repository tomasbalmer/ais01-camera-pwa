/*
 * BLE Module — Web Bluetooth connection to BT24 transparent UART
 *
 * BT24 exposes one characteristic (FFE1) with read/write/writeNoResp/notify.
 * Same char is used for sending commands and receiving JPEG frames.
 */

import { state } from './state.js';
import { dom, log } from './ui.js';
import { findMarker } from './helpers.js';
import { JPEG_SOI, JPEG_EOI } from './constants.js';

const BLE_SERVICE_UUID = 0xFFE0;
const BLE_CHAR_UUID = 0xFFE1;

const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

let bleDevice = null;
let bleChar = null;       /* single FFE1 char for read/write/notify */
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

    log('[v3] Scanning...');

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

        try {
            const service = await server.getPrimaryService(BLE_SERVICE_UUID);
            bleChar = await service.getCharacteristic(BLE_CHAR_UUID);
            const p = bleChar.properties;
            log(`FFE1: write=${p.write} writeNoResp=${p.writeWithoutResponse} notify=${p.notify}`);
        } catch (e) {
            const service = await server.getPrimaryService(NUS_SERVICE_UUID);
            bleChar = await service.getCharacteristic(NUS_RX_CHAR_UUID);
            const txChar = await service.getCharacteristic(NUS_TX_CHAR_UUID);
            await txChar.startNotifications();
            txChar.addEventListener('characteristicvaluechanged', onBleData);
            log('Nordic UART service');
            return true;
        }

        await bleChar.startNotifications();
        bleChar.addEventListener('characteristicvaluechanged', onBleData);
        log('BLE ready');
        return true;

    } catch (err) {
        log('BLE error: ' + err.message);
        return false;
    }
}

/* ── Send ── */
async function bleSend(cmd) {
    if (!bleChar) { log('No BLE char'); return; }
    if (!bleDevice || !bleDevice.gatt.connected) { log('GATT disconnected'); return; }

    const data = new TextEncoder().encode(cmd + '\r\n');

    for (let i = 0; i < data.length; i += 20) {
        const chunk = data.slice(i, i + 20);
        await bleChar.writeValueWithoutResponse(chunk);
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
    dom.stats.textContent = 'BLE Calibration — reset device now...';
    state.running = true;
    state.bleMode = true;
    state.bleCalibMode = true;

    let retryCount = 0;
    const MAX_RETRIES = 10;
    const sendCalib = async () => {
        retryCount++;
        if (frameCount > 0) {
            log('Frames arriving');
            clearInterval(calibRetryInterval);
            calibRetryInterval = null;
            return;
        }
        if (retryCount > MAX_RETRIES) {
            log('Stopped after ' + MAX_RETRIES + ' attempts');
            clearInterval(calibRetryInterval);
            calibRetryInterval = null;
            return;
        }
        log(`AT+INSTALL #${retryCount}/${MAX_RETRIES}`);
        try { await bleSend('AT+INSTALL'); } catch (e) {}
    };

    await sendCalib();
    calibRetryInterval = setInterval(sendCalib, 3000);
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
}

/* ── Calibration sub-commands ── */
export async function bleSendATCommand(cmd) {
    await bleSend(cmd);
}

export async function bleSendCameraCommand(name) {
    const map = { 'SHOW_FULL_IMAGE': 'AT+FULLIMG', 'SHOW_ROI': 'AT+ROIIMG', 'START': 'AT+INSTALL' };
    if (map[name]) await bleSend(map[name]);
}

export async function bleSendRoiPayload(payloadBytes) {
    const hex = Array.from(payloadBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    await bleSend('AT+SETROI=' + hex);
}

export function isBleCalibMode() {
    return state.bleCalibMode && bleChar != null;
}

export function hasBluetooth() {
    return !!navigator.bluetooth;
}

/* ── Disconnect ── */
function disconnectBLE() {
    if (bleChar) {
        try {
            bleChar.removeEventListener('characteristicvaluechanged', onBleData);
            bleChar.stopNotifications();
        } catch (e) {}
    }
    if (bleDevice && bleDevice.gatt.connected) bleDevice.gatt.disconnect();
    bleDevice = null;
    bleChar = null;
    accumulator = [];
    frameCount = 0;
    dom.cam.style.display = 'none';
    dom.connectScreen.style.display = 'flex';
    dom.stats.className = '';
    dom.stats.textContent = 'Disconnected';
    dom.statusDot.classList.remove('connected');
}
