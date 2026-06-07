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
    btnFull: document.getElementById('btnFullPanel'),
    btnROI: document.getElementById('btnROIPanel'),
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

    /* Log to drawer log */
    if (msg.startsWith('[device]')) line.style.color = '#4af';
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
        if (typeof window.hideCalibHint === 'function') window.hideCalibHint();
        if (typeof window.hideOverlayPickers === 'function') window.hideOverlayPickers();
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
        /* Step 1: digit boxes like a meter display */
        const digitsIcon = '<svg width="20" height="14" viewBox="0 0 30 14" fill="none"><rect x="0" y="0" width="4" height="14" rx="1" stroke="currentColor" stroke-width="1" fill="none"/><rect x="6.5" y="0" width="4" height="14" rx="1" stroke="currentColor" stroke-width="1" fill="none"/><rect x="13" y="0" width="4" height="14" rx="1" stroke="currentColor" stroke-width="1" fill="none"/><rect x="19.5" y="0" width="4" height="14" rx="1" stroke="currentColor" stroke-width="1" fill="none"/><rect x="26" y="0" width="4" height="14" rx="1" stroke="currentColor" stroke-width="1" fill="none"/></svg>';
        /* Step 2: digit boxes inside a selection/crosshair frame */
        const roiIcon = '<svg width="22" height="18" viewBox="0 0 34 22" fill="none"><path d="M1 5V1H5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M29 1H33V5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M33 17V21H29" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M5 21H1V17" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="7" y="4" width="4" height="14" rx="1" stroke="currentColor" stroke-width="0.8" fill="none" opacity="0.6"/><rect x="12.5" y="4" width="4" height="14" rx="1" stroke="currentColor" stroke-width="0.8" fill="none" opacity="0.6"/><rect x="18" y="4" width="4" height="14" rx="1" stroke="currentColor" stroke-width="0.8" fill="none" opacity="0.6"/><rect x="23.5" y="4" width="4" height="14" rx="1" stroke="currentColor" stroke-width="0.8" fill="none" opacity="0.6"/></svg>';
        /* Step 3: play/apply button */
        const applyIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M10 8L16 12L10 16Z" fill="currentColor"/></svg>';
        const arStep = (icon, label) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;" class="ar-text">
            <div style="width:28px;height:28px;border-radius:8px;border:1px solid rgba(56,189,248,0.25);display:flex;align-items:center;justify-content:center;color:#38bdf8;text-shadow:0 0 10px rgba(56,189,248,0.3);">${icon}</div>
            <div style="font-size:10px;color:rgba(56,189,248,0.7);text-align:center;line-height:1.4;font-weight:500;text-shadow:0 0 8px rgba(56,189,248,0.2);">${label}</div></div>`;
        const arArrow = '<div style="color:rgba(56,189,248,0.2);font-size:20px;align-self:center;margin-top:-8px;margin-left:-2px;margin-right:-2px;">›</div>';
        const calibDesc = `<div style="display:flex;align-items:flex-start;margin-top:10px;">
            ${arStep(digitsIcon,'Select Number<br>of Digits')}${arArrow}${arStep(roiIcon,'Set ROI<br>Region')}${arArrow}${arStep(applyIcon,'Apply<br>Calibration')}</div>`;
        /* Mount icon: device/probe outline pointing down */
        const mountIcon = '<svg width="18" height="20" viewBox="0 0 18 24" fill="none"><rect x="3" y="0" width="12" height="14" rx="3" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="9" cy="7" r="3" stroke="currentColor" stroke-width="1" fill="none"/><line x1="9" y1="14" x2="9" y2="20" stroke="currentColor" stroke-width="1.2"/><circle cx="9" cy="22" r="2" stroke="currentColor" stroke-width="1" fill="none"/></svg>';
        /* Meter icon: dial face with digits */
        const meterIcon = '<svg width="20" height="18" viewBox="0 0 24 20" fill="none"><circle cx="12" cy="10" r="9" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="5" y="7" width="3" height="6" rx="0.5" stroke="currentColor" stroke-width="0.8" fill="none"/><rect x="9" y="7" width="3" height="6" rx="0.5" stroke="currentColor" stroke-width="0.8" fill="none"/><rect x="13" y="7" width="3" height="6" rx="0.5" stroke="currentColor" stroke-width="0.8" fill="none"/><rect x="17" y="7" width="3" height="6" rx="0.5" stroke="currentColor" stroke-width="0.8" fill="none"/></svg>';
        const installDesc = `<div style="display:flex;align-items:flex-start;margin-top:10px;">
            ${arStep(mountIcon,'Position Mount<br>over Meter')}${arArrow}${arStep(meterIcon,'Align Camera<br>with Display')}</div>`;
        /* Settings icons */
        const brightnessIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.2" fill="none"/><line x1="12" y1="1" x2="12" y2="4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="12" y1="20" x2="12" y2="23" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="4.22" y1="4.22" x2="6.34" y2="6.34" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="17.66" y1="17.66" x2="19.78" y2="19.78" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="1" y1="12" x2="4" y2="12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="20" y1="12" x2="23" y2="12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="4.22" y1="19.78" x2="6.34" y2="17.66" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="17.66" y1="6.34" x2="19.78" y2="4.22" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
        const gainIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M2 20L8 14M8 14V18.5M8 14H3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 4L16 10M16 10V5.5M16 10H20.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        const speedIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="13" r="9" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M12 13L16 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="13" r="1.5" fill="currentColor"/><line x1="12" y1="2" x2="12" y2="4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
        const settingsDesc = `<div style="display:flex;align-items:flex-start;margin-top:10px;">
            ${arStep(brightnessIcon,'Brightness')}${arArrow}${arStep(gainIcon,'Max<br>Gain')}${arArrow}${arStep(speedIcon,'AE<br>Speed')}</div>`;
        const info = {
            validate:  ['Installation Mode', installDesc],
            calibrate: ['Calibration Mode', calibDesc],
            settings:  ['Adjust Camera Settings', settingsDesc],
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

    // Enter calibrate: force Full image
    if (mode === 'calibrate') {
        if (state.imageMode !== 'full') {
            switchImageMode('FULL');
        }
        if (_enterCalibMode) _enterCalibMode();
    }
}

// === Image mode switching (Full / ROI) ===
let userSelected = false;
export function resetImageModeSelection() { userSelected = false; }

export function switchImageMode(mode) {
    userSelected = true;
    const fullActive = mode === 'FULL';
    dom.btnFull.classList.toggle('active', fullActive);
    dom.btnROI.classList.toggle('active', !fullActive);
    dom.btnFull.style.borderColor = fullActive ? 'rgba(56,189,248,0.4)' : 'rgba(255,255,255,0.1)';
    dom.btnFull.style.color = fullActive ? '#38bdf8' : '#94a3b8';
    dom.btnFull.style.background = fullActive ? 'rgba(56,189,248,0.1)' : 'rgba(255,255,255,0.03)';
    dom.btnROI.style.borderColor = !fullActive ? 'rgba(56,189,248,0.4)' : 'rgba(255,255,255,0.1)';
    dom.btnROI.style.color = !fullActive ? '#38bdf8' : '#94a3b8';
    dom.btnROI.style.background = !fullActive ? 'rgba(56,189,248,0.1)' : 'rgba(255,255,255,0.03)';
    state.imageMode = mode === 'FULL' ? 'full' : 'roi';
    sendCommand(mode === 'FULL' ? 'SHOW_FULL_IMAGE' : 'SHOW_ROI');
}

// Auto-detect only on first frames (before user touches the toggle)
const FULL_WIDTH_THRESHOLD = 400;

export function syncImageModeFromFrame() {
    const w = dom.cam.naturalWidth;
    if (!w) return;
    const detected = w >= FULL_WIDTH_THRESHOLD ? 'full' : 'roi';
    if (userSelected) return;
    if (detected === state.imageMode) return;
    state.imageMode = detected;
    const fullActive = detected === 'full';
    dom.btnFull.classList.toggle('active', fullActive);
    dom.btnROI.classList.toggle('active', !fullActive);
    dom.btnFull.style.borderColor = fullActive ? 'rgba(56,189,248,0.4)' : 'rgba(255,255,255,0.1)';
    dom.btnFull.style.color = fullActive ? '#38bdf8' : '#94a3b8';
    dom.btnFull.style.background = fullActive ? 'rgba(56,189,248,0.1)' : 'rgba(255,255,255,0.03)';
    dom.btnROI.style.borderColor = !fullActive ? 'rgba(56,189,248,0.4)' : 'rgba(255,255,255,0.1)';
    dom.btnROI.style.color = !fullActive ? '#38bdf8' : '#94a3b8';
    dom.btnROI.style.background = !fullActive ? 'rgba(56,189,248,0.1)' : 'rgba(255,255,255,0.03)';
}
