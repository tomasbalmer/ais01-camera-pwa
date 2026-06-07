import { state } from './modules/state.js';
import { dom, log, toggleDrawer, togglePanel, switchMode, switchImageMode, resetImageModeSelection } from './modules/ui.js';
import { adjustSensor, onAdvancedReadRegister, onWriteRegister } from './modules/protocol.js';
import { connectDevice } from './modules/ftdi.js';
import { readStream } from './modules/stream.js';
import { onValidatePosition } from './modules/validation.js';
import {
    enterCalibMode, exitCalibMode,
    computeAndSendRoi, onCalibDigitChange, toggleCalibCoords,
} from './modules/calibration.js';
import {
    connectBLE, startBleSession, stopBleSession, hasBluetooth,
    isBleConnected,
} from './modules/ble.js';
import { SETUP_STEPS } from './modules/constants.js';

// === Stop any active connection (USB or BLE) ===
async function stopConnection() {
    if (state.calibMode) exitCalibMode();

    if (isBleConnected()) {
        await stopBleSession();
    } else {
        state.running = false;
        dom.modeArea.classList.remove('visible');
        dom.modeSelector.classList.remove('visible');
        dom.btnStop.classList.remove('visible');
        const mt = document.getElementById('mode-title');
        if (mt) mt.style.display = 'none';
        if (typeof window.hideCalibHint === 'function') window.hideCalibHint();
        ['install-hint', 'settings-hint', 'calib-progress'].forEach(id => {
            const el = document.getElementById(id); if (el) el.style.display = 'none';
        });
        hideOverlayPickers();
        dom.connectScreen.style.display = 'flex';
        dom.cam.style.display = 'none';
        dom.stats.className = '';
        dom.stats.textContent = 'Disconnected';
        dom.statusDot.classList.remove('connected');
        try { await state.device.close(); } catch (e) {}
        state.device = null;
        state.epOutNum = null;
    }

    // Reset to validate mode
    state.activeMode = 'validate';
    dom.panelValidate.classList.add('active');
    dom.panelCalibrate.classList.remove('active');
    dom.panelSettings.classList.remove('active');
    const tabs = dom.modeSelector.querySelectorAll('.mode-tab');
    tabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.mode === 'validate');
    });
    state.imageMode = null;
    resetImageModeSelection();
    dom.btnFull.classList.remove('active');
    dom.btnROI.classList.remove('active');
    log('Disconnected');
}

// === USB connect/disconnect toggle ===
async function toggleConnection() {
    log('Button clicked');
    try {
        if (state.running) {
            await stopConnection();
        } else {
            /* Show USB hint behind Chrome's device chooser */
            document.getElementById('connect-chooser').style.display = 'none';
            const usbHint = document.getElementById('usb-hint');
            if (usbHint) usbHint.style.display = 'block';

            const epIn = await connectDevice();

            if (epIn) {
                if (usbHint) usbHint.style.display = 'none';
                readStream(epIn);
            } else {
                /* User cancelled or error — go back */
                if (usbHint) usbHint.style.display = 'none';
                document.getElementById('connect-chooser').style.display = 'flex';
            }
        }
    } catch (err) {
        log('Error: ' + err.message);
        const usbHint = document.getElementById('usb-hint');
        if (usbHint) usbHint.style.display = 'none';
        document.getElementById('connect-chooser').style.display = 'flex';
    }
}

// === BLE connect/disconnect ===
async function toggleBLE() {
    try {
        if (state.bleMode) {
            await stopConnection();
            document.getElementById('ble-btn').textContent = 'BLE Connect';
        } else {
            /* Show reset hint screen with SVG (behind Chrome's scan dialog) */
            document.getElementById('connect-chooser').style.display = 'none';
            const hint = document.getElementById('reset-hint');
            if (hint) hint.style.display = 'block';

            const ok = await connectBLE();

            if (ok) {
                if (hint) hint.style.display = 'none';
                await startBleSession();
            } else {
                /* User cancelled scan — go back */
                if (hint) hint.style.display = 'none';
                document.getElementById('connect-chooser').style.display = 'flex';
            }
        }
    } catch (err) {
        log('BLE Error: ' + err.message);
        document.getElementById('ble-btn').disabled = false;
        document.getElementById('ble-btn').textContent = 'BLE Connect';
    }
}

// === Expose functions to inline onclick handlers ===
window.bleSendAT = async (cmd) => { const { bleSendATCommand } = await import('./modules/ble.js'); await bleSendATCommand(cmd); };
window.toggleConnection = toggleConnection;
window.toggleBLE = toggleBLE;
window.stopConnection = stopConnection;
window.toggleDrawer = toggleDrawer;
window.togglePanel = togglePanel;
window.switchMode = switchMode;
window.switchImageMode = switchImageMode;
window.adjustSensor = adjustSensor;
window.onAdvancedReadRegister = onAdvancedReadRegister;
window.onWriteRegister = onWriteRegister;
window.onValidatePosition = onValidatePosition;
window.enterCalibMode = enterCalibMode;
window.exitCalibMode = exitCalibMode;
window.computeAndSendRoi = computeAndSendRoi;
window.onCalibDigitChange = onCalibDigitChange;
window.toggleCalibCoords = toggleCalibCoords;
function highlightBtn(id, on) {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (on) {
        btn.style.borderColor = 'rgba(56,189,248,0.4)';
        btn.style.background = 'rgba(56,189,248,0.1)';
        btn.style.color = '#38bdf8';
    } else {
        btn.style.borderColor = 'rgba(255,255,255,0.1)';
        btn.style.background = 'rgba(255,255,255,0.03)';
        btn.style.color = '#94a3b8';
    }
}
window.cycleDigits = function(e) {
    if (e) e.stopPropagation();
    const picker = document.getElementById('digit-picker');
    if (!picker) return;
    if (picker.style.display !== 'none') { picker.style.display = 'none'; highlightBtn('btn-digit-picker', false); return; }
    hideOverlayPickers();

    const current = state.calibDigits || 6;
    const options = document.getElementById('digit-options');
    options.innerHTML = '';

    [4, 5, 6, 7, 8].forEach(n => {
        const btn = document.createElement('button');
        btn.textContent = n;
        const isActive = n === current;
        btn.style.cssText = `width:36px;height:36px;border-radius:6px;border:2px solid ${isActive ? '#38bdf8' : '#334155'};background:${isActive ? 'rgba(56,189,248,0.15)' : 'transparent'};color:${isActive ? '#38bdf8' : '#64748b'};font-size:16px;font-weight:700;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;`;
        btn.onclick = () => {
            document.getElementById('digit-btn-label').textContent = n + ' Digits';
            onCalibDigitChange(n);
            picker.style.display = 'none';
            highlightBtn('btn-digit-picker', false);
            // Auto-show step 2 hint after digit selection
            setTimeout(() => {
                window.showCalibHint();
            }, 400);
        };
        options.appendChild(btn);
    });

    picker.style.display = 'block';
    highlightBtn('btn-digit-picker', true);
};
// === Close any open picker when tapping outside ===
document.addEventListener('click', () => {
    const pickers = ['digit-picker', 'coords-picker', 'confirm-picker'];
    pickers.forEach(id => {
        const el = document.getElementById(id);
        if (el && el.style.display !== 'none') el.style.display = 'none';
    });
    highlightBtn('btn-digit-picker', false);
    highlightBtn('btn-coords-picker', false);
    highlightBtn('btn-calibrate', false);
});
// Stop picker clicks from bubbling to the document listener
['digit-picker', 'coords-picker', 'confirm-picker'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', e => e.stopPropagation());
});

window.showCalibConfirm = function(e) {
    if (e) e.stopPropagation();
    const picker = document.getElementById('confirm-picker');
    if (!picker) return;
    hideOverlayPickers();

    picker.style.display = 'block';
    highlightBtn('btn-calibrate', true);
    document.getElementById('confirm-no').onclick = () => { picker.style.display = 'none'; highlightBtn('btn-calibrate', false); };
    document.getElementById('confirm-yes').onclick = () => {
        picker.style.display = 'none';
        highlightBtn('btn-calibrate', false);
        computeAndSendRoi();
    };
};
window.toggleCoordsPicker = function(e) {
    if (e) e.stopPropagation();
    const picker = document.getElementById('coords-picker');
    if (!picker) return;
    if (picker.style.display !== 'none') { picker.style.display = 'none'; highlightBtn('btn-coords-picker', false); return; }
    hideOverlayPickers();
    const src = document.getElementById('calib-coords');
    const dst = document.getElementById('coords-display');
    if (src && dst) dst.textContent = src.textContent || 'No coordinates yet';
    picker.style.display = 'block';
    highlightBtn('btn-coords-picker', true);
};
window.buildCalibHintSvg = function() {
    const n = state.calibDigits || 6;
    const cellW = 20;                 // digit cell width
    const cellH = 32;                 // digit cell height (taller than wide)
    const meterW = cellW * n;
    const meterH = cellH;
    const off = 2;                    // selector offset from meter (slight overlap)
    const pad = 14;                   // space for brackets
    const W = meterW + pad * 2;
    const H = meterH + pad * 2 + off;

    // Meter position (centered, slightly lower)
    const mX = pad, mY = pad + off;

    // Selector position (slightly up-left from meter)
    const sX = mX - off, sY = mY - off;
    const sW = meterW + off * 2, sH = meterH + off * 2;

    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;

    // ── Layer 1: Meter digit boxes (white outlines) ──
    svg += `<rect x="${mX}" y="${mY}" width="${meterW}" height="${meterH}" rx="1" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>`;
    const sampleDigits = '0012345678'.slice(0, n).split('');
    for (let i = 0; i < n; i++) {
        const lx = mX + cellW * (i + 1);
        const cx = mX + cellW * i + cellW / 2;
        const midY = mY + meterH / 2;
        if (i < n - 1) {
            svg += `<line x1="${lx}" y1="${mY}" x2="${lx}" y2="${mY + meterH}" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>`;
        }
        svg += `<text x="${cx}" y="${midY + 4}" text-anchor="middle" fill="rgba(255,255,255,0.35)" font-family="'SF Mono',Monaco,monospace" font-size="12">${sampleDigits[i]}</text>`;
    }

    // ── Layer 2: Calibration selector (blue, offset) ──
    // Brackets (┌ ┐ └ ┘) outside selector
    const bLen = 12, bGap = 4;
    const bl = sX - bGap, br = sX + sW + bGap, bt = sY - bGap, bb = sY + sH + bGap;
    svg += `<path d="M${bl} ${bt+bLen} L${bl} ${bt} L${bl+bLen} ${bt}" stroke="rgba(56,189,248,0.45)" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
    svg += `<path d="M${br-bLen} ${bt} L${br} ${bt} L${br} ${bt+bLen}" stroke="rgba(56,189,248,0.45)" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
    svg += `<path d="M${br} ${bb-bLen} L${br} ${bb} L${br-bLen} ${bb}" stroke="rgba(56,189,248,0.45)" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
    svg += `<path d="M${bl+bLen} ${bb} L${bl} ${bb} L${bl} ${bb-bLen}" stroke="rgba(56,189,248,0.45)" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;

    // Selector rectangle
    svg += `<rect x="${sX}" y="${sY}" width="${sW}" height="${sH}" rx="1" fill="rgba(56,189,248,0.04)" stroke="rgba(56,189,248,0.5)" stroke-width="1"/>`;

    // Selector dividers
    const sDw = sW / n;
    for (let i = 1; i < n; i++) {
        const lx = sX + sDw * i;
        svg += `<line x1="${lx}" y1="${sY}" x2="${lx}" y2="${sY + sH}" stroke="rgba(56,189,248,0.15)" stroke-width="0.5"/>`;
    }

    // Center dots in selector cells
    for (let i = 0; i < n; i++) {
        const cx = sX + sDw * i + sDw / 2;
        const cy = sY + sH / 2;
        svg += `<circle cx="${cx}" cy="${cy}" r="1.5" fill="rgba(56,189,248,0.25)"/>`;
    }

    // Calibration reference dots
    const refs = n === 4 ? [0, 0, 2, 4] : [0, 2, n - 2, n];
    for (const ref of refs) {
        const x = sX + (ref / n) * sW;
        svg += `<circle cx="${x}" cy="${sY}" r="3" fill="#38bdf8"/><circle cx="${x}" cy="${sY}" r="1.2" fill="#fff"/>`;
        svg += `<circle cx="${x}" cy="${sY + sH}" r="3" fill="#38bdf8"/><circle cx="${x}" cy="${sY + sH}" r="1.2" fill="#fff"/>`;
    }

    svg += '</svg>';

    const container = document.getElementById('calib-hint-svg');
    if (container) container.innerHTML = svg;
};

window.showCalibHint = function() {
    if (typeof window.buildCalibHintSvg === 'function') window.buildCalibHintSvg();
    const el = document.getElementById('calib-hint');
    if (el) el.style.display = 'block';
};
window.hideCalibHint = function() {
    const el = document.getElementById('calib-hint');
    if (el) el.style.display = 'none';
};
window.showCalibHintFromConfirm = function() {
    const confirm = document.getElementById('confirm-picker');
    if (confirm) confirm.style.display = 'none';
    highlightBtn('btn-calibrate', false);
    window.showCalibHint();
};
window.hideOverlayPickers = function() {
    const dp = document.getElementById('digit-picker');
    const cp = document.getElementById('confirm-picker');
    const co = document.getElementById('coords-picker');
    if (dp) dp.style.display = 'none';
    if (cp) cp.style.display = 'none';
    if (co) co.style.display = 'none';
    window.hideCalibHint();
    highlightBtn('btn-digit-picker', false);
    highlightBtn('btn-coords-picker', false);
};
window.toggleSetupLog = function() {
    const content = document.getElementById('setup-log-content');
    const btn = document.getElementById('btn-toggle-log');
    if (!content) return;
    if (content.style.display === 'none') {
        content.style.display = 'block';
        if (btn) btn.textContent = '▼';
    } else {
        content.style.display = 'none';
        if (btn) btn.textContent = '▶';
    }
};
window.copyCalibCoords = function() {
    const el = document.getElementById('calib-coords');
    const text = el ? el.innerText : '';
    navigator.clipboard.writeText(text).then(() => {
        const btn = event.target;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 1500);
    });
};
window.copySetupLogs = function() {
    const logEl = document.getElementById('setup-log-content');
    const text = logEl ? logEl.innerText : '';
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('btn-copy-log');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500); }
    });
};
window.toggleLogPanel = function() {
    const logEl = document.getElementById('log');
    const btn = document.getElementById('btn-minimize-log');
    if (!logEl) return;
    if (logEl.style.maxHeight === '45px') {
        logEl.style.maxHeight = '360px';
        if (btn) btn.textContent = '▾';
    } else {
        logEl.style.maxHeight = '45px';
        if (btn) btn.textContent = '▸';
    }
};
window.copyLogs = function(e) {
    const logEl = document.getElementById('log');
    const text = Array.from(logEl.children).map(l => l.textContent).join('\n');
    const btn = e && e.target ? e.target : null;
    navigator.clipboard.writeText(text).then(() => {
        if (btn) { btn.textContent = 'Copied!'; btn.style.background = '#22c55e'; btn.style.color = '#000'; setTimeout(() => { btn.textContent = 'Copy'; btn.style.background = '#374151'; btn.style.color = '#fff'; }, 1500); }
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500); }
    });
};

// === Clean up on page close — send AT+STOP to exit install mode ===
window.addEventListener('beforeunload', () => {
    if (isBleConnected()) {
        stopBleSession().catch(() => {});
    }
});

// === Mock setup mode: show BLE setup/connection flow ===
if (new URLSearchParams(location.search).get('mock') === 'setup') {
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

    // ── Mock helpers ──
    const checkSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
    const ss = (id, s) => { const el = document.getElementById(id); if (el) { el.classList.remove('active','done'); const icon = el.querySelector('.step-icon'); if (s==='done') { el.classList.add('done'); icon.innerHTML=checkSvg; } else if (s==='active') { el.classList.add('active'); icon.innerHTML=''; } else { icon.innerHTML=''; } } };
    const title = (t) => { const el = document.getElementById('setup-title'); if (el) el.textContent = t; };
    const instr = (t) => { const el = document.getElementById('setup-instruction'); if (el) el.textContent = t; };
    const ring = document.getElementById('setup-ring');
    const setRing = (s) => { if (ring) ring.setAttribute('data-state', s); };
    const mockLog = (msg) => log(msg);

    // Helper: apply step config from SETUP_STEPS
    const step = (idx, status) => {
        const s = SETUP_STEPS[idx];
        ss(s.id, status);
        const cfg = status === 'done' ? s.onDone : s.onActive;
        if (cfg) {
            if (cfg.title) title(cfg.title);
            if (cfg.instruction) instr(cfg.instruction);
            if (cfg.anim) setRing(cfg.anim);
        }
    };

    // Reconnect hint helpers
    const hintEl = document.getElementById('reconnect-hint');
    const hintAttempts = document.getElementById('reconnect-hint-attempts');
    const showHint = () => { if (hintEl) hintEl.style.display = 'flex'; };
    const hideHint = () => { if (hintEl) hintEl.style.display = 'none'; };

    // ── Simulate realistic device boot sequence ──

    // 0s — Step 1 done (BLE paired), Step 2 active (GATT connecting)
    step(0, 'done');
    step(1, 'active');
    mockLog('BLE connected');

    // 1-7s — GATT fails repeatedly, reconnect hint appears after attempt 4
    setTimeout(() => { mockLog('GATT connect failed (attempt 1)'); }, 1000);
    setTimeout(() => { mockLog('GATT connect failed (attempt 2)'); }, 3000);
    setTimeout(() => { mockLog('GATT connect failed (attempt 3)'); }, 5000);
    setTimeout(() => { mockLog('GATT connect failed (attempt 4)'); showHint(); }, 7000);
    setTimeout(() => { mockLog('GATT connect failed (attempt 5)'); showHint(); }, 9000);

    // 10s — GATT finally connects, hint disappears
    setTimeout(() => { mockLog('GATT connected'); hideHint(); }, 10000);

    // 11s — Step 2 done (first notification), Step 3 active (firmware booting)
    setTimeout(() => { mockLog('Device responding'); step(1, 'done'); step(2, 'active'); }, 11000);

    // 12s — Firmware banner
    setTimeout(() => {
        mockLog('[device] ========================================');
        mockLog('[device]   AIS01-CB Custom Firmware v0.9.0');
        mockLog('[device] ========================================');
    }, 12000);

    // 12.8s — Config loaded
    setTimeout(() => { mockLog('[device] [MAIN] Config loaded from EEPROM'); }, 12800);

    // 13.5s — Step 3 done (AT window), Step 4 active (calibration command)
    setTimeout(() => {
        mockLog('[device] [MAIN] AT command window (30s)...');
        step(2, 'done');
        step(3, 'active');
    }, 13500);

    // 14s — AT+INSTALL sent
    setTimeout(() => { mockLog('Firmware ready — sending AT+INSTALL'); mockLog('Sent: AT+INSTALL'); }, 14000);

    // 15s — Step 4 done (install ack), Step 5 active (camera powering on)
    setTimeout(() => {
        mockLog('[device] Entering installation mode...');
        mockLog('[device] ========================================');
        mockLog('[device]   INSTALLATION MODE');
        mockLog('[device] ========================================');
        step(3, 'done');
        step(4, 'active');
    }, 15000);

    // 15.5-16.3s — Camera init logs
    setTimeout(() => { mockLog('[device] [CAM] Power ON — init UART...'); }, 15500);
    setTimeout(() => { mockLog('[device] [CAM] UART OK — 5V on...'); }, 16000);
    setTimeout(() => { mockLog('[device] [CAM] 5V OK — delay 2s...'); }, 16300);

    // 18.3s — Step 5 done, Step 6 active (waiting for frame)
    setTimeout(() => {
        mockLog('[device] [CAM] Power ON complete');
        step(4, 'done');
        step(5, 'active');
    }, 18300);

    // 20s — Step 6 done (first frame = streaming)
    setTimeout(() => {
        mockLog('First BLE frame: 2930 bytes');
        mockLog('Camera streaming');
        step(5, 'done');
    }, 20000);

    // 20.5s — Skeleton transition
    setTimeout(() => {
        const setupPanel = document.getElementById('setup-panel');
        const skeleton = document.getElementById('skeleton-transition');
        if (setupPanel) setupPanel.style.display = 'none';
        if (skeleton) skeleton.style.display = 'flex';
    }, 20500);

    // 23s — Show camera UI
    setTimeout(() => {
        const skeleton = document.getElementById('skeleton-transition');
        if (skeleton) skeleton.style.display = 'none';
        dom.connectScreen.style.display = 'none';
        dom.cam.style.display = 'block';
        dom.cam.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect fill="#1a1a2e" width="640" height="480"/><circle cx="320" cy="200" r="120" fill="none" stroke="#334155" stroke-width="2"/><text x="320" y="190" text-anchor="middle" fill="#38bdf8" font-family="monospace" font-size="28">00000.00</text><text x="320" y="220" text-anchor="middle" fill="#475569" font-family="monospace" font-size="12">m³</text></svg>');
        dom.modeArea.classList.add('visible');
        dom.modeSelector.classList.add('visible');
        const mt = document.getElementById('mode-title');
        if (mt) mt.style.display = 'block';
        state.activeMode = null;
        switchMode('validate');
        dom.stats.textContent = 'Streaming';
    }, 23000);

    log('Mock setup mode — simulating BLE connection flow');
} else if (new URLSearchParams(location.search).has('mock')) {
    state.running = true;
    state.bleMode = true;
    state.bleCalibMode = true;
    dom.connectScreen.style.display = 'none';
    dom.cam.style.display = 'block';
    dom.cam.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect fill="#1a1a2e" width="640" height="480"/><circle cx="320" cy="200" r="120" fill="none" stroke="#334155" stroke-width="2"/><text x="320" y="190" text-anchor="middle" fill="#38bdf8" font-family="monospace" font-size="28">00000.00</text><text x="320" y="220" text-anchor="middle" fill="#475569" font-family="monospace" font-size="12">m³</text><text x="320" y="400" text-anchor="middle" fill="#334155" font-size="14">Mock — water meter</text></svg>');
    dom.statusDot.classList.add('connected');
    dom.btnStop.classList.add('visible');
    dom.modeArea.classList.add('visible');
    dom.modeSelector.classList.add('visible');
    const mt = document.getElementById('mode-title');
    if (mt) mt.style.display = 'block';
    state.activeMode = null;
    switchMode('validate');
    dom.stats.className = 'active';
    dom.stats.textContent = 'Mock mode';
    log('Mock mode — no BLE connection');
}

// === Init check ===
const isSecure = window.isSecureContext;
const hasWebUSB = !!navigator.usb;
const hasBLE = hasBluetooth();
log(`Secure: ${isSecure} | WebUSB: ${hasWebUSB} | BLE: ${hasBLE}`);
if (!isSecure) {
    dom.message.innerHTML = 'Requires HTTPS or localhost.';
    dom.message.className = 'error';
    document.getElementById('big-btn').disabled = true;
    document.getElementById('ble-btn').disabled = true;
} else {
    if (!hasWebUSB) document.getElementById('big-btn').disabled = true;
    if (!hasBLE) {
        document.getElementById('ble-btn').disabled = true;
    }
}
