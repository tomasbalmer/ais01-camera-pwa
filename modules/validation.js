import { VALIDATION } from './constants.js';
import { state } from './state.js';
import { dom, syncOverlay, log, toggleDrawer } from './ui.js';

// === Position Validation ===
export function analyzeFrame() {
    const c = document.createElement('canvas');
    c.width = dom.cam.naturalWidth || 640;
    c.height = dom.cam.naturalHeight || 480;
    const ctx = c.getContext('2d');
    ctx.drawImage(dom.cam, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const W = c.width, H = c.height;

    let sum = 0, sumSq = 0, cnt = 0, saturated = 0, totalPx = 0;
    let gradSum = 0, gradCnt = 0;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const v = data[i];
            totalPx++;
            if (v > VALIDATION.SATURATION_THRESHOLD) saturated++;
            const inCenter = x > W * VALIDATION.CENTER_MIN && x < W * VALIDATION.CENTER_MAX
                          && y > H * VALIDATION.CENTER_MIN && y < H * VALIDATION.CENTER_MAX;
            if (inCenter) {
                sum += v; sumSq += v * v; cnt++;
                if (x < W * VALIDATION.CENTER_MAX - 1) {
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

export function showValidationOverlay(r) {
    syncOverlay();
    dom.overlayCanvas.classList.add('active');
    const ctx = dom.overlayCtx;
    const W = dom.overlayCanvas.width, H = dom.overlayCanvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, W, H);

    const checks = [
        { label: 'Brightness', val: r.brightness.toFixed(0), ok: r.brightness > VALIDATION.BRIGHTNESS_MIN && r.brightness < VALIDATION.BRIGHTNESS_MAX },
        { label: 'Flash glare', val: r.flashPct.toFixed(1) + '%', ok: r.flashPct < VALIDATION.FLASH_MAX_PCT },
        { label: 'Contrast', val: r.contrast.toFixed(0), ok: r.contrast > VALIDATION.CONTRAST_MIN },
        { label: 'Edge detail', val: r.edgeStrength.toFixed(1), ok: r.edgeStrength > VALIDATION.EDGE_STRENGTH_MIN },
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

    setTimeout(() => { dom.overlayCanvas.classList.remove('active'); ctx.clearRect(0, 0, W, H); }, VALIDATION.OVERLAY_DURATION_MS);
}

export function onValidatePosition() {
    if (!dom.cam.src || dom.cam.style.display === 'none') { log('No frame to analyze'); return; }
    const results = analyzeFrame();
    log(`Validate: brightness=${results.brightness.toFixed(0)} contrast=${results.contrast.toFixed(0)} flash=${results.flashPct.toFixed(1)}% edges=${results.edgeStrength.toFixed(1)}`);
    showValidationOverlay(results);
    if (state.drawerOpen) toggleDrawer();
}
