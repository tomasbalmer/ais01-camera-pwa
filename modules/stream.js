import {
    JPEG_SOI, JPEG_EOI, AI_HEADER, AI_RESULT_OFFSET, AI_RESULT_DATA_SIZE,
    AI_LOG_FRAME_LIMIT,
    USB_TRANSFER_SIZE, FTDI_DEFAULT_PACKET_SIZE, FTDI_HEADER_SIZE,
    FPS_INTERVAL_MS,
} from './constants.js';
import { state } from './state.js';
import { dom, log, syncImageModeFromFrame } from './ui.js';
import { aiReading } from './helpers.js';

// === Configuration ===
const DISPLAY_INTERVAL_MS = 1000;
const ACC_MAX = 256 * 1024;

// Full image: 640x480 JPEG ~8-35KB. ROI: 160x64 ~1-8KB.
const JPEG_MIN_SIZE = 500;
const JPEG_MAX_SIZE = 60000;

// === Typed-array accumulator (fast set/copyWithin instead of push/splice) ===
let acc = new Uint8Array(ACC_MAX);
let accLen = 0;

// === FTDI header stripping (reuses pre-allocated buffer) ===
let stripBuf = new Uint8Array(USB_TRANSFER_SIZE);

function stripFtdiHeaders(data, pktSz) {
    let out = 0;
    if (data.length <= FTDI_HEADER_SIZE) return 0;
    for (let i = 0; i < data.length; i += pktSz) {
        const end = Math.min(i + pktSz, data.length);
        for (let j = i + FTDI_HEADER_SIZE; j < end; j++) {
            stripBuf[out++] = data[j];
        }
    }
    return out;
}

// === Find 2-byte marker in accumulator ===
function findMarker(start, marker0, marker1) {
    const end = accLen - 1;
    for (let i = start; i < end; i++) {
        if (acc[i] === marker0 && acc[i + 1] === marker1) return i;
    }
    return -1;
}

// === Extract AI result from bytes before SOI ===
function extractAiResult(soiIndex) {
    if (soiIndex < AI_RESULT_OFFSET + AI_RESULT_DATA_SIZE) return;

    for (let p = soiIndex - 1; p >= 3; p--) {
        if (acc[p] === AI_HEADER[0] && acc[p+1] === AI_HEADER[1]
            && acc[p+2] === AI_HEADER[2] && acc[p+3] === AI_HEADER[3]) {

            const off = p + AI_RESULT_OFFSET;
            if (off + AI_RESULT_DATA_SIZE > accLen) break;

            state.lastAiResult = {
                integer: acc[off] | (acc[off+1] << 8) | (acc[off+2] << 16) | (acc[off+3] << 24),
                decimal: acc[off+4] | (acc[off+5] << 8) | (acc[off+6] << 16) | (acc[off+7] << 24),
                confidence: 0,
                flags: 0,
            };

            if (state.frameCount < AI_LOG_FRAME_LIMIT) {
                const reading = aiReading(state.lastAiResult);
                log(`AI[${state.frameCount}] int=${state.lastAiResult.integer} dec=${state.lastAiResult.decimal} → ${reading.toFixed(6)}`);
            }
            break;
        }
    }
}

// === Discard N bytes from start of accumulator ===
function accDiscard(n) {
    if (n >= accLen) { accLen = 0; return; }
    acc.copyWithin(0, n, accLen);
    accLen -= n;
}

// === Extract frames ===
function extractFrames() {
    while (true) {
        const soi = findMarker(0, 0xFF, 0xD8);
        if (soi === -1) {
            if (accLen > 65536) { accLen = 0; } // prevent unbounded growth
            return;
        }

        const eoi = findMarker(soi + 2, 0xFF, 0xD9);
        if (eoi === -1) return;

        const jpegEnd = eoi + 2;
        const jpegSize = jpegEnd - soi;
        state.frameCount++;
        state.fpsCount++;

        const now = performance.now();
        const shouldDisplay = now - state.lastDisplayTime >= DISPLAY_INTERVAL_MS;

        if (shouldDisplay && jpegSize >= JPEG_MIN_SIZE && jpegSize <= JPEG_MAX_SIZE) {
            // Extract AI from bytes before SOI
            if (soi > 0) extractAiResult(soi);

            // Display this frame
            const jpeg = acc.slice(soi, jpegEnd);
            const blob = new Blob([jpeg], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            const prev = dom.cam.src;
            dom.cam.onload = () => {
                if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
                syncImageModeFromFrame();
            };
            dom.cam.src = url;
            state.lastDisplayTime = now;

            if (state.frameCount === 1) {
                log(`First frame: ${jpegSize} bytes`);
            }
        }

        // Discard everything up to end of this frame
        accDiscard(jpegEnd);
    }
}

// === Read stream ===
export async function readStream(epIn) {
    accLen = 0;
    let totalBytes = 0;
    const pktSz = epIn.packetSize || FTDI_DEFAULT_PACKET_SIZE;

    state.running = true;
    state.lastDisplayTime = performance.now();
    dom.connectScreen.style.display = 'none';
    dom.cam.style.display = 'block';
    dom.stats.className = 'active';
    dom.statusDot.classList.add('connected');
    /* modeToggle removed — Full/ROI now in Installation panel */
    dom.modeArea.classList.add('visible');
    dom.modeSelector.classList.add('visible');
    dom.btnStop.classList.add('visible');
    const mt = document.getElementById('mode-title');
    if (mt) mt.style.display = 'block';
    state.activeMode = null;
    const { switchMode } = await import('./ui.js');
    switchMode('validate');
    state.lastFpsTime = performance.now();
    state.fpsCount = 0;

    log(`Streaming from EP${epIn.endpointNumber} (pkt=${pktSz})`);

    while (state.running) {
        try {
            const result = await state.device.transferIn(epIn.endpointNumber, USB_TRANSFER_SIZE);
            if (result.status !== 'ok' || !result.data || result.data.byteLength <= FTDI_HEADER_SIZE) continue;

            const raw = new Uint8Array(result.data.buffer);
            const len = stripFtdiHeaders(raw, pktSz);
            if (!len) continue;

            // Fast copy into accumulator
            if (accLen + len > ACC_MAX) {
                accLen = 0; // overflow: reset
            }
            acc.set(stripBuf.subarray(0, len), accLen);
            accLen += len;

            totalBytes += len;
            extractFrames();

            const now = performance.now();
            if (now - state.lastFpsTime >= FPS_INTERVAL_MS) {
                state.currentFps = state.fpsCount / ((now - state.lastFpsTime) / FPS_INTERVAL_MS);
                state.fpsCount = 0;
                state.lastFpsTime = now;
                let aiText = '';
                if (state.lastAiResult) {
                    const reading = aiReading(state.lastAiResult);
                    aiText = ` | AI: ${reading.toFixed(2)}`;
                }
                dom.stats.textContent = `#${state.frameCount} | ${state.currentFps.toFixed(1)} fps${aiText}`;
            }
        } catch (err) {
            if (state.running) {
                log(`Read err: ${err.message}`);
                await new Promise(r => setTimeout(r, 100));
            }
        }
    }
}
