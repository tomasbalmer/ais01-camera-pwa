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
        dom.cam.style.display = 'none';
        dom.stats.className = '';
        dom.stats.textContent = 'Disconnected';
        dom.statusDot.classList.remove('connected');
        try { await state.device.close(); } catch (e) {}
        state.device = null;
        state.epOutNum = null;

        /* Show USB end-session panel */
        const chooser = document.getElementById('connect-chooser');
        const usbEnd = document.getElementById('usb-end-panel');
        const usbHint = document.getElementById('usb-hint');
        if (chooser) chooser.style.display = 'none';
        if (usbHint) usbHint.style.display = 'none';
        if (usbEnd) usbEnd.style.display = 'flex';
        dom.connectScreen.style.display = 'flex';

        document.getElementById('usb-end-copy').onclick = () => {
            const logEl = document.getElementById('log');
            const text = Array.from(logEl.children).map(l => l.textContent).join('\n');
            navigator.clipboard.writeText(text).then(() => {
                const btn = document.getElementById('usb-end-copy');
                btn.textContent = 'Copied!';
                setTimeout(() => btn.textContent = 'Copy logs', 1500);
            });
        };
        document.getElementById('usb-end-back').onclick = () => {
            if (usbEnd) usbEnd.style.display = 'none';
            if (chooser) chooser.style.display = 'flex';
        };
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

// === Mock modes (loaded only when ?mock is present) ===
{
    const params = new URLSearchParams(location.search);
    if (params.has('mock')) {
        const { runMockSetup, runMockCamera } = await import('./modules/mock.js');
        if (params.get('mock') === 'setup') runMockSetup();
        else runMockCamera();
    }
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
