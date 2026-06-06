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
import { dom, log, syncImageModeFromFrame } from './ui.js';
import { findMarker, readU32LE } from './helpers.js';
import { JPEG_SOI, JPEG_EOI, AI_HEADER, AI_RESULT_OFFSET, AI_RESULT_DATA_SIZE } from './constants.js';

/* BT24 typically uses FFE0/FFE1 for transparent UART */
const BLE_SERVICE_UUID = 0xFFE0;
const BLE_CHAR_UUID = 0xFFE1;

/* Fallback: Nordic UART Service */
const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; /* notify */
const NUS_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; /* write */

let bleDevice = null;
let bleRxChar = null; /* write to device (FFE2 — BLE→UART) */
let bleTxChar = null; /* notify from device (FFE1 — UART→BLE) */
let blePwdChar = null; /* write password to BT24 (FFE1) */
let accumulator = [];
let frameCount = 0;
let fpsCount = 0;
let lastFpsTime = 0;
let gattDisconnected = false;

/* Known BT24 passwords — tried in order on reconnect */
const BT24_PASSWORDS = ['123456', '000000', '0000'];

function onGattDisconnected() {
    gattDisconnected = true;
    log('GATT disconnected (event)');
}

/* ── Connect via Web Bluetooth ── */
export async function connectBLE() {
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
            /* Enumerate all characteristics to find correct TX/RX */
            const chars = await service.getCharacteristics();
            for (const c of chars) {
                const props = c.properties;
                const propList = [];
                if (props.read) propList.push('read');
                if (props.write) propList.push('write');
                if (props.writeWithoutResponse) propList.push('writeNoResp');
                if (props.notify) propList.push('notify');
                if (props.indicate) propList.push('indicate');
                log(`  Char ${c.uuid}: ${propList.join(', ')}`);
            }
            /* Find notify char (device→phone) and SEPARATE write char (phone→device).
             * BT24 uses FFE1 for notify (UART→BLE) and FFE2 for write (BLE→UART).
             * They must be different characteristics! */
            const notifyChar = chars.find(c => c.properties.notify || c.properties.indicate);
            /* Prefer a write-only char (no notify) for BLE→UART — that's FFE2 */
            let writeChar = chars.find(c => (c.properties.writeWithoutResponse || c.properties.write) && !c.properties.notify);
            if (!writeChar) writeChar = chars.find(c => c.properties.writeWithoutResponse || c.properties.write);
            if (!writeChar || !notifyChar) {
                throw new Error(`Missing chars: write=${!!writeChar} notify=${!!notifyChar}`);
            }
            /* Use FFE1 for EVERYTHING (write + notify) — it's the main UART bridge.
             * FFE2 accepts writes but doesn't relay to UART. */
            rxChar = notifyChar;  /* write AT commands to FFE1 */
            txChar = notifyChar;  /* receive notifications from FFE1 */
            log(`BT24 chars: FFE1=${notifyChar.uuid} FFE2=${writeChar.uuid}`);
            log(`  Using FFE1 for both write+notify`);
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

        /* BT24 is fully transparent — no password needed.
         * IMPORTANT: USB cable must be disconnected before BLE use.
         * The FT230X USB chip blocks BT24 writes on shared PA3 (USART2 RX). */
        log('BLE ready (no password needed — BT24 transparent)');
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

    /* BLE has 20-byte MTU limit — send in chunks.
     * Try writeValueWithResponse first (some BT24 modules ignore WithoutResponse).
     * Fallback to writeValueWithoutResponse if the char doesn't support it. */
    const charName = bleRxChar.uuid.includes('ffe1') ? 'FFE1' : 'FFE2';
    let writeType = '?';
    for (let i = 0; i < data.length; i += 20) {
        const chunk = data.slice(i, i + 20);
        try {
            await bleRxChar.writeValueWithResponse(chunk);
            writeType = 'withResponse';
        } catch (e) {
            await bleRxChar.writeValueWithoutResponse(chunk);
            writeType = 'withoutResponse';
        }
    }
    log(`Sent [${charName}/${writeType}]: ${cmd}`);
}

/* Send raw bytes to a specific characteristic */
async function bleWriteRaw(char, data) {
    const charName = char.uuid.includes('ffe1') ? 'FFE1' : 'FFE2';
    for (let i = 0; i < data.length; i += 20) {
        const chunk = data.slice(i, i + 20);
        try {
            await char.writeValueWithResponse(chunk);
            if (i === 0) log(`  ${charName} writeWithResponse OK (${data.length}B)`);
        } catch (e) {
            await char.writeValueWithoutResponse(chunk);
            if (i === 0) log(`  ${charName} writeWithoutResponse fallback (${data.length}B)`);
        }
    }
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

    /* Log first notification bytes to debug data format */
    if (notifyCount <= 3) {
        const hex = Array.from(value.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        log(`BLE notif #${notifyCount} (${value.length}B): ${hex}`);
    }

    /* Log every 50 notifications to show data is flowing */
    if (notifyCount % 50 === 0) {
        /* Check if FF D8 exists anywhere in buffer */
        let soiFound = false;
        for (let i = 0; i < accumulator.length - 1; i++) {
            if (accumulator[i] === 0xFF && accumulator[i+1] === 0xD8) { soiFound = true; break; }
        }
        log(`BLE: ${notifyCount} notifs, ${totalBleBytes}B, buf=${accumulator.length}, SOI=${soiFound}`);
    }

    extractAndDisplayFrames();
}

/* ── Extract AI result from bytes before SOI (C0 5A 63 A4 + 3 reserved + 8 data) ── */
function extractAiResult(soiIndex) {
    if (soiIndex < AI_RESULT_OFFSET + AI_RESULT_DATA_SIZE) return;

    /* Scan backwards from SOI looking for AI header */
    for (let p = soiIndex - 1; p >= 0; p--) {
        if (accumulator[p] === AI_HEADER[0] && accumulator[p+1] === AI_HEADER[1]
            && accumulator[p+2] === AI_HEADER[2] && accumulator[p+3] === AI_HEADER[3]) {

            const off = p + AI_RESULT_OFFSET;
            if (off + AI_RESULT_DATA_SIZE > accumulator.length) break;

            state.lastAiResult = {
                integer: readU32LE(accumulator, off),
                decimal: readU32LE(accumulator, off + 4),
                confidence: 0,
                flags: 0,
            };
            break;
        }
    }
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

        /* Extract AI reading from data before SOI */
        if (soi > 0) extractAiResult(soi);

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
        syncImageModeFromFrame();
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
        let aiText = '';
        if (state.lastAiResult) {
            const reading = state.lastAiResult.integer + state.lastAiResult.decimal / 1_000_000;
            aiText = ` | AI: ${reading.toFixed(2)}`;
        }
        dom.stats.textContent = `BLE #${frameCount} | ${fps.toFixed(1)} fps${aiText}`;
    }
}

/* ── Start BLE session (install + calibration via tabs) ── */
export async function startBleSession() {
    accumulator = [];
    frameCount = 0;
    fpsCount = 0;
    lastFpsTime = performance.now();

    /* Show camera view + full UI */
    dom.connectScreen.style.display = 'none';
    dom.cam.style.display = 'block';
    dom.stats.className = 'active';
    dom.statusDot.classList.add('connected');
    dom.modeToggle.classList.add('visible');
    dom.modeArea.classList.add('visible');
    dom.modeSelector.classList.add('visible');
    dom.btnStop.classList.add('visible');
    dom.stats.textContent = 'BLE — waiting for frames...';

    /* AT+INSTALL enters camera streaming mode on firmware.
     *
     * Problem: if the MCU is in Stop mode, the first command's bytes are
     * lost during EXTI→USART2 reconfiguration. The firmware stays awake
     * 500ms after UART wakeup, so we must:
     *   1. Send AT+INSTALL (wakes MCU — command lost)
     *   2. Wait 200ms (MCU is reconfiguring clocks + USART2)
     *   3. Send AT+INSTALL again (arrives cleanly within 500ms window)
     *   4. Wait for JPEG frames
     */
    state.running = true;
    state.bleMode = true;
    state.bleCalibMode = true;

    for (let attempt = 1; attempt <= 3; attempt++) {
        log(`AT+INSTALL attempt ${attempt}/3...`);

        /* Double-send: first wakes MCU, second is processed */
        await bleSend('AT+INSTALL');
        await new Promise(r => setTimeout(r, 200));
        await bleSend('AT+INSTALL');

        /* Wait up to 15s for first frame (BLE at 9600 baud is slow) */
        const t0 = performance.now();
        while (performance.now() - t0 < 15000) {
            if (frameCount > 0) break;
            await new Promise(r => setTimeout(r, 300));
        }
        if (frameCount > 0) {
            log(`Camera streaming after attempt ${attempt}`);
            break;
        }

        if (attempt < 3) {
            log('No frames yet — retrying...');
        }
    }

    if (frameCount === 0) {
        log('WARNING: no frames received — camera may not have started');
    }
}

/* ── Stop BLE session ── */
export async function stopBleSession() {
    if (bleRxChar) {
        try { await bleSend('AT+STOP'); } catch (e) {}
    }

    state.running = false;
    state.bleMode = false;
    state.bleCalibMode = false;

    dom.cam.style.display = 'none';
    dom.connectScreen.style.display = 'flex';
    dom.modeToggle.classList.remove('visible');
    dom.modeArea.classList.remove('visible');
    dom.modeSelector.classList.remove('visible');
    dom.btnStop.classList.remove('visible');
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
    return state.bleCalibMode && bleRxChar != null;
}

export function isBleConnected() {
    return state.bleMode && bleDevice != null;
}

/* ── Check Web Bluetooth availability ── */
export function hasBluetooth() {
    return !!navigator.bluetooth;
}
