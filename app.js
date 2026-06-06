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
        dom.modeToggle.classList.remove('visible');
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
            document.getElementById('ble-btn').disabled = true;
            document.getElementById('ble-btn').textContent = 'Connecting...';
            const ok = await connectBLE();
            document.getElementById('ble-btn').disabled = false;
            if (ok) {
                document.getElementById('ble-btn').textContent = 'BLE Connect';
                await startBleSession();
            } else {
                document.getElementById('ble-btn').textContent = 'BLE Connect';
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
window.copyLogs = function() {
    const logEl = document.getElementById('log');
    const text = Array.from(logEl.children).map(l => l.textContent).join('\n');
    navigator.clipboard.writeText(text).then(() => {
        const btn = event.target;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 1500);
    }).catch(() => {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    });
};

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
