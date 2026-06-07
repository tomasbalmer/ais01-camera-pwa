/*
 * Mock modes for testing UI without a real device.
 * Usage: ?mock=setup  — full BLE setup flow simulation
 *        ?mock        — instant camera view with mock image
 */

import { state } from './state.js';
import { dom, log, switchMode } from './ui.js';
import { SETUP_STEPS } from './constants.js';

const MOCK_METER_SVG = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">'
    + '<rect fill="#1a1a2e" width="640" height="480"/>'
    + '<circle cx="320" cy="200" r="120" fill="none" stroke="#334155" stroke-width="2"/>'
    + '<text x="320" y="190" text-anchor="middle" fill="#38bdf8" font-family="monospace" font-size="28">00000.00</text>'
    + '<text x="320" y="220" text-anchor="middle" fill="#475569" font-family="monospace" font-size="12">m³</text>'
    + '</svg>'
);

const CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

function setStepUI(id, status) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('active', 'done');
    const icon = el.querySelector('.step-icon');
    if (status === 'done') { el.classList.add('done'); icon.innerHTML = CHECK_SVG; }
    else if (status === 'active') { el.classList.add('active'); icon.innerHTML = ''; }
    else { icon.innerHTML = ''; }
}

function applyStepConfig(idx, status) {
    const s = SETUP_STEPS[idx];
    setStepUI(s.id, status);
    const cfg = status === 'done' ? s.onDone : s.onActive;
    if (!cfg) return;
    const titleEl = document.getElementById('setup-title');
    const instrEl = document.getElementById('setup-instruction');
    const ring = document.getElementById('setup-ring');
    if (cfg.title && titleEl) titleEl.textContent = cfg.title;
    if (cfg.instruction && instrEl) instrEl.textContent = cfg.instruction;
    if (cfg.anim && ring) ring.setAttribute('data-state', cfg.anim);
}

function showCameraUI() {
    dom.connectScreen.style.display = 'none';
    dom.cam.style.display = 'block';
    dom.cam.src = MOCK_METER_SVG;
    dom.modeArea.classList.add('visible');
    dom.modeSelector.classList.add('visible');
    const mt = document.getElementById('mode-title');
    if (mt) mt.style.display = 'block';
    state.activeMode = null;
    switchMode('validate');
    dom.stats.textContent = 'Streaming';
}

// ── ?mock=setup — Full BLE setup flow ──
export function runMockSetup() {
    state.running = true;
    state.bleMode = true;
    state.bleCalibMode = true;
    document.getElementById('connect-chooser').style.display = 'none';
    const panel = document.getElementById('setup-panel');
    if (panel) panel.style.display = 'flex';
    dom.statusDot.classList.add('connected');
    dom.btnStop.classList.add('visible');
    dom.stats.className = 'active';
    dom.stats.textContent = 'Mock setup';

    const hintEl = document.getElementById('reconnect-hint');
    const showHint = () => { if (hintEl) hintEl.style.display = 'flex'; };
    const hideHint = () => { if (hintEl) hintEl.style.display = 'none'; };

    // Step 1 done, Step 2 active
    applyStepConfig(0, 'done');
    applyStepConfig(1, 'active');
    log('BLE connected');

    // GATT failures → reconnect hint
    setTimeout(() => log('GATT connect failed (attempt 1)'), 1000);
    setTimeout(() => log('GATT connect failed (attempt 2)'), 3000);
    setTimeout(() => log('GATT connect failed (attempt 3)'), 5000);
    setTimeout(() => { log('GATT connect failed (attempt 4)'); showHint(); }, 7000);
    setTimeout(() => { log('GATT connect failed (attempt 5)'); showHint(); }, 9000);

    // GATT connects
    setTimeout(() => { log('GATT connected'); hideHint(); }, 10000);

    // Step 2 done, Step 3 active
    setTimeout(() => { log('Device responding'); applyStepConfig(1, 'done'); applyStepConfig(2, 'active'); }, 11000);

    // Firmware banner
    setTimeout(() => {
        log('[device] ========================================');
        log('[device]   AIS01-CB Custom Firmware v0.9.0');
        log('[device] ========================================');
    }, 12000);
    setTimeout(() => log('[device] [MAIN] Config loaded from EEPROM'), 12800);

    // Step 3 done, Step 4 active
    setTimeout(() => {
        log('[device] [MAIN] AT command window (30s)...');
        applyStepConfig(2, 'done');
        applyStepConfig(3, 'active');
    }, 13500);

    // AT+INSTALL
    setTimeout(() => { log('Firmware ready — sending AT+INSTALL'); log('Sent: AT+INSTALL'); }, 14000);

    // Step 4 done, Step 5 active
    setTimeout(() => {
        log('[device] Entering installation mode...');
        log('[device]   INSTALLATION MODE');
        applyStepConfig(3, 'done');
        applyStepConfig(4, 'active');
    }, 15000);

    // Camera init
    setTimeout(() => log('[device] [CAM] Power ON — init UART...'), 15500);
    setTimeout(() => log('[device] [CAM] UART OK — 5V on...'), 16000);
    setTimeout(() => log('[device] [CAM] 5V OK — delay 2s...'), 16300);

    // Step 5 done, Step 6 active
    setTimeout(() => {
        log('[device] [CAM] Power ON complete');
        applyStepConfig(4, 'done');
        applyStepConfig(5, 'active');
    }, 18300);

    // Step 6 done
    setTimeout(() => {
        log('First BLE frame: 2930 bytes');
        log('Camera streaming');
        applyStepConfig(5, 'done');
    }, 20000);

    // Skeleton transition
    setTimeout(() => {
        if (panel) panel.style.display = 'none';
        const skeleton = document.getElementById('skeleton-transition');
        if (skeleton) skeleton.style.display = 'flex';
    }, 20500);

    // Camera UI
    setTimeout(() => {
        const skeleton = document.getElementById('skeleton-transition');
        if (skeleton) skeleton.style.display = 'none';
        showCameraUI();
    }, 23000);

    log('Mock setup mode — simulating BLE connection flow');
}

// ── ?mock — Instant camera view ──
export function runMockCamera() {
    state.running = true;
    state.bleMode = true;
    state.bleCalibMode = true;
    dom.statusDot.classList.add('connected');
    dom.btnStop.classList.add('visible');
    dom.stats.className = 'active';
    dom.stats.textContent = 'Mock mode';
    showCameraUI();
    log('Mock mode — no BLE connection');
}
