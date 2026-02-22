import { state } from './modules/state.js';
import { dom, log, toggleDrawer, togglePanel, switchMode, switchImageMode } from './modules/ui.js';
import { adjustSensor, onAdvancedReadRegister, onWriteRegister } from './modules/protocol.js';
import { connectDevice } from './modules/ftdi.js';
import { readStream } from './modules/stream.js';
import { onValidatePosition } from './modules/validation.js';
import {
    enterCalibMode, exitCalibMode,
    computeAndSendRoi, onCalibDigitChange, toggleCalibCoords,
} from './modules/calibration.js';

// === Main connect/disconnect toggle ===
async function toggleConnection() {
    log('Button clicked');
    try {
        if (state.running) {
            state.running = false;
            // Hide connected UI elements
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
            if (state.calibMode) exitCalibMode();
            // Reset to validate mode
            state.activeMode = 'validate';
            dom.panelValidate.classList.add('active');
            dom.panelCalibrate.classList.remove('active');
            dom.panelSettings.classList.remove('active');
            const tabs = dom.modeSelector.querySelectorAll('.mode-tab');
            tabs.forEach(tab => {
                tab.classList.toggle('active', tab.dataset.mode === 'validate');
            });
            // Reset image mode state (will be re-detected from first frame)
            state.imageMode = null;
            dom.btnFull.classList.remove('active');
            dom.btnROI.classList.remove('active');
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
