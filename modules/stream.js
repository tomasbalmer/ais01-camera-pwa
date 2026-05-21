import {
    JPEG_SOI, JPEG_EOI, AI_HEADER, AI_RESULT_OFFSET, AI_RESULT_DATA_SIZE,
    FRAME_BUFFER_MAX, AI_LOG_FRAME_LIMIT,
    USB_TRANSFER_SIZE, FTDI_DEFAULT_PACKET_SIZE, FTDI_HEADER_SIZE,
    FPS_INTERVAL_MS,
} from './constants.js';
import { state } from './state.js';
import { dom, log, syncImageModeFromFrame } from './ui.js';
import { findMarker, readU32LE, aiReading } from './helpers.js';

// === Configuration ===
const DISPLAY_INTERVAL_MS = 1000; // Show at most 1 frame per second

// === FTDI header stripping ===
function stripFtdiHeaders(data, pktSz) {
    const result = [];
    if (data.length <= FTDI_HEADER_SIZE) return new Uint8Array(0);
    for (let i = 0; i < data.length; i += pktSz) {
        const end = Math.min(i + pktSz, data.length);
        for (let j = i + FTDI_HEADER_SIZE; j < end; j++) result.push(data[j]);
    }
    return new Uint8Array(result);
}

// === Extract AI result from C0 5A 63 A4 header BEFORE the JPEG ===
function extractAiResult(acc, soiIndex) {
    if (soiIndex < AI_RESULT_OFFSET + AI_RESULT_DATA_SIZE) return;

    for (let p = soiIndex - 1; p >= AI_HEADER.length - 1; p--) {
        if (acc[p] === AI_HEADER[0] && acc[p + 1] === AI_HEADER[1]
            && acc[p + 2] === AI_HEADER[2] && acc[p + 3] === AI_HEADER[3]) {

            if (p + AI_RESULT_OFFSET + AI_RESULT_DATA_SIZE > acc.length) break;

            const off = p + AI_RESULT_OFFSET;
            state.lastAiResult = {
                integer: readU32LE(acc, off),
                decimal: readU32LE(acc, off + 4),
                confidence: 0,
                flags: 0,
            };

            if (state.frameCount < AI_LOG_FRAME_LIMIT) {
                const hdr = acc.slice(off, off + AI_RESULT_DATA_SIZE);
                const hex = hdr.map(b => b.toString(16).padStart(2, '0')).join(' ');
                const reading = aiReading(state.lastAiResult);
                log(`AI[${state.frameCount}] C05A_63A4@${p}: ${hex} → int=${state.lastAiResult.integer} dec=${state.lastAiResult.decimal} reading=${reading.toFixed(6)}`);
            }
            break;
        }
    }
}

// === Extract frames: always parse AI, only display 1/sec ===
function extractFrames(acc) {
    while (true) {
        // Find SOI
        const soi = findMarker(acc, 0, JPEG_SOI);
        if (soi === -1) {
            if (acc.length > FRAME_BUFFER_MAX) acc.splice(0, acc.length - FRAME_BUFFER_MAX);
            return;
        }

        // Find EOI after SOI
        const eoi = findMarker(acc, soi + 2, JPEG_EOI);
        if (eoi === -1) return;

        // Complete JPEG found
        const jpegEnd = eoi + 2;
        state.frameCount++;
        state.fpsCount++;

        const now = performance.now();
        if (now - state.lastDisplayTime >= DISPLAY_INTERVAL_MS) {
            // Extract AI from bytes BEFORE SOI (still in accumulator)
            if (soi > 0) extractAiResult(acc, soi);

            const jpeg = new Uint8Array(acc.slice(soi, jpegEnd));
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
                log(`First frame: ${jpeg.length} bytes`);
            }
        }

        // Discard frame (displayed or not)
        acc.splice(0, jpegEnd);
    }
}

// === Read stream and extract JPEG frames ===
export async function readStream(epIn) {
    let accumulator = [];
    let totalBytes = 0;
    const pktSz = epIn.packetSize || FTDI_DEFAULT_PACKET_SIZE;

    state.running = true;
    state.lastDisplayTime = performance.now(); // skip first second to avoid partial frames
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

    while (state.running) {
        try {
            const result = await state.device.transferIn(epIn.endpointNumber, USB_TRANSFER_SIZE);
            if (result.status !== 'ok' || !result.data || result.data.byteLength <= FTDI_HEADER_SIZE) continue;

            const raw = new Uint8Array(result.data.buffer);
            const cleaned = stripFtdiHeaders(raw, pktSz);
            totalBytes += cleaned.length;

            for (let i = 0; i < cleaned.length; i++) accumulator.push(cleaned[i]);
            extractFrames(accumulator);

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
}
