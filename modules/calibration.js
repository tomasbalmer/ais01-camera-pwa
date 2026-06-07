import { CAL_W, CAL_H } from './constants.js';
import { state } from './state.js';
import { dom, getImageRect, clamp16, syncOverlay, log, toggleDrawer, registerCalibCallbacks } from './ui.js';
import { sendCommand } from './protocol.js';
import { sendRoiConfig } from './roi.js';
import { aiReading } from './helpers.js';
import { createCalibOverlay } from './calib-canvas.js';

// === Calibration overlay (native canvas) ===

let calib = null;  // createCalibOverlay() instance
let calibResizeObserver = null;

function initCalib() {
    const r = getImageRect();
    const canvas = document.getElementById('calib-canvas');
    canvas.width = r.w;
    canvas.height = r.h;

    calib = createCalibOverlay(canvas, () => {
        unlockCalibrate();
        drawDimOverlay();
        updateCalibCoords();
    });

    const rectW = r.w * 0.6;
    const rectH = r.h * 0.15;
    calib.setRect((r.w - rectW) / 2, (r.h - rectH) / 2, rectW, rectH, 0);
    calib.setDigits(state.calibDigits);
    syncCalibPosition();
}

function syncCalibPosition() {
    if (!calib) return;
    const r = getImageRect();
    const canvas = document.getElementById('calib-canvas');
    canvas.style.left = (dom.cam.offsetLeft + r.ox) + 'px';
    canvas.style.top = (dom.cam.offsetTop + r.oy) + 'px';
    calib.resize(r.w, r.h);
}

function drawDimOverlay() {
    const W = dom.overlayCanvas.width, H = dom.overlayCanvas.height;
    const ctx = dom.overlayCtx;
    ctx.clearRect(0, 0, W, H);
    if (!calib) return;

    const rc = calib.getRect();
    const cx = rc.x + rc.w / 2;
    const cy = rc.y + rc.h / 2;
    const rot = rc.rot * Math.PI / 180;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.moveTo(-rc.w / 2, -rc.h / 2);
    ctx.lineTo(-rc.w / 2, rc.h / 2);
    ctx.lineTo(rc.w / 2, rc.h / 2);
    ctx.lineTo(rc.w / 2, -rc.h / 2);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();
}

function unlockCalibrate() {
    if (state.calibRectTouched) return;
    state.calibRectTouched = true;
    const btn = document.getElementById('btn-calibrate');
    if (btn) {
        btn.disabled = false;
    }
}

// Slow interval for AI reading update only — canvas position is fixed at entry
function startCalibInterval() {
    stopCalibInterval();
    state.calibInterval = setInterval(() => {
        if (!state.calibMode) return;
        updateCalibReading();
    }, 2000);
}

function stopCalibInterval() {
    if (state.calibInterval) {
        clearInterval(state.calibInterval);
        state.calibInterval = null;
    }
}

function updateCalibReading() {
    const reading = aiReading(state.lastAiResult);
    dom.calibAiValue.textContent = reading !== null ? reading.toFixed(2) : '--';
}

function updateCalibCoords() {
    const el = document.getElementById('calib-coords');
    if (!el || !calib) { if (el) el.textContent = ''; return; }
    const coords = computeRoiCoords();
    if (!coords) { el.textContent = ''; return; }
    const line1 = [], line2 = [];
    for (let i = 0; i < 8; i++) {
        const p = coords.digits[i];
        const s = `${i+1}:(${p.x},${p.y})`;
        if (i < 4) line1.push(s); else line2.push(s);
    }
    el.textContent = line1.join(' ') + '\n' + line2.join(' ');
}

export async function enterCalibMode() {
    if (!dom.cam.src || dom.cam.style.display === 'none') { log('No frame'); return; }
    if (state.drawerOpen) toggleDrawer();

    dom.calibAiValue.textContent = '...';
    dom.overlayCanvas.classList.remove('active');
    const calibCanvas = document.getElementById('calib-canvas');
    calibCanvas.classList.remove('active');

    // Force full image mode for correct coordinate mapping
    const wasNarrow = dom.cam.naturalWidth && dom.cam.naturalWidth < 320;
    if (wasNarrow || !dom.cam.naturalWidth) {
        log('Switching to FULL IMAGE for calibration...');
        await sendCommand('SHOW_FULL_IMAGE');
        const t0 = performance.now();
        while (dom.cam.naturalWidth < 320 && performance.now() - t0 < 3000) {
            await new Promise(r => setTimeout(r, 200));
        }
        if (dom.cam.naturalWidth < 320) {
            log('WARNING: image may not have switched to full mode');
        } else {
            log(`Full image active: ${dom.cam.naturalWidth}x${dom.cam.naturalHeight}`);
        }
    }

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    state.calibMode = true;
    syncOverlay();

    if (!calib) {
        initCalib();
    } else {
        syncCalibPosition();
        const r = getImageRect();
        const rectW = r.w * 0.6;
        const rectH = r.h * 0.15;
        calib.setRect((r.w - rectW) / 2, (r.h - rectH) / 2, rectW, rectH, 0);
    }

    dom.overlayCanvas.classList.add('active');
    calibCanvas.classList.add('active');

    // Sync canvas position on any layout change (panel resize, keyboard, etc.)
    if (!calibResizeObserver) {
        calibResizeObserver = new ResizeObserver(() => {
            if (state.calibMode) syncCalibPosition();
        });
        calibResizeObserver.observe(document.getElementById('viewer'));
    }

    // Coords always visible in settings panel
    updateCalibCoords();

    // Lock calibrate button until user positions the rect
    state.calibRectTouched = false;
    const calibBtn = document.getElementById('btn-calibrate');
    if (calibBtn) {
        calibBtn.disabled = true;
    }
    // Hide positioning hint (fresh start)
    const calibHint = document.getElementById('calib-hint');
    if (calibHint) calibHint.style.display = 'none';

    drawDimOverlay();
    updateCalibCoords();
    updateCalibReading();
    startCalibInterval();
    log('Calibration mode ON — image: ' + dom.cam.naturalWidth + 'x' + dom.cam.naturalHeight + ' — position rect over digits');

    // First time entering calibration: auto-open digit picker
    if (state.calibFirstEntry) {
        state.calibFirstEntry = false;
        setTimeout(() => {
            if (typeof window.cycleDigits === 'function') window.cycleDigits(null);
        }, 400);
    }
}

export function exitCalibMode() {
    state.calibMode = false;
    stopCalibInterval();
    dom.overlayCanvas.classList.remove('active');
    dom.overlayCtx.clearRect(0, 0, dom.overlayCanvas.width, dom.overlayCanvas.height);
    document.getElementById('calib-canvas').classList.remove('active');
    log('Calibration mode OFF');
}

export function onCalibDigitChange(value) {
    state.calibDigits = value;
    if (calib) {
        calib.setDigits(value);
        drawDimOverlay();
        updateCalibCoords();
    }
}

export function toggleCalibCoords() {
    const show = document.getElementById('calibShowCoords')?.checked;
    const el = document.getElementById('calib-coords');
    if (el) el.style.display = show ? 'block' : 'none';
}

export function computeRoiCoords() {
    if (!calib) return null;
    const rc = calib.getRect();
    const stageW = calib.stageWidth();
    const imgW = dom.cam.naturalWidth || CAL_W;
    const imgH = dom.cam.naturalHeight || CAL_H;
    const pxScale = stageW / imgW;
    const calScaleX = CAL_W / imgW;
    const calScaleY = CAL_H / imgH;
    const rw = rc.w;
    const rh = rc.h;
    const cx = rc.x + rw / 2;
    const cy = rc.y + rh / 2;
    const rot = rc.rot * Math.PI / 180;
    const n = state.calibDigits;
    const digitW = rw / n;

    // 4 reference positions at digit boundaries: [0, 2, N-2, N]
    // Based on Dragino wiki calibration diagrams for each digit count.
    // For N=4: P1,P2 unused (0,0), only 3 refs at [0, 2, 4]
    const refPositions = n === 4
        ? [0, 0, 2, 4]   // P1,P2 unused, P3-P8 at 0, N/2, N
        : [0, 2, n - 2, n]; // standard: left edge, +2, N-2, right edge

    const digits = [];
    for (let ref = 0; ref < 4; ref++) {
        const frac = refPositions[ref] / n;
        const localX = -rw / 2 + frac * rw;

        const topDispX = cx + localX * Math.cos(rot) - (-rh / 2) * Math.sin(rot);
        const topDispY = cy + localX * Math.sin(rot) + (-rh / 2) * Math.cos(rot);
        const botDispX = cx + localX * Math.cos(rot) - (rh / 2) * Math.sin(rot);
        const botDispY = cy + localX * Math.sin(rot) + (rh / 2) * Math.cos(rot);

        const topSx = Math.round(topDispX / pxScale * calScaleX);
        const botSx = Math.round(botDispX / pxScale * calScaleX);
        const topSy = Math.round(topDispY / pxScale * calScaleY);
        const botSy = Math.round(botDispY / pxScale * calScaleY);

        const lowY = Math.min(topSy, botSy);
        const highY = Math.max(topSy, botSy);
        const lowX = (lowY === topSy) ? topSx : botSx;
        const highX = (highY === topSy) ? topSx : botSx;

        digits.push({ x: clamp16(lowX), y: clamp16(lowY) });
        digits.push({ x: clamp16(highX), y: clamp16(highY) });
    }

    const boundaryX = Math.round(digitW / pxScale * calScaleX);
    const boundaryY = Math.round(rh / pxScale * calScaleY);

    return { numDigits: n, digits, boundaryX, boundaryY, rotation: rc.rot };
}

export async function computeAndSendRoi() {
    const coords = computeRoiCoords();
    if (!coords) { log('No rectangle'); return; }

    const { numDigits: n, digits, boundaryX, boundaryY, rotation } = coords;

    const btn = document.getElementById('btn-calibrate');
    if (btn) { btn.textContent = 'Sending...'; btn.disabled = true; }

    log(`ROI from touch: ${n} digits, rot=${rotation.toFixed(1)}deg, boundary=${boundaryX}x${boundaryY}`);
    digits.forEach((d, i) => log(`  P${i+1}: (${d.x}, ${d.y})`));

    await sendRoiConfig({ numDigits: n, digits, boundaryX, boundaryY });

    if (btn) {
        btn.textContent = 'Sent!';
        setTimeout(() => { btn.textContent = 'Calibrate'; btn.disabled = false; }, 1500);
    }
}

registerCalibCallbacks(enterCalibMode, exitCalibMode);
