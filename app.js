// === FTDI FT230X constants (matching D2XX driver) ===
const FTDI_VID = 0x0403;
const FTDI_PID = 0x6015;
const FTDI_BAUD = 921600;
const SIO_RESET = 0x00;
const SIO_SET_MODEM_CTRL = 0x01;
const SIO_SET_FLOW_CTRL = 0x02;
const SIO_SET_BAUD_RATE = 0x03;
const SIO_SET_DATA = 0x04;
const SIO_SET_LATENCY_TIMER = 0x09;

// === Himax / AIS01-LB sensor commands (C0 5A protocol) ===
const CMDS = {
    START:           [0xC0, 0x5A, 0x03, 0x04, 0x00, 0x00, 0x00],
    SEND:            [0xC0, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x01],
    ENABLE_RAW:      [0xC0, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x02],
    DISABLE_RAW:     [0xC0, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x03],
    SHOW_ROI:        [0xC0, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x05],
    SHOW_FULL_IMAGE: [0xC0, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x04],
};

// === State ===
let device = null;
let epOutNum = null;
let running = false;
let rawEnabled = false;
let frameCount = 0;
let fpsCount = 0;
let lastFpsTime = 0;
let currentFps = 0;
let lastAiResult = null;
let drawerOpen = false;
let freezeStream = false;

// Calibration state
let calibMode = false;
let calibRect = null;      // {x1, y1, x2, y2} in canvas coords
let calibDigits = 6;
let calibDragging = false;
let calibStartPt = null;

// === DOM refs ===
const cam = document.getElementById('cam');
const stats = document.getElementById('stats');
const statusDot = document.getElementById('status-dot');
const message = document.getElementById('message');
const logEl = document.getElementById('log');
const actionBar = document.getElementById('action-bar');
const connectScreen = document.getElementById('connect-screen');
const drawer = document.getElementById('drawer');
const drawerOverlay = document.getElementById('drawer-overlay');
const overlayCanvas = document.getElementById('overlay-canvas');
const overlayCtx = overlayCanvas.getContext('2d');

// === Image rect helper (accounts for object-fit:contain letterbox) ===
function getImageRect() {
    const imgW = cam.naturalWidth || 640;
    const imgH = cam.naturalHeight || 480;
    const boxW = cam.clientWidth;
    const boxH = cam.clientHeight;
    const scale = Math.min(boxW / imgW, boxH / imgH);
    const w = imgW * scale;
    const h = imgH * scale;
    const ox = (boxW - w) / 2;
    const oy = (boxH - h) / 2;
    return { ox, oy, w, h, scale };
}

function syncOverlay() {
    const r = getImageRect();
    overlayCanvas.style.left = (cam.offsetLeft + r.ox) + 'px';
    overlayCanvas.style.top = (cam.offsetTop + r.oy) + 'px';
    overlayCanvas.width = r.w;
    overlayCanvas.height = r.h;
}

function log(msg) {
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    console.log(msg);
}

// === Drawer toggle ===
function toggleDrawer() {
    drawerOpen = !drawerOpen;
    drawer.classList.toggle('open', drawerOpen);
    drawerOverlay.classList.toggle('visible', drawerOpen);
}

// === Panel toggle (drawer sections) ===
function togglePanel(id) {
    const body = document.getElementById(id);
    if (body) body.parentElement.classList.toggle('open');
}

// === Send raw bytes to sensor via FTDI UART TX ===
async function sendRawBytes(bytes) {
    if (!device || !epOutNum) { log('Not connected'); return; }
    const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    log(`TX → ${hex}`);
    try {
        const result = await device.transferOut(epOutNum, new Uint8Array(bytes));
        log(`TX OK: ${result.bytesWritten} bytes`);
    } catch (err) {
        log(`TX ERROR: ${err.message}`);
    }
}

// === Send named command to sensor ===
async function sendCommand(name) {
    const cmd = CMDS[name];
    if (!cmd) { log(`Unknown command: ${name}`); return; }
    log(`CMD: ${name}`);
    await sendRawBytes(cmd);

    if (name === 'SHOW_FULL_IMAGE') {
        document.getElementById('btnFullImg').classList.add('active');
        document.getElementById('btnROI').classList.remove('active');
    } else if (name === 'SHOW_ROI') {
        document.getElementById('btnROI').classList.add('active');
        document.getElementById('btnFullImg').classList.remove('active');
    }
}

// === Register Read ===
async function readRegister(addr) {
    const cmd = [0xC0, 0x5A, 0x04, 0x09, 0x00, addr & 0xFF, 0x00];
    log(`READ REG 0x${addr.toString(16).padStart(2, '0')}`);
    await sendRawBytes(cmd);
}

function onReadRegister() {
    const addrStr = document.getElementById('regAddr').value.trim();
    const addr = addrStr.startsWith('0x') ? parseInt(addrStr, 16) : parseInt(addrStr, 10);
    if (isNaN(addr) || addr < 0 || addr > 0xFF) { log('Invalid address'); return; }
    readRegister(addr);
}

// === AI Result Parser ===
function parseAiResult(bytes) {
    const buf = new ArrayBuffer(11);
    const view = new DataView(buf);
    for (let i = 0; i < 11; i++) view.setUint8(i, bytes[i]);
    return {
        integer: view.getUint32(0, true),
        decimal: view.getUint32(4, true),
        confidence: view.getUint16(8, true),
        flags: view.getUint8(10),
    };
}

// === ROI Configuration (Digit Wheel) ===
function buildRoiPayload(config) {
    const payload = new Uint8Array(80);
    const view = new DataView(payload.buffer);
    let offset = 0;
    for (let i = 0; i < 8; i++) {
        const pt = config.digits[i] || { x: 0, y: 0 };
        view.setUint16(offset, pt.x, true); offset += 2;
        view.setUint16(offset, pt.y, true); offset += 2;
    }
    view.setUint16(offset, config.numDigits, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    offset += 8;
    offset += 32;
    view.setUint16(offset, config.boundaryX, true); offset += 2;
    view.setUint16(offset, config.boundaryY, true); offset += 2;
    return payload;
}

async function sendRoiConfig(config) {
    await sendRawBytes([0xC0, 0x5A, 0x03, 0x05, 0x00, 0x00, 0x50]);
    await new Promise(r => setTimeout(r, 50));
    const payload = buildRoiPayload(config);
    const frame = new Uint8Array(4 + payload.length);
    frame.set([0xC0, 0x5A, 0x03, 0x03]);
    frame.set(payload, 4);
    await sendRawBytes(Array.from(frame));
    log(`ROI sent: ${config.numDigits} digits`);
}

function onSendROI() {
    const numDigits = parseInt(document.getElementById('roiNumDigits').value) || 6;
    const digits = [];
    for (let i = 0; i < 8; i++) {
        const xEl = document.getElementById(`roiX${i}`);
        const yEl = document.getElementById(`roiY${i}`);
        digits.push({
            x: xEl ? parseInt(xEl.value) || 0 : 0,
            y: yEl ? parseInt(yEl.value) || 0 : 0,
        });
    }
    const boundaryX = parseInt(document.getElementById('roiBoundX').value) || 0;
    const boundaryY = parseInt(document.getElementById('roiBoundY').value) || 0;
    sendRoiConfig({ numDigits, digits, boundaryX, boundaryY });
}

async function toggleRAW() {
    rawEnabled = !rawEnabled;
    await sendCommand(rawEnabled ? 'ENABLE_RAW' : 'DISABLE_RAW');
    const btn = document.getElementById('btnRAW');
    btn.classList.toggle('active', rawEnabled);
}

// === FTDI baud rate divisor ===
function ftdiBaudDivisor(baudRate) {
    const baseClock = 3000000;
    const fracCode = [0, 3, 2, 4, 1, 5, 6, 7];
    if (baudRate >= baseClock) return { wValue: 0, wIndex: 0 };
    const divisor8 = Math.round((baseClock * 8) / baudRate);
    const intPart = Math.floor(divisor8 / 8);
    const fracPart = divisor8 % 8;
    const encoded = intPart | (fracCode[fracPart] << 14);
    const actualBaud = Math.round(baseClock / (intPart + fracPart / 8));
    log(`Baud: target=${baudRate} actual=${actualBaud} (${((actualBaud - baudRate) / baudRate * 100).toFixed(2)}% err)`);
    return { wValue: encoded & 0xFFFF, wIndex: (encoded >> 16) & 0xFFFF };
}

// === Connect to FTDI + initialize sensor ===
async function connectDevice() {
    try {
        log('Requesting USB device...');
        device = await navigator.usb.requestDevice({
            filters: [{ vendorId: FTDI_VID, productId: FTDI_PID }]
        });
        log(`Device: ${device.productName || 'FTDI'}`);

        await device.open();
        if (device.configuration === null) await device.selectConfiguration(1);
        await device.claimInterface(0);

        const idx = 0;

        // 1. FT_ResetDevice
        await device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_RESET, value: 0, index: idx });
        log('FTDI: reset OK');

        // 2. FT_SetBaudRate(921600)
        const { wValue, wIndex } = ftdiBaudDivisor(FTDI_BAUD);
        await device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_SET_BAUD_RATE, value: wValue, index: wIndex });

        // 3. FT_SetDataCharacteristics(8, 0, 0) → 8N1
        await device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_SET_DATA, value: 0x0008, index: idx });

        // 4. FT_SetFlowControl(NONE)
        await device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_SET_FLOW_CTRL, value: 0, index: idx });

        // 5. FT_Purge(RX | TX)
        await device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_RESET, value: 1, index: idx });
        await device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_RESET, value: 2, index: idx });
        log('FTDI: purge RX+TX OK');

        // 6. FT_SetLatencyTimer(1)
        await device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_SET_LATENCY_TIMER, value: 1, index: idx });
        log('FTDI: latency=1ms');

        // 7. FT_SetDtr
        await device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_SET_MODEM_CTRL, value: 0x0101, index: idx });

        // 8. FT_SetRts
        await device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_SET_MODEM_CTRL, value: 0x0202, index: idx });
        log('FTDI: DTR=1 RTS=1');

        log('FTDI configured (D2XX sequence)');

        // Find endpoints
        const alt = device.configuration.interfaces[0].alternates[0];
        const epIn = alt.endpoints.find(e => e.direction === 'in');
        const epOut = alt.endpoints.find(e => e.direction === 'out');
        epOutNum = epOut ? epOut.endpointNumber : null;
        log(`Endpoints: IN=${epIn?.endpointNumber} OUT=${epOutNum}`);

        if (!epOutNum) log('WARNING: No OUT endpoint');

        // Initialize sensor: Start + request full image stream
        await sendCommand('START');
        await new Promise(r => setTimeout(r, 200));
        await sendCommand('SEND');
        await new Promise(r => setTimeout(r, 100));
        await sendRawBytes(CMDS.SHOW_FULL_IMAGE);
        log('Sensor initialized — streaming full image');

        return epIn;

    } catch (err) {
        if (err.name === 'NotFoundError') {
            message.innerHTML = 'No FTDI device selected.';
        } else {
            message.innerHTML = `Error: ${err.message}`;
        }
        message.className = 'error';
        log(`Error: ${err.message}`);
        return null;
    }
}

// === Read stream and extract JPEG frames ===
async function readStream(epIn) {
    let accumulator = [];
    let totalBytes = 0;
    const pktSz = epIn.packetSize || 64;

    running = true;
    connectScreen.style.display = 'none';
    actionBar.classList.add('visible');
    cam.style.display = 'block';
    stats.className = 'active';
    statusDot.classList.add('connected');
    lastFpsTime = performance.now();
    fpsCount = 0;

    log(`Streaming from EP${epIn.endpointNumber} (pkt=${pktSz})`);

    while (running) {
        try {
            const result = await device.transferIn(epIn.endpointNumber, 4096);
            if (result.status !== 'ok' || !result.data || result.data.byteLength <= 2) continue;

            const raw = new Uint8Array(result.data.buffer);
            const cleaned = stripFtdiHeaders(raw, pktSz);
            totalBytes += cleaned.length;

            for (let i = 0; i < cleaned.length; i++) accumulator.push(cleaned[i]);
            extractAndDisplayFrames(accumulator);

            const now = performance.now();
            if (now - lastFpsTime >= 1000) {
                currentFps = fpsCount / ((now - lastFpsTime) / 1000);
                fpsCount = 0;
                lastFpsTime = now;
                let aiText = '';
                if (lastAiResult) {
                    const reading = lastAiResult.integer + lastAiResult.decimal / 1000000;
                    aiText = ` | AI: ${reading.toFixed(2)} (${lastAiResult.confidence}%)`;
                }
                stats.textContent = `#${frameCount} | ${currentFps.toFixed(1)} fps | ${(totalBytes / 1024).toFixed(0)} KB${aiText}`;
            }
        } catch (err) {
            if (running) {
                log(`Read err: ${err.message}`);
                await new Promise(r => setTimeout(r, 100));
            }
        }
    }
}

function stripFtdiHeaders(data, pktSz) {
    const result = [];
    if (data.length <= 2) return new Uint8Array(0);
    for (let i = 0; i < data.length; i += pktSz) {
        const end = Math.min(i + pktSz, data.length);
        for (let j = i + 2; j < end; j++) result.push(data[j]);
    }
    return new Uint8Array(result);
}

function extractAndDisplayFrames(acc) {
    while (true) {
        let soi = -1;
        for (let i = 0; i < acc.length - 1; i++) {
            if (acc[i] === 0xFF && acc[i + 1] === 0xD8) { soi = i; break; }
        }
        if (soi === -1) { if (acc.length > 1) acc.splice(0, acc.length - 1); return; }
        if (soi > 0) acc.splice(0, soi);

        let eoi = -1;
        for (let i = 2; i < acc.length - 1; i++) {
            if (acc[i] === 0xFF && acc[i + 1] === 0xD9) { eoi = i; break; }
        }
        if (eoi === -1) return;

        const jpeg = new Uint8Array(acc.slice(0, eoi + 2));
        if (acc.length >= eoi + 2 + 11) {
            const aiBytes = acc.slice(eoi + 2, eoi + 2 + 11);
            lastAiResult = parseAiResult(aiBytes);
            acc.splice(0, eoi + 2 + 11);
        } else {
            acc.splice(0, eoi + 2);
        }

        if (!freezeStream) {
            const blob = new Blob([jpeg], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            const prev = cam.src;
            cam.onload = () => { if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev); };
            cam.src = url;
        }
        frameCount++;
        fpsCount++;

        if (frameCount === 1) {
            log(`First frame: ${jpeg.length} bytes`);
        }
    }
}

// === Main connect/disconnect toggle ===
async function toggleConnection() {
    log('Button clicked');
    try {
        if (running) {
            running = false;
            actionBar.classList.remove('visible');
            connectScreen.style.display = 'flex';
            cam.style.display = 'none';
            stats.className = '';
            stats.textContent = 'Disconnected';
            statusDot.classList.remove('connected');
            // Reset button states
            document.getElementById('btnFullImg').classList.remove('active');
            document.getElementById('btnROI').classList.remove('active');
            document.getElementById('btnRAW').classList.remove('active');
            rawEnabled = false;
            if (calibMode) exitCalibMode();
            try { await device.close(); } catch (e) {}
            device = null;
            epOutNum = null;
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

// === Position Validation ===
function analyzeFrame() {
    const c = document.createElement('canvas');
    c.width = cam.naturalWidth || 640;
    c.height = cam.naturalHeight || 480;
    const ctx = c.getContext('2d');
    ctx.drawImage(cam, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const W = c.width, H = c.height;

    let sum = 0, sumSq = 0, cnt = 0, saturated = 0, totalPx = 0;
    let gradSum = 0, gradCnt = 0;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const v = data[i];
            totalPx++;
            if (v > 240) saturated++;
            const inCenter = x > W * 0.2 && x < W * 0.8 && y > H * 0.2 && y < H * 0.8;
            if (inCenter) {
                sum += v; sumSq += v * v; cnt++;
                if (x < W * 0.8 - 1) {
                    const next = data[(y * W + x + 1) * 4];
                    gradSum += Math.abs(next - v);
                    gradCnt++;
                }
            }
        }
    }
    const brightness = cnt ? sum / cnt : 0;
    const variance = cnt ? (sumSq / cnt) - (brightness * brightness) : 0;
    const contrast = Math.sqrt(Math.max(0, variance));
    const flashPct = totalPx ? (saturated / totalPx) * 100 : 0;
    const edgeStrength = gradCnt ? gradSum / gradCnt : 0;

    return { brightness, contrast, flashPct, edgeStrength };
}

function showValidationOverlay(r) {
    syncOverlay();
    overlayCanvas.classList.add('active');
    const ctx = overlayCtx;
    const W = overlayCanvas.width, H = overlayCanvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, W, H);

    const checks = [
        { label: 'Brightness', val: r.brightness.toFixed(0), ok: r.brightness > 40 && r.brightness < 180 },
        { label: 'Flash glare', val: r.flashPct.toFixed(1) + '%', ok: r.flashPct < 10 },
        { label: 'Contrast', val: r.contrast.toFixed(0), ok: r.contrast > 20 },
        { label: 'Edge detail', val: r.edgeStrength.toFixed(1), ok: r.edgeStrength > 3 },
    ];

    const lineH = 36;
    const startY = (H - checks.length * lineH) / 2;
    ctx.font = '14px -apple-system, sans-serif';
    ctx.textAlign = 'left';

    checks.forEach((c, i) => {
        const y = startY + i * lineH;
        const icon = c.ok ? '\u2705' : '\u26A0\uFE0F';
        ctx.fillStyle = c.ok ? '#4ade80' : '#fbbf24';
        ctx.fillText(`${icon}  ${c.label}: ${c.val}`, 20, y + 20);
    });

    setTimeout(() => { overlayCanvas.classList.remove('active'); ctx.clearRect(0, 0, W, H); }, 4000);
}

function onValidatePosition() {
    if (!cam.src || cam.style.display === 'none') { log('No frame to analyze'); return; }
    const results = analyzeFrame();
    log(`Validate: brightness=${results.brightness.toFixed(0)} contrast=${results.contrast.toFixed(0)} flash=${results.flashPct.toFixed(1)}% edges=${results.edgeStrength.toFixed(1)}`);
    showValidationOverlay(results);
    if (drawerOpen) toggleDrawer();
}

// === Touch Calibration ===
function enterCalibMode() {
    if (!cam.src || cam.style.display === 'none') { log('No frame'); return; }
    calibMode = true;
    calibRect = null;
    freezeStream = true;
    syncOverlay();
    overlayCanvas.classList.add('active');
    document.getElementById('calib-toolbar').style.display = 'flex';
    if (drawerOpen) toggleDrawer();
    drawCalibOverlay();
    log('Calibration mode ON');
}

function exitCalibMode() {
    calibMode = false;
    calibRect = null;
    freezeStream = false;
    overlayCanvas.classList.remove('active');
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    document.getElementById('calib-toolbar').style.display = 'none';
    log('Calibration mode OFF');
}

function drawCalibOverlay() {
    const W = overlayCanvas.width, H = overlayCanvas.height;
    const ctx = overlayCtx;
    ctx.clearRect(0, 0, W, H);

    if (!calibRect) {
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#fff';
        ctx.font = '14px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Draw a rectangle over the digits', W / 2, H / 2);
        return;
    }

    const { x1, y1, x2, y2 } = calibRect;
    const n = calibDigits;
    const dw = (x2 - x1) / n;

    // Dim outside selection
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, W, y1);
    ctx.fillRect(0, y2, W, H - y2);
    ctx.fillRect(0, y1, x1, y2 - y1);
    ctx.fillRect(x2, y1, W - x2, y2 - y1);

    // Sub-rectangles
    for (let i = 0; i < n; i++) {
        const sx = x1 + dw * i;
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sx, y1, dw, y2 - y1);
        // Center dot
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(sx + dw / 2, (y1 + y2) / 2, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    // Outer rectangle
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
}

function computeAndSendRoi() {
    if (!calibRect) { log('No rectangle drawn'); return; }
    const { w, h, scale } = getImageRect();
    const sx1 = Math.round(calibRect.x1 / scale);
    const sy1 = Math.round(calibRect.y1 / scale);
    const sx2 = Math.round(calibRect.x2 / scale);
    const sy2 = Math.round(calibRect.y2 / scale);

    const n = calibDigits;
    const dw = (sx2 - sx1) / n;
    const cy = Math.round((sy1 + sy2) / 2);

    const digits = [];
    for (let i = 0; i < 8; i++) {
        if (i < n) {
            digits.push({ x: Math.round(sx1 + dw * i + dw / 2), y: cy });
        } else {
            digits.push({ x: 0, y: 0 });
        }
    }

    const boundaryX = Math.round(dw);
    const boundaryY = Math.round(sy2 - sy1);

    log(`ROI from touch: ${n} digits, boundary=${boundaryX}x${boundaryY}`);
    digits.slice(0, n).forEach((d, i) => log(`  D${i+1}: (${d.x}, ${d.y})`));

    sendRoiConfig({ numDigits: n, digits, boundaryX, boundaryY });

    // Update manual ROI inputs in the drawer
    document.getElementById('roiNumDigits').value = n;
    for (let i = 0; i < 8; i++) {
        const xEl = document.getElementById(`roiX${i}`);
        const yEl = document.getElementById(`roiY${i}`);
        if (xEl) xEl.value = digits[i].x;
        if (yEl) yEl.value = digits[i].y;
    }
    document.getElementById('roiBoundX').value = boundaryX;
    document.getElementById('roiBoundY').value = boundaryY;

    exitCalibMode();
}

// Touch event handlers for calibration
overlayCanvas.addEventListener('touchstart', (e) => {
    if (!calibMode) return;
    e.preventDefault();
    const t = e.touches[0];
    const rect = overlayCanvas.getBoundingClientRect();
    calibStartPt = { x: t.clientX - rect.left, y: t.clientY - rect.top };
    calibDragging = true;
    calibRect = null;
}, { passive: false });

overlayCanvas.addEventListener('touchmove', (e) => {
    if (!calibDragging) return;
    e.preventDefault();
    const t = e.touches[0];
    const rect = overlayCanvas.getBoundingClientRect();
    const x = t.clientX - rect.left;
    const y = t.clientY - rect.top;
    calibRect = {
        x1: Math.min(calibStartPt.x, x), y1: Math.min(calibStartPt.y, y),
        x2: Math.max(calibStartPt.x, x), y2: Math.max(calibStartPt.y, y),
    };
    drawCalibOverlay();
}, { passive: false });

overlayCanvas.addEventListener('touchend', () => {
    calibDragging = false;
    if (calibRect) drawCalibOverlay();
});

// === Init check ===
const isSecure = window.isSecureContext;
const hasWebUSB = !!navigator.usb;
log(`Secure: ${isSecure} | WebUSB: ${hasWebUSB}`);
if (!isSecure || !hasWebUSB) {
    message.innerHTML = !isSecure
        ? 'Requires HTTPS or localhost.'
        : 'WebUSB not available. Use Chrome on Android.';
    message.className = 'error';
    document.getElementById('big-btn').disabled = true;
}
