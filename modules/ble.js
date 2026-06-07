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
import { JPEG_SOI, JPEG_EOI, AI_HEADER, AI_RESULT_OFFSET, AI_RESULT_DATA_SIZE, SETUP_STEPS, SETUP_ERRORS } from './constants.js';

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

/* ── Reconnect hint (card overlay) ── */

function showReconnectHint() {
    const hint = document.getElementById('reconnect-hint');
    if (hint) hint.style.display = 'flex';
}

function hideReconnectHint() {
    const hint = document.getElementById('reconnect-hint');
    if (hint) hint.style.display = 'none';
}

const MAX_RECONNECT_ATTEMPTS = 15;

/* Errors that mean the device is gone — no point retrying */
const FATAL_ERRORS = [
    'no longer in range',
    'removed',
    'not found',
];

/* Single place that evaluates reconnect state and shows/hides hint */
function onReconnectFailed(reason) {
    reconnectAttempts++;
    log('GATT reconnect failed #' + reconnectAttempts + (reason ? ': ' + reason : ''));
    setStep('step-reconnect', 'active');

    const isFatal = reason && FATAL_ERRORS.some(e => reason.toLowerCase().includes(e));

    if (isFatal || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        log('Connection lost — device unreachable');
        setTitle('Device Lost');
        setAnim('error');
        setInstruction(isFatal ? 'Device out of range' : 'Too many failed attempts');
        showReconnectHint();
        /* Stop retrying — clear bleMode so the retry chain stops */
        state.bleMode = false;
        state.bleCalibMode = false;
        return;
    }

    if (reconnectAttempts >= 4) {
        showReconnectHint();
    }
}

function onReconnectSuccess() {
    reconnectAttempts = 0;
    gattDisconnected = false;
    hideReconnectHint();
    log('GATT connected');
    /* Don't mark step-reconnect done yet — wait for actual device data */
    setStep('step-reconnect', 'active');
}

/* ── Auto-reconnect on ANY disconnect (v4 approach — simple, always on) ── */

function onGattDisconnected() {
    gattDisconnected = true;
    log('GATT disconnected — reconnecting in 1s...');
    bleRxChar = null;
    bleTxChar = null;
    if (state.bleMode || state.bleCalibMode) {
        applyStep('step-reconnect', 'active', SETUP_STEPS[1].onActive);
        setTimeout(() => gattConnect(), 1000);
    }
}

const GATT_CONNECT_TIMEOUT = 8000;

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
}

async function gattConnect() {
    if (!bleDevice) { log('gattConnect: no device'); return false; }
    if (bleRxChar) return true;
    if (!(state.bleMode || state.bleCalibMode)) return false;
    log('GATT reconnecting...');
    try {
        const server = await withTimeout(bleDevice.gatt.connect(), GATT_CONNECT_TIMEOUT);
        if (bleRxChar) return true; /* another concurrent call already finished */
        const service = await server.getPrimaryService(BLE_SERVICE_UUID);
        const char = await service.getCharacteristic(BLE_CHAR_UUID);
        await char.startNotifications();
        char.addEventListener('characteristicvaluechanged', onBleData);
        bleRxChar = char;
        bleTxChar = char;
        onReconnectSuccess();
        return true;
    } catch (e) {
        bleRxChar = null;
        bleTxChar = null;
        onReconnectFailed(e.message);
        /* Keep retrying unless onReconnectFailed stopped the session */
        if (state.bleMode || state.bleCalibMode) {
            setTimeout(() => gattConnect(), 2000);
        }
        return false;
    }
}

/* Update setup step UI: 'pending' | 'active' | 'done' */
function setStep(stepId, status) {
    const el = document.getElementById(stepId);
    if (!el) return;
    el.classList.remove('active', 'done');
    const icon = el.querySelector('.step-icon');
    if (status === 'active') {
        el.classList.add('active');
        icon.innerHTML = '';  /* CSS ::after creates the pulsing dot */
    } else if (status === 'done') {
        el.classList.add('done');
        icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
    } else {
        icon.innerHTML = '';
    }
}

function setTitle(text) {
    const el = document.getElementById('setup-title');
    if (el) el.textContent = text;
}

/* Animated ring states — drives the CSS ring + inner icon */
function setAnim(mode) {
    const ring = document.getElementById('setup-ring');
    const icon = document.getElementById('setup-ring-icon');
    if (!ring || !icon) return;

    ring.setAttribute('data-state', mode || 'waiting');

    const svgAttrs = 'width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

    if (mode === 'waiting') {
        /* Spinning ring + retry icon */
        icon.innerHTML = `<svg ${svgAttrs}><path d="M6.5 6.5c3-3 8-3 11 0s3 8 0 11-8 3-11 0"/><path d="M6.5 6.5L3 3"/><path d="M6.5 6.5V3"/><path d="M6.5 6.5H3"/></svg>`;
    } else if (mode === 'connected') {
        /* Solid checkmark */
        icon.innerHTML = `<svg ${svgAttrs}><path d="M20 6L9 17l-5-5"/></svg>`;
    } else if (mode === 'streaming') {
        /* Wifi/signal icon */
        icon.innerHTML = `<svg ${svgAttrs}><path d="M12 20h.01"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5 12.5a10 10 0 0 1 14 0"/></svg>`;
    } else if (mode === 'error') {
        /* X icon */
        icon.innerHTML = `<svg ${svgAttrs} stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    } else if (mode === 'ended') {
        /* Power off icon */
        icon.innerHTML = `<svg ${svgAttrs}><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>`;
    }
}

function setInstruction(text) {
    const el = document.getElementById('setup-instruction');
    if (el) el.textContent = text;
}

/* Apply step state + update header from SETUP_STEPS config.
 * When marking a step 'done', ensure all prior steps are also 'done'
 * so we never have a completed step with an incomplete one above it. */
function applyStep(stepId, status, config) {
    if (status === 'done') {
        const idx = SETUP_STEPS.findIndex(s => s.id === stepId);
        for (let i = 0; i < idx; i++) {
            const el = document.getElementById(SETUP_STEPS[i].id);
            if (el && !el.classList.contains('done')) {
                setStep(SETUP_STEPS[i].id, 'done');
            }
        }
    }
    setStep(stepId, status);
    if (config) {
        if (config.title) setTitle(config.title);
        if (config.instruction) setInstruction(config.instruction);
        if (config.anim) setAnim(config.anim);
    }
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
let firstNotification = false;  /* any BLE data received = device alive */
let firmwareBannerSeen = false; /* "AIS01-CB Custom Firmware" seen */
let firmwareReady = false;      /* "AT command window" seen */
let installAcked = false;       /* "Entering installation mode" seen */
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

    /* First notification = device is alive, GATT is stable */
    if (!firstNotification) {
        firstNotification = true;
        applyStep('step-reconnect', 'done', SETUP_STEPS[1].onDone);
        hideReconnectHint();
        log('Device responding');
    }

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

                /* ── Step detection from SETUP_STEPS config ── */
                for (const step of SETUP_STEPS) {
                    if (!step.detect) continue;

                    /* Check 'active' triggers */
                    if (step.detect.active) {
                        const match = step.detect.active.some(s => line.includes(s));
                        if (match && !document.getElementById(step.id)?.classList.contains('done')) {
                            applyStep(step.id, 'active', step.onActive);
                        }
                    }

                    /* Check 'done' triggers */
                    if (step.detect.done) {
                        const match = step.detect.done.some(s => line.includes(s));
                        if (match) {
                            applyStep(step.id, 'done', step.onDone);

                            /* Activate next step */
                            const idx = SETUP_STEPS.indexOf(step);
                            if (idx < SETUP_STEPS.length - 1) {
                                const next = SETUP_STEPS[idx + 1];
                                if (next.onActive) applyStep(next.id, 'active', next.onActive);
                            }
                        }
                    }
                }

                /* Special: firmware ready → send AT+INSTALL */
                if (line.includes('AT command window')) {
                    firmwareReady = true;
                    if (!installAcked) {
                        log('Firmware ready — sending AT+INSTALL');
                        bleSend('AT+INSTALL').catch(() => {});
                    }
                }

                /* Special: install acknowledged */
                if (line.includes('Entering installation mode') || line.includes('INSTALLATION MODE')) {
                    installAcked = true;
                }

                /* Special: duty cycle = missed window */
                if (line.includes('Window closed') || line.includes('duty cycle start') || line.includes('Duty cycle start')) {
                    dutyCycleStarted = true;
                }

                /* ── Error detection from SETUP_ERRORS config ── */
                for (const err of SETUP_ERRORS) {
                    if (err.detect.some(s => line.includes(s))) {
                        setTitle(err.title);
                        setAnim(err.anim);
                        setInstruction(err.instruction);
                        if (err.showReconnectHint) showReconnectHint();
                    }
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
    firstNotification = false;
    firmwareBannerSeen = false;
    firmwareReady = false;
    installAcked = false;
    dutyCycleStarted = false;
    textLineBuf = '';
    gattDisconnected = false;
    reconnectAttempts = 0;
    hideReconnectHint();

    applyStep('step-ble', 'done', SETUP_STEPS[0].onDone);
    applyStep('step-reconnect', 'active', SETUP_STEPS[1].onActive);
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
        /* Ensure all prior steps are marked done */
        for (const step of SETUP_STEPS) {
            setStep(step.id, 'done');
        }
        hideReconnectHint();
        const lastStep = SETUP_STEPS[SETUP_STEPS.length - 1];
        applyStep(lastStep.id, 'done', lastStep.onDone);
        log('Camera streaming');

        /* ── Skeleton transition: setup panel → shimmer → camera UI ── */
        const setupPanel = document.getElementById('setup-panel');
        const skeleton = document.getElementById('skeleton-transition');
        if (setupPanel) setupPanel.style.display = 'none';
        if (skeleton) skeleton.style.display = 'flex';

        await new Promise(r => setTimeout(r, 2500));

        if (skeleton) skeleton.style.display = 'none';
        dom.connectScreen.style.display = 'none';
        dom.cam.style.display = 'block';
        dom.modeArea.classList.add('visible');
        dom.modeSelector.classList.add('visible');
        const mt = document.getElementById('mode-title');
        if (mt) mt.style.display = 'block';
        /* Initialize mode title */
        state.activeMode = null;
        const { switchMode } = await import('./ui.js');
        switchMode('validate');
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
        setInstruction('Disconnected');

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
