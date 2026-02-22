import { state } from './modules/state.js';
import { dom, log, toggleDrawer, togglePanel } from './modules/ui.js';
import { sendCommand, onReadRegister, toggleRAW } from './modules/protocol.js';
import { connectDevice } from './modules/ftdi.js';
import { readStream } from './modules/stream.js';
import { onSendROI } from './modules/roi.js';
import { onValidatePosition } from './modules/validation.js';
import {
    enterCalibMode, exitCalibMode, previewRoi,
    computeAndSendRoi, onCalibDigitChange,
} from './modules/calibration.js';

// === Main connect/disconnect toggle ===
async function toggleConnection() {
    log('Button clicked');
    try {
        if (state.running) {
            state.running = false;
            dom.actionBar.classList.remove('visible');
            dom.connectScreen.style.display = 'flex';
            dom.cam.style.display = 'none';
            dom.stats.className = '';
            dom.stats.textContent = 'Disconnected';
            dom.statusDot.classList.remove('connected');
            // Reset button states
            document.getElementById('btnFullImg').classList.remove('active');
            document.getElementById('btnROI').classList.remove('active');
            document.getElementById('btnRAW').classList.remove('active');
            state.rawEnabled = false;
            if (state.calibMode) exitCalibMode();
            try { await state.device.close(); } catch (e) {}
            state.device = null;
            state.epOutNum = null;
            log('Disconnected');
        } else {
            document.getElementById('big-btn').disabled = true;
            document.getElementById('big-btn').textContent = 'Connecting...';
            const epIn = await connectDevice();
            document.getElementById('big-btn').disabled = false;
            document.getElementById('big-btn').textContent = 'Connect Camera';
            if (epIn) {
                readStream(epIn);
            }
        }
    } catch (err) {
        log('Error: ' + err.message);
        document.getElementById('big-btn').disabled = false;
        document.getElementById('big-btn').textContent = 'Connect Camera';
    }
}

// === Expose functions to inline onclick handlers ===
window.toggleConnection = toggleConnection;
window.toggleDrawer = toggleDrawer;
window.togglePanel = togglePanel;
window.sendCommand = sendCommand;
window.toggleRAW = toggleRAW;
window.onReadRegister = onReadRegister;
window.onSendROI = onSendROI;
window.onValidatePosition = onValidatePosition;
window.enterCalibMode = enterCalibMode;
window.exitCalibMode = exitCalibMode;
window.previewRoi = previewRoi;
window.computeAndSendRoi = computeAndSendRoi;
window.onCalibDigitChange = onCalibDigitChange;

// === Init check ===
const isSecure = window.isSecureContext;
const hasWebUSB = !!navigator.usb;
log(`Secure: ${isSecure} | WebUSB: ${hasWebUSB}`);
if (!isSecure || !hasWebUSB) {
    dom.message.innerHTML = !isSecure
        ? 'Requires HTTPS or localhost.'
        : 'WebUSB not available. Use Chrome on Android.';
    dom.message.className = 'error';
    document.getElementById('big-btn').disabled = true;
}
