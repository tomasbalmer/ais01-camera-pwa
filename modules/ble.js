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

/* Auto-reconnect on ANY disconnect (v4 approach — simple, always on) */
function onGattDisconnected() {
    gattDisconnected = true;
    log('GATT disconnected — reconnecting in 1s...');
    bleRxChar = null;
    bleTxChar = null;
    if (state.bleMode || state.bleCalibMode) {
        setTimeout(() => gattConnect(), 1000);
    }
}

async function gattConnect() {
    if (!bleDevice) return false;
    if (bleRxChar) return true;
    try {
        const server = await bleDevice.gatt.connect();
        if (bleRxChar) return true; /* another concurrent call already finished */
        const service = await server.getPrimaryService(BLE_SERVICE_UUID);
        const char = await service.getCharacteristic(BLE_CHAR_UUID);
        await char.startNotifications();
        char.addEventListener('characteristicvaluechanged', onBleData);
        bleRxChar = char;
        bleTxChar = char;
        gattDisconnected = false;
        reconnectAttempts = 0;
        log('GATT connected');
        setStep('step-reconnect', 'active');
        setTitle('Device Connected');
        setInstruction('Waiting for firmware...');
        return true;
    } catch (e) {
        log('GATT connect failed: ' + e.message);
        bleRxChar = null;
        bleTxChar = null;
        return false;
    }
}

/* Update setup step UI: 'pending' | 'active' | 'done' */
function setStep(stepId, status) {
    const el = document.getElementById(stepId);
    if (!el) return;
    el.classList.remove('active', 'done');
    if (status === 'active') {
        el.classList.add('active');
        el.querySelector('.step-icon').textContent = '●';
    } else if (status === 'done') {
        el.classList.add('done');
        el.querySelector('.step-icon').textContent = '✓';
    } else {
        el.querySelector('.step-icon').textContent = '○';
    }
}

function setTitle(text) {
    const el = document.getElementById('setup-title');
    if (el) el.textContent = text;
}

/* Animated icon states */
let animInterval = null;
function setAnim(mode) {
    if (animInterval) { clearInterval(animInterval); animInterval = null; }
    const el = document.getElementById('setup-anim');
    if (!el) return;
    el.style.fontSize = '32px';
    el.style.lineHeight = '1';
    el.style.fontFamily = "'SF Mono',Monaco,monospace";
    if (mode === 'waiting') {
        /* Apple-style loading dots */
        el.style.fontSize = '24px';
        el.style.letterSpacing = '8px';
        el.style.color = '#38bdf8';
        el.style.whiteSpace = 'normal';
        el.innerHTML = '<span class="dot">●</span><span class="dot">●</span><span class="dot">●</span>';
        /* Inject animation style if not present */
        if (!document.getElementById('dot-anim-style')) {
            const style = document.createElement('style');
            style.id = 'dot-anim-style';
            style.textContent = '@keyframes dot-pulse{0%,80%,100%{opacity:0.15;transform:scale(0.8)}40%{opacity:1;transform:scale(1)}}.dot{display:inline-block;animation:dot-pulse 1.4s ease-in-out infinite}.dot:nth-child(2){animation-delay:0.2s}.dot:nth-child(3){animation-delay:0.4s}';
            document.head.appendChild(style);
        }
    } else {
        el.style.whiteSpace = 'normal';
        el.style.fontSize = '32px';
        el.style.fontFamily = "'SF Mono',Monaco,monospace";
        el.innerHTML = '';
        if (mode === 'connected') {
            el.textContent = '●';
            el.style.color = '#22c55e';
            el.style.animation = 'none';
        } else if (mode === 'streaming') {
            el.textContent = '●';
            el.style.color = '#22c55e';
            el.style.animation = 'none';
        } else if (mode === 'ended') {
            el.textContent = '○';
            el.style.color = '#64748b';
            el.style.animation = 'none';
        } else if (mode === 'error') {
            el.textContent = '✕';
            el.style.color = '#ef4444';
            el.style.animation = 'none';
        }
    }
}

function setInstruction(text) {
    const el = document.getElementById('setup-instruction');
    if (el) el.textContent = text;
}

/* ── Setup GATT connection: discover service, subscribe to notifications ── */
async function setupGatt() {
    const server = await bleDevice.gatt.connect();

    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    const chars = await service.getCharacteristics();

    /* FFE1 is the main UART bridge (read+write+notify).
     * FFE2 accepts writes but doesn't relay to UART — don't use it. */
    const notifyChar = chars.find(c => c.properties.notify);
    if (!notifyChar) throw new Error('No notify characteristic found');

    bleRxChar = notifyChar;  /* write to FFE1 → UART */
    bleTxChar = notifyChar;  /* notify from FFE1 ← UART */

    await bleTxChar.startNotifications();
    bleTxChar.addEventListener('characteristicvaluechanged', onBleData);
}

/* ── Connect via Web Bluetooth (user scan + pair) ── */
export async function connectBLE() {
    log('Scanning for BLE devices...');

    try {
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [
                { namePrefix: '8683' },   /* Match IMEI-based names (this device) */
                { namePrefix: '8691' },   /* Match other IMEI prefixes */
                { namePrefix: 'BT24' },
                { namePrefix: 'Dragino' },
                { namePrefix: 'AIS01' },
                { services: [BLE_SERVICE_UUID] },
            ],
            optionalServices: [BLE_SERVICE_UUID, NUS_SERVICE_UUID],
        });

        log(`Found: ${bleDevice.name || 'Unknown'}`);
        bleDevice.addEventListener('gattserverdisconnected', onGattDisconnected);
        await setupGatt();
        log('BLE connected');
        return true;

    } catch (err) {
        /* Only reaches here if requestDevice itself failed (user cancelled scan) */
        log('BLE error: ' + err.message);
        return false;
    }
}

let reconnectAttempts = 0;

/* ── Send string command via BLE ── */
async function bleSend(cmd) {
    /* v4: reconnect if disconnected */
    if (bleDevice && !bleDevice.gatt.connected) {
        reconnectAttempts++;
        if (reconnectAttempts === 1) log('Reconnecting...');
        if (reconnectAttempts === 4) {
            setTitle('Connection Lost');
            setInstruction('Press RESET on the device again');
            setAnim('waiting');
        }
        if (!await gattConnect()) return;
    }
    if (!bleRxChar) return;
    const data = new TextEncoder().encode(cmd + '\r\n');
    for (let i = 0; i < data.length; i += 20) {
        const chunk = data.slice(i, i + 20);
        await bleRxChar.writeValueWithoutResponse(chunk);
    }
    if (cmd !== 'AT') log('Sent: ' + cmd);
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
let firmwareReady = false;
let installAcked = false;
let bootloaderSeen = false;
let dutyCycleStarted = false;
let textLineBuf = '';

/* Check if a byte array is printable ASCII text (not binary/JPEG) */
function isAsciiText(bytes) {
    let printable = 0;
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if ((b >= 0x20 && b <= 0x7E) || b === 0x0D || b === 0x0A || b === 0x09)
            printable++;
    }
    return printable > bytes.length * 0.8;
}

function onBleData(event) {
    const value = new Uint8Array(event.target.value.buffer);
    totalBleBytes += value.length;
    notifyCount++;

    /* Periodic log so we know notifications are flowing */
    if (notifyCount % 100 === 0) {
        log(`[ble] ${notifyCount} notifications, ${totalBleBytes}B total, buf=${accumulator.length}`);
    }

    /* If data looks like ASCII text, show it in the PWA log.
     * ALSO always accumulate for JPEG extraction — JPEG headers contain
     * ASCII-like bytes (JFIF, Huffman tables) that fool the text detector.
     * The frame extractor safely skips non-JPEG bytes. */
    if (isAsciiText(value)) {
        const text = new TextDecoder().decode(value);
        textLineBuf += text;

        /* Flush complete lines to log */
        while (textLineBuf.includes('\n')) {
            const nlIdx = textLineBuf.indexOf('\n');
            const line = textLineBuf.slice(0, nlIdx).replace(/\r/g, '').trim();
            textLineBuf = textLineBuf.slice(nlIdx + 1);
            if (line) {
                /* Detect firmware state from device output */
                if (line.includes('AT+BAUD') || line.includes('AT+PWRM') || line.includes('AT+NAME')) {
                    bootloaderSeen = true;
                }

                /* Filter noise: skip AT ping responses and bootloader AT commands */
                const isNoise = line === 'OK' || line === 'ERROR' || line === 'AT_ERROR'
                    || line.startsWith('AT+BAUD') || line.startsWith('AT+PWRM')
                    || line.startsWith('AT+NAME') || line.startsWith('AT+RESET')
                    || line === 'AT';
                if (!isNoise) log(`[device] ${line}`);
                if (line.includes('AT command window')) {
                    firmwareReady = true;
                    setStep('step-reconnect', 'done');
                    setStep('step-firmware', 'done');
                    setStep('step-install', 'active');
                    setTitle('Firmware Ready');
                    setAnim('connected');
                    setInstruction('Sending install command...');
                    if (!installAcked) {
                        log('Firmware ready — sending AT+INSTALL');
                        bleSend('AT+INSTALL').catch(() => {});
                    }
                }
                if (line.includes('Entering installation mode') || line.includes('INSTALLATION MODE')) {
                    installAcked = true;
                    setStep('step-install', 'done');
                    setStep('step-camera-init', 'active');
                    setTitle('Calibration Mode');
                    setInstruction('Powering on camera...');
                }
                if (line.includes('[CAM] Power ON')) {
                    setStep('step-camera-init', 'active');
                    setInstruction('Camera initializing...');
                }
                if (line.includes('[CAM] Power ON complete')) {
                    setStep('step-camera-init', 'done');
                    setStep('step-camera', 'active');
                    setInstruction('Waiting for first frame...');
                }
                if (line.includes('Window closed') || line.includes('duty cycle start') || line.includes('Duty cycle start')) {
                    dutyCycleStarted = true;
                    setTitle('Missed Window');
                    setAnim('error');
                    setInstruction('Device started duty cycle — press RESET to try again');
                }
            }
        }
    }

    /* Always accumulate + extract — even text-looking data goes here
     * so JPEG frames aren't broken by misclassified notifications */
    for (let i = 0; i < value.length; i++) {
        accumulator.push(value[i]);
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

    /* Switch from chooser to setup panel */
    const chooser = document.getElementById('connect-chooser');
    const panel = document.getElementById('setup-panel');
    if (chooser) chooser.style.display = 'none';
    if (panel) panel.style.display = 'flex';
    const bottomActions = document.getElementById('setup-bottom-actions');
    if (bottomActions) { bottomActions.style.display = 'none'; bottomActions.innerHTML = ''; }

    dom.statusDot.classList.add('connected');
    dom.btnStop.classList.add('visible');
    dom.stats.className = 'active';
    dom.stats.textContent = 'Setting up...';

    state.running = true;
    state.bleMode = true;
    state.bleCalibMode = true;
    firmwareReady = false;
    installAcked = false;
    dutyCycleStarted = false;
    textLineBuf = '';
    gattDisconnected = false;

    setStep('step-ble', 'done');
    setTitle('Waiting for Device');
    setAnim('waiting');
    setInstruction('Press RESET on the device');
    setStep('step-reconnect', 'active');
    dom.stats.textContent = 'Waiting for device...';

    /* v4 approach: AT ping → AT+INSTALL when firmware detected. Stops on ACK or frames. */
    let retryCount = 0;
    const MAX_RETRIES = 30;
    let installInterval = null;

    const sendInstall = async () => {
        retryCount++;
        if (installAcked || frameCount > 0) {
            clearInterval(installInterval);
            installInterval = null;
            setStep('step-install', 'done');
            return;
        }
        if (retryCount > MAX_RETRIES) {
            clearInterval(installInterval);
            installInterval = null;
            log('Stopped after ' + MAX_RETRIES + ' attempts');
            setTitle('Connection Failed');
            setAnim('error');
            setInstruction('No response — reset device and try again');
            dom.stats.textContent = 'No response';
            return;
        }

        if (firmwareReady) {
            /* Firmware detected — send AT+INSTALL */
            setTitle('Starting Calibration');
            setAnim('connected');
            setStep('step-firmware', 'done');
            setStep('step-install', 'active');
            setInstruction('Sending install command...');
            log(`AT+INSTALL #${retryCount}/${MAX_RETRIES}`);
            try { await bleSend('AT+INSTALL'); } catch (e) {}
        } else {
            /* Bootloader — ping to keep GATT alive */
            try { await bleSend('AT'); } catch (e) {}
        }
    };

    await sendInstall();
    installInterval = setInterval(sendInstall, 3000);

    /* Wait for frames */
    const t1 = performance.now();
    while (frameCount === 0 && (performance.now() - t1) < 120000) {
        await new Promise(r => setTimeout(r, 300));
    }

    if (installInterval) { clearInterval(installInterval); installInterval = null; }

    if (frameCount > 0) {
        setStep('step-install', 'done');
        setStep('step-camera', 'done');
        setAnim('streaming');
        setTitle('Camera Active');
        setInstruction('Streaming');
        log('Camera streaming');
        dom.connectScreen.style.display = 'none';
        dom.cam.style.display = 'block';
        dom.modeArea.classList.add('visible');
        dom.modeSelector.classList.add('visible');
        const mt = document.getElementById('mode-title');
        if (mt) mt.style.display = 'block';
        dom.stats.textContent = 'Streaming';
    } else {
        log('No frames after 120s');
        setInstruction('No response — reset device and try again');
        dom.stats.textContent = 'No frames';
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

    /* Hide any overlay pickers */
    if (typeof hideOverlayPickers === 'function') hideOverlayPickers();
    else { try { window.hideOverlayPickers(); } catch(_) {} }

    dom.cam.style.display = 'none';
    const mt = document.getElementById('mode-title');
    if (mt) mt.style.display = 'none';
    dom.modeArea.classList.remove('visible');
    dom.modeSelector.classList.remove('visible');
    dom.btnStop.classList.remove('visible');
    dom.stats.className = '';
    dom.stats.textContent = 'Disconnected';
    dom.statusDot.classList.remove('connected');

    /* Show setup panel with session logs + bottom actions */
    const panel = document.getElementById('setup-panel');
    const chooser = document.getElementById('connect-chooser');
    if (panel) {
        dom.connectScreen.style.display = 'flex';
        if (chooser) chooser.style.display = 'none';
        panel.style.display = 'flex';
        setTitle('Session Ended');
        setAnim('ended');
        setInstruction('Device disconnected');

        const bottomActions = document.getElementById('setup-bottom-actions');
        if (bottomActions) {
            bottomActions.style.cssText = 'padding:12px 0; display:flex; flex-direction:row; gap:8px;';
            bottomActions.innerHTML = '';

            const btnCopy = document.createElement('button');
            btnCopy.textContent = 'Copy logs';
            btnCopy.style.cssText = 'flex:1;padding:12px 0;font-size:14px;font-weight:500;border-radius:10px;border:1px solid #475569;background:transparent;color:#94a3b8;cursor:pointer;';
            btnCopy.onclick = () => {
                const logEl = document.getElementById('setup-log-content');
                const text = logEl ? logEl.innerText : '';
                navigator.clipboard.writeText(text).then(() => {
                    btnCopy.textContent = 'Copied!';
                    setTimeout(() => btnCopy.textContent = 'Copy logs', 1500);
                });
            };

            const btnBack = document.createElement('button');
            btnBack.textContent = 'Back to main';
            btnBack.style.cssText = 'flex:1;padding:12px 0;font-size:14px;font-weight:600;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;cursor:pointer;';
            btnBack.onclick = () => {
                panel.style.display = 'none';
                bottomActions.style.display = 'none';
                if (chooser) chooser.style.display = 'flex';
                setAnim(null);
            };

            bottomActions.appendChild(btnCopy);
            bottomActions.appendChild(btnBack);
        }
    } else {
        dom.connectScreen.style.display = 'flex';
    }

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
