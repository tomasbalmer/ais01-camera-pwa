import { state } from './state.js';
import { sendCommand } from './protocol.js';

// === DOM refs ===
export const dom = {
    cam: document.getElementById('cam'),
    stats: document.getElementById('stats'),
    statusDot: document.getElementById('status-dot'),
    message: document.getElementById('message'),
    logEl: document.getElementById('log'),
    connectScreen: document.getElementById('connect-screen'),
    drawer: document.getElementById('drawer'),
    drawerOverlay: document.getElementById('drawer-overlay'),
    overlayCanvas: document.getElementById('overlay-canvas'),
    overlayCtx: document.getElementById('overlay-canvas').getContext('2d'),
    konvaContainer: document.getElementById('konva-container'),
    modeHint: document.getElementById('mode-hint'),
    // New: mode system
    modeToggle: document.getElementById('mode-toggle'),
    modeArea: document.getElementById('mode-area'),
    modeSelector: document.getElementById('mode-selector'),
    panelValidate: document.getElementById('panel-validate'),
    panelCalibrate: document.getElementById('panel-calibrate'),
    panelSettings: document.getElementById('panel-settings'),
    btnFull: document.getElementById('btnFull'),
    btnROI: document.getElementById('btnROI'),
    btnStop: document.getElementById('btn-stop'),
    calibAiValue: document.getElementById('calib-ai-value'),
};

// === Image rect helper (accounts for object-fit:contain letterbox) ===
export function getImageRect() {
    const imgW = dom.cam.naturalWidth || 640;
    const imgH = dom.cam.naturalHeight || 480;
    const boxW = dom.cam.clientWidth;
    const boxH = dom.cam.clientHeight;
    const scale = Math.min(boxW / imgW, boxH / imgH);
    const w = imgW * scale;
    const h = imgH * scale;
    const ox = (boxW - w) / 2;
    const oy = (boxH - h) / 2;
    return { ox, oy, w, h, scale };
}

export function clamp16(v) { return Math.max(0, Math.min(65535, Math.round(v))); }

export function syncOverlay() {
    const r = getImageRect();
    const newL = (dom.cam.offsetLeft + r.ox) + 'px';
    const newT = (dom.cam.offsetTop + r.oy) + 'px';
    const newW = Math.round(r.w);
    const newH = Math.round(r.h);
    if (dom.overlayCanvas.width === newW && dom.overlayCanvas.height === newH
        && dom.overlayCanvas.style.left === newL && dom.overlayCanvas.style.top === newT) return false;
    dom.overlayCanvas.style.left = newL;
    dom.overlayCanvas.style.top = newT;
    dom.overlayCanvas.width = newW;
    dom.overlayCanvas.height = newH;
    return true;
}

export function log(msg) {
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    dom.logEl.appendChild(line);
    dom.logEl.scrollTop = dom.logEl.scrollHeight;
    console.log(msg);
}

// === Drawer toggle ===
export function toggleDrawer() {
    state.drawerOpen = !state.drawerOpen;
    dom.drawer.classList.toggle('open', state.drawerOpen);
    dom.drawerOverlay.classList.toggle('visible', state.drawerOpen);
}

// === Panel toggle (drawer sections) ===
export function togglePanel(id) {
    const body = document.getElementById(id);
    if (body) body.parentElement.classList.toggle('open');
}

// === Mode switching (Validate / Calibrate / Settings) ===
// enterCalibMode and exitCalibMode are injected from calibration.js to avoid circular imports
let _enterCalibMode = null;
let _exitCalibMode = null;

export function registerCalibCallbacks(enter, exit) {
    _enterCalibMode = enter;
    _exitCalibMode = exit;
}

export function switchMode(mode) {
    const prev = state.activeMode;
    if (prev === mode) return;

    // Exit calibrate if leaving that mode
    if (prev === 'calibrate' && _exitCalibMode) {
        _exitCalibMode();
        // Restore Full/ROI toggle
        dom.modeToggle.classList.add('visible');
    }

    state.activeMode = mode;

    // Toggle panels
    dom.panelValidate.classList.toggle('active', mode === 'validate');
    dom.panelCalibrate.classList.toggle('active', mode === 'calibrate');
    dom.panelSettings.classList.toggle('active', mode === 'settings');

    // Toggle mode-tab active states
    const tabs = dom.modeSelector.querySelectorAll('.mode-tab');
    tabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.mode === mode);
    });

    // Enter calibrate: force Full image, hide toggle
    if (mode === 'calibrate') {
        if (state.imageMode !== 'full') {
            switchImageMode('FULL');
        }
        dom.modeToggle.classList.remove('visible');
        if (_enterCalibMode) _enterCalibMode();
    }
}

// === Image mode switching (Full / ROI) ===
export function switchImageMode(mode) {
    // Immediate visual feedback
    dom.btnFull.classList.toggle('active', mode === 'FULL');
    dom.btnROI.classList.toggle('active', mode === 'ROI');
    state.imageMode = mode === 'FULL' ? 'full' : 'roi';
    // Send command to camera
    sendCommand(mode === 'FULL' ? 'SHOW_FULL_IMAGE' : 'SHOW_ROI');
}

// === Auto-detect image mode from actual frame dimensions ===
// Called after each frame loads. Updates toggle only when mode actually changes.
const FULL_WIDTH_THRESHOLD = 400; // full=640, ROI is significantly smaller

export function syncImageModeFromFrame() {
    const w = dom.cam.naturalWidth;
    if (!w) return;
    const detected = w >= FULL_WIDTH_THRESHOLD ? 'full' : 'roi';
    if (detected === state.imageMode) return; // no change
    state.imageMode = detected;
    dom.btnFull.classList.toggle('active', detected === 'full');
    dom.btnROI.classList.toggle('active', detected === 'roi');
}
