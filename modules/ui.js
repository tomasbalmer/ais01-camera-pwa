import { state } from './state.js';

// === DOM refs ===
export const dom = {
    cam: document.getElementById('cam'),
    stats: document.getElementById('stats'),
    statusDot: document.getElementById('status-dot'),
    message: document.getElementById('message'),
    logEl: document.getElementById('log'),
    actionBar: document.getElementById('action-bar'),
    connectScreen: document.getElementById('connect-screen'),
    drawer: document.getElementById('drawer'),
    drawerOverlay: document.getElementById('drawer-overlay'),
    overlayCanvas: document.getElementById('overlay-canvas'),
    overlayCtx: document.getElementById('overlay-canvas').getContext('2d'),
    calibBar: document.getElementById('calib-bar'),
    calibAiValue: document.getElementById('calib-ai-value'),
    calibAiConf: document.getElementById('calib-ai-conf'),
    konvaContainer: document.getElementById('konva-container'),
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
