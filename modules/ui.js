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
    calibCanvas: document.getElementById('calib-canvas'),
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

    /* Always log to drawer log */
    dom.logEl.appendChild(line);
    dom.logEl.scrollTop = dom.logEl.scrollHeight;

    /* Also log to setup-log panel if visible */
    const setupLog = document.getElementById('setup-log-content');
    if (setupLog && setupLog.offsetParent !== null) {
        const clone = line.cloneNode(true);
        /* Color device messages differently */
        if (msg.startsWith('[device]')) clone.style.color = '#4af';
        setupLog.appendChild(clone);
        setupLog.scrollTop = setupLog.scrollHeight;
    }

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
        /* modeToggle removed — Full/ROI now in Installation panel */
    }

    state.activeMode = mode;

    // Toggle panels
    dom.panelValidate.classList.toggle('active', mode === 'validate');
    dom.panelCalibrate.classList.toggle('active', mode === 'calibrate');
    dom.panelSettings.classList.toggle('active', mode === 'settings');

    // Update mode title + description
    const modeTitleEl = document.getElementById('mode-title-name');
    const modeDescEl = document.getElementById('mode-title-desc');
    if (modeTitleEl && modeDescEl) {
        const mkIcon = (path) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;"><path fill-rule="evenodd" clip-rule="evenodd" d="${path}" fill="currentColor"/></svg>`;
        const cameraIcon = mkIcon('M8.168 2.445A1 1 0 0 1 9 2h6a1 1 0 0 1 .832.445L17.535 5H21a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h3.465zM9.535 4 7.832 6.555A1 1 0 0 1 7 7H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-4a1 1 0 0 1-.832-.445L14.465 4zM12 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6m-5 3a5 5 0 1 1 10 0 5 5 0 0 1-10 0');
        const crosshairIcon = mkIcon('M3.055 11H6a1 1 0 1 1 0 2H3.055A9.004 9.004 0 0 0 11 20.945V18a1 1 0 1 1 2 0v2.945A9.004 9.004 0 0 0 20.945 13H18a1 1 0 1 1 0-2h2.945A9.004 9.004 0 0 0 13 3.055V6a1 1 0 1 1-2 0V3.055A9.004 9.004 0 0 0 3.055 11M1 12C1 5.925 5.925 1 12 1s11 4.925 11 11-4.925 11-11 11S1 18.075 1 12');
        const gearIcon = mkIcon('M12 2a1 1 0 0 0-1 1v.174a2.65 2.65 0 0 1-1.606 2.425 1 1 0 0 1-.264.073 2.65 2.65 0 0 1-2.73-.607l-.007-.008-.06-.06a1.003 1.003 0 0 0-1.415 0h-.001a1 1 0 0 0 0 1.415l.068.069a2.65 2.65 0 0 1 .542 2.894 2.65 2.65 0 0 1-2.414 1.705H3a1 1 0 0 0 0 2h.174a2.65 2.65 0 0 1 2.423 1.601 2.65 2.65 0 0 1-.532 2.918l-.008.008-.06.06a1.003 1.003 0 0 0-.217 1.09 1 1 0 0 0 .217.325v.001a.999.999 0 0 0 1.415 0l.069-.068a2.65 2.65 0 0 1 2.894-.543 2.65 2.65 0 0 1 1.705 2.415V21a1 1 0 0 0 2 0v-.174a2.65 2.65 0 0 1 1.601-2.423 2.65 2.65 0 0 1 2.918.532l.008.008.06.06a1.002 1.002 0 0 0 1.415 0h.001a1 1 0 0 0 0-1.416l-.068-.068a2.65 2.65 0 0 1-.532-2.918A2.65 2.65 0 0 1 20.906 13H21a1 1 0 0 0 0-2h-.174a2.65 2.65 0 0 1-2.425-1.606.999.999 0 0 1-.073-.264 2.65 2.65 0 0 1 .607-2.73l.008-.007.06-.06a1.002 1.002 0 0 0 0-1.415v-.001a1 1 0 0 0-1.416 0l-.068.068a2.65 2.65 0 0 1-2.918.532A2.65 2.65 0 0 1 13 3.094V3a1 1 0 0 0-1-1ZM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-4 2a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z');
        const step = (n, label) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;">
            <div style="width:22px;height:22px;border-radius:6px;border:1.5px solid rgba(56,189,248,0.3);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#38bdf8;">${n}</div>
            <div style="font-size:10px;color:#38bdf8;text-align:center;line-height:1.4;font-weight:500;">${label}</div></div>`;
        const arrow = '<div style="color:rgba(56,189,248,0.3);font-size:20px;align-self:center;margin-top:-8px;margin-left:-2px;margin-right:-2px;">›</div>';
        const calibSteps = `<div style="display:flex;align-items:flex-start;margin-top:13px;">
            ${step('1','Select No.<br>of Digits')}${arrow}${step('2','Set ROI<br>Region')}${arrow}${step('3','Apply<br>Calibration')}</div>`;
        const info = {
            validate:  ['Installation Mode', 'Position the camera over the water meter display'],
            calibrate: ['', calibSteps],
            settings:  ['Settings', 'Device configuration and advanced options'],
        };
        const [title, desc] = info[mode] || ['', ''];
        modeTitleEl.textContent = title;
        modeDescEl.innerHTML = desc;
    }

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
let userSelected = false;
export function resetImageModeSelection() { userSelected = false; }

export function switchImageMode(mode) {
    userSelected = true;
    dom.btnFull.classList.toggle('active', mode === 'FULL');
    dom.btnROI.classList.toggle('active', mode === 'ROI');
    state.imageMode = mode === 'FULL' ? 'full' : 'roi';
    sendCommand(mode === 'FULL' ? 'SHOW_FULL_IMAGE' : 'SHOW_ROI');
}

// Auto-detect only on first frames (before user touches the toggle)
const FULL_WIDTH_THRESHOLD = 400;

export function syncImageModeFromFrame() {
    if (userSelected) return;
    const w = dom.cam.naturalWidth;
    if (!w) return;
    const detected = w >= FULL_WIDTH_THRESHOLD ? 'full' : 'roi';
    if (detected === state.imageMode) return;
    state.imageMode = detected;
    dom.btnFull.classList.toggle('active', detected === 'full');
    dom.btnROI.classList.toggle('active', detected === 'roi');
}
