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

// === Sensor resolution (ROI coords always in this space) ===
const SENSOR_W = 640, SENSOR_H = 480;

// Always 8 ROI points = 4 reference positions × 2 corners (top-left + bottom-left).
// The 4 references are evenly spaced from center of first digit to center of last digit.
// The firmware interpolates all digit locations from these 4 references + boundary.

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

// Calibration state
let calibMode = false;
let calibDigits = 6;
let calibAnimFrame = null;    // rAF handle

// Konva calibration objects
let konvaStage = null;
let konvaLayer = null;
let konvaRect = null;
let konvaTransformer = null;
let konvaDividers = null;     // Konva.Group for digit divider lines + dots

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
const calibBar = document.getElementById('calib-bar');
const calibAiValue = document.getElementById('calib-ai-value');
const calibAiConf = document.getElementById('calib-ai-conf');
const konvaContainer = document.getElementById('konva-container');

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

function clamp16(v) { return Math.max(0, Math.min(65535, Math.round(v))); }

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

    // Log decoded payload (boundary at offset 76/78 per buildRoiPayload layout)
    const pv = new DataView(payload.buffer);
    log('--- ROI PAYLOAD ---');
    for (let d = 0; d < 8; d++) {
        const px = pv.getUint16(d * 4, true);
        const py = pv.getUint16(d * 4 + 2, true);
        log('  P' + (d + 1) + ': x=' + px + ' y=' + py);
    }
    log(`  Boundary: ${pv.getUint16(76, true)} x ${pv.getUint16(78, true)}`);
    const hexRows = [];
    for (let i = 0; i < payload.length; i += 16) {
        const slice = Array.from(payload.slice(i, Math.min(i + 16, payload.length)));
        hexRows.push(`  Hex[${String(i).padStart(2,'0')}-${String(Math.min(i+15, payload.length-1)).padStart(2,'0')}]: ${slice.map(b => b.toString(16).padStart(2,'0')).join(' ')}`);
    }
    hexRows.forEach(r => log(r));
    log('--- END ---');

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

        // Initialize sensor: Start + Send only (no SHOW_FULL_IMAGE to preserve AI result)
        await sendCommand('START');
        await new Promise(r => setTimeout(r, 200));
        await sendCommand('SEND');
        log('Sensor initialized — streaming (AI mode)');

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
        // 1. Find JPEG SOI (FF D8)
        let soi = -1;
        for (let i = 0; i < acc.length - 1; i++) {
            if (acc[i] === 0xFF && acc[i + 1] === 0xD8) { soi = i; break; }
        }
        if (soi === -1) {
            // Keep up to 4KB — inter-frame gap is ~2.8KB and contains the AI result header
            if (acc.length > 4096) acc.splice(0, acc.length - 4096);
            return;
        }

        // 2. Extract AI result from C0 5A 63 A4 header BEFORE the JPEG
        //    Frame structure: ... C0 5A 63 A4 00 00 00 [int u32 LE] [dec u32 LE] ... C0 5A 01 XX ... FF D8 JPEG FF D9 ...
        if (soi >= 23) {
            // Search backwards from SOI for C0 5A 63 A4 header
            for (let p = soi - 1; p >= 3; p--) {
                if (acc[p] === 0xC0 && acc[p + 1] === 0x5A && acc[p + 2] === 0x63 && acc[p + 3] === 0xA4) {
                    if (p + 14 < acc.length) {
                        const hdr = acc.slice(p + 7, p + 15); // 8 bytes: integer(4) + decimal(4)
                        lastAiResult = {
                            integer: hdr[0] | (hdr[1] << 8) | (hdr[2] << 16) | (hdr[3] << 24),
                            decimal: hdr[4] | (hdr[5] << 8) | (hdr[6] << 16) | (hdr[7] << 24),
                            confidence: 0,
                            flags: 0,
                        };
                        if (frameCount < 5) {
                            const hex = hdr.map(b => b.toString(16).padStart(2, '0')).join(' ');
                            const reading = lastAiResult.integer + lastAiResult.decimal / 1000000;
                            log(`AI[${frameCount}] C05A_63A4@${p}: ${hex} → int=${lastAiResult.integer} dec=${lastAiResult.decimal} reading=${reading.toFixed(6)}`);
                        }
                    }
                    break;
                }
            }
        }

        // 3. Discard bytes before SOI
        if (soi > 0) acc.splice(0, soi);

        // 4. Find JPEG EOI (FF D9)
        let eoi = -1;
        for (let i = 2; i < acc.length - 1; i++) {
            if (acc[i] === 0xFF && acc[i + 1] === 0xD9) { eoi = i; break; }
        }
        if (eoi === -1) return;

        // 5. Extract JPEG and advance past EOI
        const jpeg = new Uint8Array(acc.slice(0, eoi + 2));
        acc.splice(0, eoi + 2);

        // 6. Display frame
        const blob = new Blob([jpeg], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        const prev = cam.src;
        cam.onload = () => { if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev); };
        cam.src = url;
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

// === Konva Calibration ===

function initKonvaCalib() {
    const r = getImageRect();
    const w = r.w;
    const h = r.h;

    konvaStage = new Konva.Stage({
        container: 'konva-container',
        width: w,
        height: h,
    });

    konvaLayer = new Konva.Layer();
    konvaStage.add(konvaLayer);

    const rectW = w * 0.6;
    const rectH = h * 0.15;

    konvaRect = new Konva.Rect({
        x: (w - rectW) / 2,
        y: (h - rectH) / 2,
        width: rectW,
        height: rectH,
        fill: 'rgba(56, 189, 248, 0.06)',
        stroke: '#38bdf8',
        strokeWidth: 1.5,
        draggable: true,
    });
    konvaLayer.add(konvaRect);

    konvaDividers = new Konva.Group();
    konvaLayer.add(konvaDividers);

    konvaTransformer = new Konva.Transformer({
        nodes: [konvaRect],
        rotateEnabled: true,
        rotationSnaps: [0, 90, 180, 270],
        rotateAnchorOffset: 20,
        anchorSize: 16,
        anchorCornerRadius: 8,
        anchorStroke: '#38bdf8',
        anchorStrokeWidth: 2,
        anchorFill: 'rgba(15, 23, 42, 0.8)',
        borderStroke: '#38bdf8',
        borderStrokeWidth: 1.5,
        boundBoxFunc: (oldBox, newBox) => {
            if (newBox.width < 30 || newBox.height < 20) return oldBox;
            return newBox;
        },
    });
    konvaLayer.add(konvaTransformer);

    konvaRect.on('transform dragmove', () => {
        updateDividers();
    });

    updateDividers();
    konvaLayer.draw();
}

function syncKonvaSize() {
    if (!konvaStage) return;
    const r = getImageRect();
    konvaContainer.style.left = (cam.offsetLeft + r.ox) + 'px';
    konvaContainer.style.top = (cam.offsetTop + r.oy) + 'px';
    konvaStage.width(r.w);
    konvaStage.height(r.h);
}

function updateDividers() {
    if (!konvaDividers || !konvaRect) return;
    konvaDividers.destroyChildren();

    const n = calibDigits;
    const rw = konvaRect.width() * konvaRect.scaleX();
    const rh = konvaRect.height() * konvaRect.scaleY();
    const rx = konvaRect.x();
    const ry = konvaRect.y();
    const rot = konvaRect.rotation();
    const dw = rw / n;

    // Thin divider lines between all digit cells
    for (let i = 1; i < n; i++) {
        const localX = -rw / 2 + dw * i;
        konvaDividers.add(new Konva.Line({
            points: [localX, -rh / 2, localX, rh / 2],
            stroke: 'rgba(56, 189, 248, 0.25)',
            strokeWidth: 1,
        }));
    }

    // 4 evenly-spaced reference markers (center of first → center of last digit)
    for (let ref = 0; ref < 4; ref++) {
        const t = ref / 3;
        const centerX = dw / 2 + t * (rw - dw);
        const localX = -rw / 2 + centerX;
        // Bold vertical line
        konvaDividers.add(new Konva.Line({
            points: [localX, -rh / 2, localX, rh / 2],
            stroke: '#38bdf8',
            strokeWidth: 2,
        }));
        // Top corner dot
        konvaDividers.add(new Konva.Circle({
            x: localX, y: -rh / 2,
            radius: 4, fill: '#38bdf8',
        }));
        // Bottom corner dot
        konvaDividers.add(new Konva.Circle({
            x: localX, y: rh / 2,
            radius: 4, fill: '#38bdf8',
        }));
    }

    // Position the group at rect center with same rotation
    konvaDividers.x(rx + rw / 2);
    konvaDividers.y(ry + rh / 2);
    konvaDividers.rotation(rot);
}

function drawDimOverlay() {
    const W = overlayCanvas.width, H = overlayCanvas.height;
    const ctx = overlayCtx;
    ctx.clearRect(0, 0, W, H);

    if (!konvaRect) return;

    const rw = konvaRect.width() * konvaRect.scaleX();
    const rh = konvaRect.height() * konvaRect.scaleY();
    const cx = konvaRect.x() + rw / 2;
    const cy = konvaRect.y() + rh / 2;
    const rot = konvaRect.rotation() * Math.PI / 180;

    // Dim overlay with evenodd cutout for the rotated rect
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    // Outer path (full canvas, clockwise)
    ctx.rect(0, 0, W, H);
    // Inner cutout (counter-clockwise for evenodd)
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.moveTo(-rw / 2, -rh / 2);
    ctx.lineTo(-rw / 2, rh / 2);
    ctx.lineTo(rw / 2, rh / 2);
    ctx.lineTo(rw / 2, -rh / 2);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();
}

function startCalibAnimLoop() {
    function tick() {
        if (!calibMode) return;
        syncOverlay();
        syncKonvaSize();
        drawDimOverlay();
        updateCalibReading();
        updateCalibCoords();
        updateDividers();
        calibAnimFrame = requestAnimationFrame(tick);
    }
    calibAnimFrame = requestAnimationFrame(tick);
}

function stopCalibAnimLoop() {
    if (calibAnimFrame) {
        cancelAnimationFrame(calibAnimFrame);
        calibAnimFrame = null;
    }
}

function updateCalibReading() {
    if (lastAiResult) {
        const reading = lastAiResult.integer + lastAiResult.decimal / 1000000;
        calibAiValue.textContent = reading.toFixed(2);
        calibAiConf.textContent = lastAiResult.confidence + '%';
    } else {
        calibAiValue.textContent = '--';
        calibAiConf.textContent = '';
    }
}

function updateCalibCoords() {
    const el = document.getElementById('calib-coords');
    if (!el || !konvaRect) { if (el) el.textContent = ''; return; }
    const coords = computeRoiCoords();
    if (!coords) { el.textContent = ''; return; }
    const parts = [];
    for (let i = 0; i < 4; i++) {
        const p1 = coords.digits[i * 2];
        const p2 = coords.digits[i * 2 + 1];
        parts.push(`${i*2+1}:(${p1.x},${p1.y}) ${i*2+2}:(${p2.x},${p2.y})`);
    }
    el.textContent = parts.join(' ') + `\nB:${coords.boundaryX}x${coords.boundaryY}`;
}

function previewRoi() {
    const coords = computeRoiCoords();
    if (!coords) { log('No rectangle'); return; }
    const r = getImageRect();
    const rect = konvaRect;
    const rw = rect.width() * rect.scaleX();
    const rh = rect.height() * rect.scaleY();
    log('=== PREVIEW (not sent) ===');
    log('  Image: ' + cam.naturalWidth + 'x' + cam.naturalHeight + ' | display: ' + Math.round(r.w) + 'x' + Math.round(r.h) + ' | pxScale: ' + (r.w / (cam.naturalWidth || SENSOR_W)).toFixed(4));
    log('  Rect: x=' + Math.round(rect.x()) + ' y=' + Math.round(rect.y()) + ' w=' + Math.round(rw) + ' h=' + Math.round(rh) + ' rot=' + rect.rotation().toFixed(1));
    for (let i = 0; i < 4; i++) {
        const p1 = coords.digits[i * 2];
        const p2 = coords.digits[i * 2 + 1];
        log('  P' + (i*2+1) + ': (' + p1.x + ',' + p1.y + ')  P' + (i*2+2) + ': (' + p2.x + ',' + p2.y + ')');
    }
    log('  Boundary: ' + coords.boundaryX + ' x ' + coords.boundaryY);
    log('  numDigits: ' + coords.numDigits + ' | FlipY: ' + (document.getElementById('calibFlipY')?.checked));
    log('=== END PREVIEW ===');
}

async function enterCalibMode() {
    if (!cam.src || cam.style.display === 'none') { log('No frame'); return; }
    if (drawerOpen) toggleDrawer();

    // Force full image mode — calibration needs 640×480 for correct coordinate mapping
    const wasNarrow = cam.naturalWidth && cam.naturalWidth < 320;
    if (wasNarrow || !cam.naturalWidth) {
        log('Switching to FULL IMAGE for calibration...');
        await sendCommand('SHOW_FULL_IMAGE');
        // Wait for the stream to switch (poll naturalWidth, max 3s)
        const t0 = performance.now();
        while (cam.naturalWidth < 320 && performance.now() - t0 < 3000) {
            await new Promise(r => setTimeout(r, 200));
        }
        if (cam.naturalWidth < 320) {
            log('WARNING: image may not have switched to full mode');
        } else {
            log(`Full image active: ${cam.naturalWidth}×${cam.naturalHeight}`);
        }
    }

    calibMode = true;
    syncOverlay();

    if (!konvaStage) {
        initKonvaCalib();
    } else {
        syncKonvaSize();
        updateDividers();
    }

    overlayCanvas.classList.add('active');
    konvaContainer.classList.add('active');
    actionBar.classList.remove('visible');
    calibBar.classList.add('visible');
    startCalibAnimLoop();
    log('Calibration mode ON — image: ' + cam.naturalWidth + 'x' + cam.naturalHeight + ' — position rect over digits');
}

function exitCalibMode() {
    calibMode = false;
    stopCalibAnimLoop();
    overlayCanvas.classList.remove('active');
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    konvaContainer.classList.remove('active');
    calibBar.classList.remove('visible');
    actionBar.classList.add('visible');
    log('Calibration mode OFF');
}

function drawCalibOverlay() {
    // Called when digit selector changes — just update dividers
    updateDividers();
    if (konvaLayer) konvaLayer.draw();
}

function computeRoiCoords() {
    if (!konvaRect) return null;
    const r = getImageRect();
    // Map to transmitted image resolution (e.g. 320x240), NOT hardcoded 640x480
    const imgW = cam.naturalWidth || SENSOR_W;
    const imgH = cam.naturalHeight || SENSOR_H;
    const pxScale = r.w / imgW; // display pixels per image pixel
    const flipY = document.getElementById('calibFlipY')?.checked ?? false;
    const rect = konvaRect;
    const rw = rect.width() * rect.scaleX();
    const rh = rect.height() * rect.scaleY();
    const cx = rect.x() + rw / 2;
    const cy = rect.y() + rh / 2;
    const rot = rect.rotation() * Math.PI / 180;
    const n = calibDigits;
    const digitW = rw / n;

    // 4 evenly-spaced references: center of first digit → center of last digit
    const digits = [];
    for (let ref = 0; ref < 4; ref++) {
        const t = ref / 3; // 0, 1/3, 2/3, 1
        const centerX = digitW / 2 + t * (rw - digitW);
        const localX = -rw / 2 + centerX;

        // Top corner (display: top edge = -rh/2)
        const topDispX = cx + localX * Math.cos(rot) - (-rh / 2) * Math.sin(rot);
        const topDispY = cy + localX * Math.sin(rot) + (-rh / 2) * Math.cos(rot);

        // Bottom corner (display: bottom edge = +rh/2)
        const botDispX = cx + localX * Math.cos(rot) - (rh / 2) * Math.sin(rot);
        const botDispY = cy + localX * Math.sin(rot) + (rh / 2) * Math.cos(rot);

        // Convert display coords → image pixel coords
        const topSx = Math.round(topDispX / pxScale);
        const botSx = Math.round(botDispX / pxScale);

        let topSy, botSy;
        if (flipY) {
            topSy = imgH - Math.round(topDispY / pxScale);
            botSy = imgH - Math.round(botDispY / pxScale);
        } else {
            topSy = Math.round(topDispY / pxScale);
            botSy = Math.round(botDispY / pxScale);
        }

        // Odd point (P1,P3,P5,P7): lower Y value
        // Even point (P2,P4,P6,P8): higher Y value
        const lowY = Math.min(topSy, botSy);
        const highY = Math.max(topSy, botSy);
        const lowX = (lowY === topSy) ? topSx : botSx;
        const highX = (highY === topSy) ? topSx : botSx;

        digits.push({ x: clamp16(lowX), y: clamp16(lowY) });
        digits.push({ x: clamp16(highX), y: clamp16(highY) });
    }

    const boundaryX = Math.round(digitW / pxScale);
    const boundaryY = Math.round(rh / pxScale);

    return { numDigits: n, digits, boundaryX, boundaryY, rotation: rect.rotation() };
}

async function computeAndSendRoi() {
    const coords = computeRoiCoords();
    if (!coords) { log('No rectangle'); return; }

    const { numDigits: n, digits, boundaryX, boundaryY, rotation } = coords;

    log(`ROI from touch: ${n} digits, rot=${rotation.toFixed(1)}°, boundary=${boundaryX}x${boundaryY}`);
    digits.forEach((d, i) => log(`  P${i+1}: (${d.x}, ${d.y})`));

    await sendRoiConfig({ numDigits: n, digits, boundaryX, boundaryY });

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
