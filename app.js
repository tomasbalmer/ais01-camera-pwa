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
        dom.modeHint.style.display = 'none';
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
            document.getElementById('big-btn').disabled = true;
            document.getElementById('big-btn').textContent = 'Connecting...';
            const epIn = await connectDevice();
            document.getElementById('big-btn').disabled = false;
            document.getElementById('big-btn').textContent = 'USB Camera';
            if (epIn) {
                readStream(epIn);
            }
        }
    } catch (err) {
        log('Error: ' + err.message);
        document.getElementById('big-btn').disabled = false;
        document.getElementById('big-btn').textContent = 'USB Camera';
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

    const current = parseInt(document.getElementById('digit-label').textContent) || 6;
    const options = document.getElementById('digit-options');
    const preview = document.getElementById('digit-preview');
    options.innerHTML = '';

    [4, 5, 6, 7, 8].forEach(n => {
        const btn = document.createElement('button');
        btn.textContent = n;
        const isActive = n === current;
        btn.style.cssText = `width:36px;height:36px;border-radius:6px;border:2px solid ${isActive ? '#38bdf8' : '#334155'};background:${isActive ? 'rgba(56,189,248,0.15)' : 'transparent'};color:${isActive ? '#38bdf8' : '#64748b'};font-size:16px;font-weight:700;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;`;
        btn.onclick = () => {
            document.getElementById('digit-boxes').textContent = '▪'.repeat(n);
            document.getElementById('digit-label').textContent = 'of Digits';
            onCalibDigitChange(n);
            picker.style.display = 'none';
            highlightBtn('btn-digit-picker', false);
        };
        options.appendChild(btn);
    });

    preview.textContent = '▪'.repeat(current);
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
window.hideOverlayPickers = function() {
    const dp = document.getElementById('digit-picker');
    const cp = document.getElementById('confirm-picker');
    const co = document.getElementById('coords-picker');
    if (dp) dp.style.display = 'none';
    if (cp) cp.style.display = 'none';
    if (co) co.style.display = 'none';
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

    // Simulate setup steps with delays
    const { setStep, setAnim, setTitle, setInstruction } = await import('./modules/ble.js').then(() => import('./modules/ui.js')).catch(() => ({}));
    const ss = (id, s) => { const el = document.getElementById(id); if (el) { el.classList.remove('active','done'); if (s==='done') { el.classList.add('done'); el.querySelector('.step-icon').textContent='✓'; } else if (s==='active') { el.classList.add('active'); el.querySelector('.step-icon').textContent='●'; } } };
    const title = (t) => { const el = document.getElementById('setup-title'); if (el) el.textContent = t; };
    const instr = (t) => { const el = document.getElementById('setup-instruction'); if (el) el.textContent = t; };
    const anim = document.getElementById('setup-anim');

    // Simulate the flow
    ss('step-ble', 'done');
    ss('step-reconnect', 'active');
    title('Waiting for Device');
    instr('Press RESET on the device');
    if (anim) { anim.style.fontSize='24px'; anim.style.letterSpacing='8px'; anim.style.color='#38bdf8'; anim.innerHTML='<span class="dot">●</span><span class="dot">●</span><span class="dot">●</span>'; }

    const mockLog = (msg) => log(msg);
    mockLog('BLE connected');
    setTimeout(() => { mockLog('GATT disconnected — reconnecting in 1s...'); }, 1000);
    setTimeout(() => { mockLog('GATT connected'); ss('step-reconnect', 'done'); ss('step-firmware', 'active'); title('Device Connected'); instr('Waiting for firmware...'); }, 2500);
    setTimeout(() => { mockLog('[device] ========================================'); mockLog('[device] AIS01-CB Custom Firmware v0.9.0'); mockLog('[device] ========================================'); }, 4000);
    setTimeout(() => { mockLog('[device] [MAIN] AT command window (30s)...'); ss('step-firmware', 'done'); ss('step-install', 'active'); title('Firmware Ready'); instr('Sending install command...'); if(anim){anim.textContent='●';anim.style.fontSize='32px';anim.style.letterSpacing='0';anim.style.color='#22c55e';} }, 5000);
    setTimeout(() => { mockLog('Sent: AT+INSTALL'); mockLog('[device] Entering installation mode...'); ss('step-install', 'done'); ss('step-camera-init', 'active'); title('Calibration Mode'); instr('Powering on camera...'); }, 6500);
    setTimeout(() => { mockLog('[device] [CAM] Power ON complete'); ss('step-camera-init', 'done'); ss('step-camera', 'active'); instr('Waiting for first frame...'); }, 8000);
    setTimeout(() => { mockLog('First BLE frame: 2930 bytes'); mockLog('Camera streaming'); ss('step-camera', 'done'); title('Camera Active'); instr('Streaming'); }, 9500);

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
