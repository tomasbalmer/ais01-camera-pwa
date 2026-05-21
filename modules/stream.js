import {
    JPEG_SOI, JPEG_EOI, AI_HEADER, AI_RESULT_OFFSET, AI_RESULT_DATA_SIZE,
    AI_LOG_FRAME_LIMIT,
    USB_TRANSFER_SIZE, FTDI_DEFAULT_PACKET_SIZE, FTDI_HEADER_SIZE,
    FPS_INTERVAL_MS,
} from './constants.js';
import { state } from './state.js';
import { dom, log, syncImageModeFromFrame } from './ui.js';
import { findMarker, readU32LE, aiReading } from './helpers.js';

// === Configuration ===
const DISPLAY_INTERVAL_MS = 500; // Show 1 frame every 500ms (2 fps)
const BUFFER_MAX = 256 * 1024;   // 256KB ring buffer

// === Ring buffer (avoids Array push/splice overhead) ===
let buf = new Uint8Array(BUFFER_MAX);
let writePos = 0;  // next write position
let readPos = 0;   // next read position

function bufLen() {
    return writePos >= readPos ? writePos - readPos : BUFFER_MAX - readPos + writePos;
}

function bufPush(data) {
    for (let i = 0; i < data.length; i++) {
        buf[writePos] = data[i];
        writePos = (writePos + 1) % BUFFER_MAX;
    }
    // If buffer is full, advance readPos (drop oldest data)
    if (bufLen() > BUFFER_MAX - 1) {
        readPos = (writePos + 1) % BUFFER_MAX;
    }
}

function bufGet(pos) {
    return buf[pos % BUFFER_MAX];
}

// === FTDI header stripping ===
function stripFtdiHeaders(data, pktSz) {
    const result = new Uint8Array(data.length); // worst case same size
    let outIdx = 0;
    if (data.length <= FTDI_HEADER_SIZE) return new Uint8Array(0);
    for (let i = 0; i < data.length; i += pktSz) {
        const end = Math.min(i + pktSz, data.length);
        for (let j = i + FTDI_HEADER_SIZE; j < end; j++) {
            result[outIdx++] = data[j];
        }
    }
    return result.subarray(0, outIdx);
}

// === Search for 2-byte marker in ring buffer ===
function findMarkerInBuf(startPos, len, marker) {
    const end = len - 1;
    for (let i = 0; i < end; i++) {
        const pos = (startPos + i) % BUFFER_MAX;
        const next = (pos + 1) % BUFFER_MAX;
        if (buf[pos] === marker[0] && buf[next] === marker[1]) return i;
    }
    return -1;
}

// === Extract bytes from ring buffer into a new Uint8Array ===
function bufExtract(startPos, len) {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        out[i] = buf[(startPos + i) % BUFFER_MAX];
    }
    return out;
}

// === Extract AI result from bytes before SOI ===
function extractAiFromBuf(soiOffset) {
    // Search backwards from SOI for AI_HEADER in the buffer
    const searchStart = Math.max(0, soiOffset - 64); // look at most 64 bytes back
    for (let i = soiOffset - AI_HEADER.length; i >= searchStart; i--) {
        const pos = (readPos + i) % BUFFER_MAX;
        if (buf[pos] === AI_HEADER[0] &&
            buf[(pos+1) % BUFFER_MAX] === AI_HEADER[1] &&
            buf[(pos+2) % BUFFER_MAX] === AI_HEADER[2] &&
            buf[(pos+3) % BUFFER_MAX] === AI_HEADER[3]) {

            const off = i + AI_RESULT_OFFSET;
            if (off + AI_RESULT_DATA_SIZE > soiOffset) break;

            const absOff = (readPos + off) % BUFFER_MAX;
            const b = bufExtract(absOff, AI_RESULT_DATA_SIZE);
            state.lastAiResult = {
                integer: b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24),
                decimal: b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24),
                confidence: 0,
                flags: 0,
            };

            if (state.frameCount < AI_LOG_FRAME_LIMIT) {
                const hex = Array.from(b).map(v => v.toString(16).padStart(2, '0')).join(' ');
                const reading = aiReading(state.lastAiResult);
                log(`AI[${state.frameCount}] ${hex} → ${reading.toFixed(6)}`);
            }
            break;
        }
    }
}

// === Find the LAST complete JPEG in the buffer ===
// Returns { jpeg: Uint8Array, soiOffset } or null
function findLastJpeg() {
    const len = bufLen();
    if (len < 4) return null;

    // Scan backwards for the last EOI
    let lastEoiOffset = -1;
    for (let i = len - 2; i >= 0; i--) {
        const pos = (readPos + i) % BUFFER_MAX;
        const next = (readPos + i + 1) % BUFFER_MAX;
        if (buf[pos] === JPEG_EOI[0] && buf[next] === JPEG_EOI[1]) {
            lastEoiOffset = i;
            break;
        }
    }
    if (lastEoiOffset === -1) return null;

    // Scan backwards from EOI for the matching SOI
    let soiOffset = -1;
    for (let i = lastEoiOffset - 2; i >= 0; i--) {
        const pos = (readPos + i) % BUFFER_MAX;
        const next = (readPos + i + 1) % BUFFER_MAX;
        if (buf[pos] === JPEG_SOI[0] && buf[next] === JPEG_SOI[1]) {
            soiOffset = i;
            break;
        }
    }
    if (soiOffset === -1) return null;

    const jpegLen = lastEoiOffset + 2 - soiOffset;
    const jpeg = bufExtract((readPos + soiOffset) % BUFFER_MAX, jpegLen);

    return { jpeg, soiOffset };
}

// === Display timer — runs every DISPLAY_INTERVAL_MS ===
let displayTimer = null;
let lastDisplayTime = 0;

function displayTick() {
    const result = findLastJpeg();
    if (!result) return;

    // Extract AI result from bytes before this JPEG's SOI
    extractAiFromBuf(result.soiOffset);

    // Discard everything up to and including this frame
    const consumeLen = result.soiOffset + result.jpeg.length;
    readPos = (readPos + consumeLen) % BUFFER_MAX;

    // Display the frame
    const blob = new Blob([result.jpeg], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const prev = dom.cam.src;
    dom.cam.onload = () => {
        if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
        syncImageModeFromFrame();
    };
    dom.cam.src = url;
    state.frameCount++;
    state.fpsCount++;

    if (state.frameCount === 1) {
        log(`First frame: ${result.jpeg.length} bytes`);
    }
}

// === Read stream — only reads USB, display handled by timer ===
export async function readStream(epIn) {
    // Reset buffer
    writePos = 0;
    readPos = 0;
    let totalBytes = 0;
    const pktSz = epIn.packetSize || FTDI_DEFAULT_PACKET_SIZE;

    state.running = true;
    dom.connectScreen.style.display = 'none';
    dom.cam.style.display = 'block';
    dom.stats.className = 'active';
    dom.statusDot.classList.add('connected');
    dom.modeToggle.classList.add('visible');
    dom.modeArea.classList.add('visible');
    dom.modeSelector.classList.add('visible');
    dom.btnStop.classList.add('visible');
    dom.modeHint.style.display = 'none';
    state.lastFpsTime = performance.now();
    state.fpsCount = 0;

    log(`Streaming from EP${epIn.endpointNumber} (pkt=${pktSz})`);

    // Start display timer — decoupled from USB reads
    displayTimer = setInterval(displayTick, DISPLAY_INTERVAL_MS);

    while (state.running) {
        try {
            const result = await state.device.transferIn(epIn.endpointNumber, USB_TRANSFER_SIZE);
            if (result.status !== 'ok' || !result.data || result.data.byteLength <= FTDI_HEADER_SIZE) continue;

            const raw = new Uint8Array(result.data.buffer);
            const cleaned = stripFtdiHeaders(raw, pktSz);
            totalBytes += cleaned.length;

            // Fast copy into ring buffer — this is the hot path
            bufPush(cleaned);

            // Update stats every second
            const now = performance.now();
            if (now - state.lastFpsTime >= FPS_INTERVAL_MS) {
                state.currentFps = state.fpsCount / ((now - state.lastFpsTime) / FPS_INTERVAL_MS);
                state.fpsCount = 0;
                state.lastFpsTime = now;
                let aiText = '';
                if (state.lastAiResult) {
                    const reading = aiReading(state.lastAiResult);
                    aiText = ` | AI: ${reading.toFixed(2)} (${state.lastAiResult.confidence}%)`;
                }
                dom.stats.textContent = `#${state.frameCount} | ${state.currentFps.toFixed(1)} fps | ${(totalBytes / 1024).toFixed(0)} KB${aiText}`;
            }
        } catch (err) {
            if (state.running) {
                log(`Read err: ${err.message}`);
                await new Promise(r => setTimeout(r, 100));
            }
        }
    }

    // Cleanup
    if (displayTimer) {
        clearInterval(displayTimer);
        displayTimer = null;
    }
}
