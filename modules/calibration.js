import { CAL_W, CAL_H } from './constants.js';
import { state } from './state.js';
import { dom, getImageRect, clamp16, syncOverlay, log, toggleDrawer } from './ui.js';
import { sendCommand } from './protocol.js';
import { sendRoiConfig } from './roi.js';
import { aiReading } from './helpers.js';

// === Konva Calibration ===

let _dividerLineCount = 0; // cached line count for shape reuse

function initKonvaCalib() {
    const r = getImageRect();
    const w = r.w;
    const h = r.h;

    state.konvaStage = new Konva.Stage({
        container: 'konva-container',
        width: w,
        height: h,
    });

    state.konvaLayer = new Konva.Layer();
    state.konvaStage.add(state.konvaLayer);

    const rectW = w * 0.6;
    const rectH = h * 0.15;

    state.konvaRect = new Konva.Rect({
        x: (w - rectW) / 2,
        y: (h - rectH) / 2,
        width: rectW,
        height: rectH,
        fill: 'rgba(56, 189, 248, 0.04)',
        stroke: 'rgba(56, 189, 248, 0.7)',
        strokeWidth: 1,
        draggable: true,
    });
    state.konvaLayer.add(state.konvaRect);

    state.konvaDividers = new Konva.Group();
    state.konvaLayer.add(state.konvaDividers);

    state.konvaTransformer = new Konva.Transformer({
        nodes: [state.konvaRect],
        enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right', 'top-center', 'bottom-center'],
        rotateEnabled: true,
        rotationSnaps: [0, 90, 180, 270],
        rotateAnchorOffset: 16,
        anchorSize: 10,
        anchorCornerRadius: 5,
        anchorStroke: '#38bdf8',
        anchorStrokeWidth: 1.5,
        anchorFill: 'rgba(15, 23, 42, 0.9)',
        borderStroke: 'rgba(56, 189, 248, 0.6)',
        borderStrokeWidth: 1,
        boundBoxFunc: (oldBox, newBox) => {
            if (newBox.width < 30 || newBox.height < 20) return oldBox;
            return newBox;
        },
    });
    state.konvaLayer.add(state.konvaTransformer);

    state.konvaRect.on('transform dragmove', () => {
        onCalibRectChange();
    });

    updateDividers();
    state.konvaLayer.draw();
}

function syncKonvaSize() {
    if (!state.konvaStage) return;
    const r = getImageRect();
    dom.konvaContainer.style.left = (dom.cam.offsetLeft + r.ox) + 'px';
    dom.konvaContainer.style.top = (dom.cam.offsetTop + r.oy) + 'px';
    state.konvaStage.width(r.w);
    state.konvaStage.height(r.h);
}

function updateDividers() {
    if (!state.konvaDividers || !state.konvaRect) return;

    const n = state.calibDigits;
    const rw = state.konvaRect.width() * state.konvaRect.scaleX();
    const rh = state.konvaRect.height() * state.konvaRect.scaleY();
    const rx = state.konvaRect.x();
    const ry = state.konvaRect.y();
    const rot = state.konvaRect.rotation();
    const dw = rw / n;
    const neededLines = n - 1;

    // Rebuild lines only when digit count changed
    if (_dividerLineCount !== neededLines) {
        state.konvaDividers.destroyChildren();
        for (let i = 0; i < neededLines; i++) {
            state.konvaDividers.add(new Konva.Line({
                stroke: 'rgba(56, 189, 248, 0.4)',
                strokeWidth: 1,
            }));
        }
        _dividerLineCount = neededLines;
    }

    // Update positions on existing lines
    const lines = state.konvaDividers.children;
    for (let i = 0; i < neededLines; i++) {
        const localX = -rw / 2 + dw * (i + 1);
        lines[i].points([localX, -rh / 2, localX, rh / 2]);
    }

    // Position the group at rect center with same rotation
    state.konvaDividers.x(rx + rw / 2);
    state.konvaDividers.y(ry + rh / 2);
    state.konvaDividers.rotation(rot);
}

function drawDimOverlay() {
    const W = dom.overlayCanvas.width, H = dom.overlayCanvas.height;
    const ctx = dom.overlayCtx;
    ctx.clearRect(0, 0, W, H);

    if (!state.konvaRect) return;

    const rw = state.konvaRect.width() * state.konvaRect.scaleX();
    const rh = state.konvaRect.height() * state.konvaRect.scaleY();
    const rx = state.konvaRect.x();
    const ry = state.konvaRect.y();
    const rot = state.konvaRect.rotation() * Math.PI / 180;

    // Rect rotates around its (x,y) = top-left corner.
    // Compute visual center accounting for rotation.
    const cx = rx + (rw / 2) * Math.cos(rot) - (rh / 2) * Math.sin(rot);
    const cy = ry + (rw / 2) * Math.sin(rot) + (rh / 2) * Math.cos(rot);

    // Dim overlay with evenodd cutout for the rotated rect
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
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

// Event-driven update: called on rect drag/transform
function onCalibRectChange() {
    updateDividers();
    drawDimOverlay();
    updateCalibCoords();
}

// Slow interval (2s) for ambient updates: window resize + AI reading
function startCalibInterval() {
    stopCalibInterval();
    state.calibInterval = setInterval(() => {
        if (!state.calibMode) return;
        const changed = syncOverlay();
        syncKonvaSize();
        if (changed) drawDimOverlay();
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
    if (reading !== null) {
        dom.calibAiValue.textContent = reading.toFixed(2);
        dom.calibAiConf.textContent = state.lastAiResult.confidence + '%';
    } else {
        dom.calibAiValue.textContent = '--';
        dom.calibAiConf.textContent = '';
    }
}

function updateCalibCoords() {
    const el = document.getElementById('calib-coords');
    if (!el || !state.konvaRect) { if (el) el.textContent = ''; return; }
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

export function previewRoi() {
    const coords = computeRoiCoords();
    if (!coords) { log('No rectangle'); return; }
    const rect = state.konvaRect;
    const rw = rect.width() * rect.scaleX();
    const rh = rect.height() * rect.scaleY();
    log('=== PREVIEW (not sent) ===');
    const _imgW = dom.cam.naturalWidth || CAL_W;
    const _dispW = state.konvaStage ? state.konvaStage.width() : 0;
    log('  Image: ' + _imgW + 'x' + (dom.cam.naturalHeight || CAL_H) + ' | stage: ' + Math.round(_dispW) + 'x' + Math.round(state.konvaStage ? state.konvaStage.height() : 0) + ' | pxScale: ' + (_dispW / _imgW).toFixed(2) + ' | FlipY: ' + (document.getElementById('calibFlipY')?.checked));
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

export async function enterCalibMode() {
    if (!dom.cam.src || dom.cam.style.display === 'none') { log('No frame'); return; }
    if (state.drawerOpen) toggleDrawer();

    // Force full image mode — calibration needs 640x480 for correct coordinate mapping
    const wasNarrow = dom.cam.naturalWidth && dom.cam.naturalWidth < 320;
    if (wasNarrow || !dom.cam.naturalWidth) {
        log('Switching to FULL IMAGE for calibration...');
        await sendCommand('SHOW_FULL_IMAGE');
        // Wait for the stream to switch (poll naturalWidth, max 3s)
        const t0 = performance.now();
        while (dom.cam.naturalWidth < 320 && performance.now() - t0 < 3000) {
            await new Promise(r => setTimeout(r, 200));
        }
        if (dom.cam.naturalWidth < 320) {
            log('WARNING: image may not have switched to full mode');
        } else {
            log(`Full image active: ${dom.cam.naturalWidth}×${dom.cam.naturalHeight}`);
        }
    }

    state.calibMode = true;
    syncOverlay();

    if (!state.konvaStage) {
        initKonvaCalib();
    } else {
        syncKonvaSize();
        updateDividers();
    }

    dom.overlayCanvas.classList.add('active');
    dom.konvaContainer.classList.add('active');
    dom.actionBar.classList.remove('visible');
    dom.calibBar.classList.add('visible');

    // Draw once on enter
    drawDimOverlay();
    updateCalibCoords();
    updateCalibReading();

    // Start slow interval for ambient updates (resize, AI reading)
    startCalibInterval();
    log('Calibration mode ON — image: ' + dom.cam.naturalWidth + 'x' + dom.cam.naturalHeight + ' — position rect over digits');
}

export function exitCalibMode() {
    state.calibMode = false;
    stopCalibInterval();
    dom.overlayCanvas.classList.remove('active');
    dom.overlayCtx.clearRect(0, 0, dom.overlayCanvas.width, dom.overlayCanvas.height);
    dom.konvaContainer.classList.remove('active');
    dom.calibBar.classList.remove('visible');
    dom.actionBar.classList.add('visible');
    log('Calibration mode OFF');
}

export function drawCalibOverlay() {
    // Called when digit selector changes
    onCalibRectChange();
    if (state.konvaLayer) state.konvaLayer.draw();
}

export function onCalibDigitChange(value) {
    state.calibDigits = value;
    drawCalibOverlay();
}

export function computeRoiCoords() {
    if (!state.konvaRect || !state.konvaStage) return null;
    // Use Konva stage dimensions (stable — set when calib mode was entered)
    const dispW = state.konvaStage.width();
    const dispH = state.konvaStage.height();
    const imgW = dom.cam.naturalWidth || CAL_W;
    const imgH = dom.cam.naturalHeight || CAL_H;
    const pxScale = dispW / imgW; // display pixels per image pixel
    const calScaleX = CAL_W / imgW;
    const calScaleY = CAL_H / imgH;
    const flipY = document.getElementById('calibFlipY')?.checked ?? false;
    const rect = state.konvaRect;
    const rw = rect.width() * rect.scaleX();
    const rh = rect.height() * rect.scaleY();
    const cx = rect.x() + rw / 2;
    const cy = rect.y() + rh / 2;
    const rot = rect.rotation() * Math.PI / 180;
    const n = state.calibDigits;
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

        // Convert display coords → calibration coords (320x240)
        const topSx = Math.round(topDispX / pxScale * calScaleX);
        const botSx = Math.round(botDispX / pxScale * calScaleX);

        let topSy, botSy;
        if (flipY) {
            // Bottom-left origin (sensor convention): Y increases upward
            topSy = Math.round(CAL_H - topDispY / pxScale * calScaleY);
            botSy = Math.round(CAL_H - botDispY / pxScale * calScaleY);
        } else {
            // Top-left origin (screen convention)
            topSy = Math.round(topDispY / pxScale * calScaleY);
            botSy = Math.round(botDispY / pxScale * calScaleY);
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

    const boundaryX = Math.round(digitW / pxScale * calScaleX);
    const boundaryY = Math.round(rh / pxScale * calScaleY);

    return { numDigits: n, digits, boundaryX, boundaryY, rotation: rect.rotation() };
}

export async function computeAndSendRoi() {
    const coords = computeRoiCoords();
    if (!coords) { log('No rectangle'); return; }

    const { numDigits: n, digits, rotation } = coords;

    // Use drawer boundary values (default 70x70), not computed from rect dimensions
    const boundaryX = parseInt(document.getElementById('roiBoundX').value) || 70;
    const boundaryY = parseInt(document.getElementById('roiBoundY').value) || 70;

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
