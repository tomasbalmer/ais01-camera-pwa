/*
 * calib-canvas.js — Native canvas interactive calibration rectangle
 *
 * Replaces Konva.js with ~200 lines of vanilla canvas.
 * Supports: drag, 8-handle resize, rotation, digit dividers, boundary clamping.
 * Works with both mouse and touch (via pointer events).
 */

const HANDLE_R = 4;       // handle radius (px) — visual
const STEM_LEN = 36;      // stem length extending outward from rect
const HIT_R = 20;         // hit-test radius (px) — touch-friendly (on stem tip)
const ROT_OFFSET = 24;    // rotation handle distance above top edge
const MIN_W = 30;
const MIN_H = 20;
const STYLE = {
    fill: 'rgba(56, 189, 248, 0.04)',
    stroke: 'rgba(56, 189, 248, 0.7)',
    divider: 'rgba(56, 189, 248, 0.4)',
    handleFill: 'rgba(15, 23, 42, 0.9)',
    handleStroke: '#38bdf8',
    rotLine: 'rgba(56, 189, 248, 0.6)',
};

// 8 handle positions relative to rect center + outward direction for stems
const S = 0.707; // sin(45°) for diagonal normalization
function localHandles(hw, hh) {
    return [
        { x: -hw, y: -hh, dx: -S, dy: -S }, // 0 top-left
        { x:   0, y: -hh, dx:  0, dy: -1 }, // 1 top-center
        { x:  hw, y: -hh, dx:  S, dy: -S }, // 2 top-right
        { x:  hw, y:   0, dx:  1, dy:  0 }, // 3 middle-right
        { x:  hw, y:  hh, dx:  S, dy:  S }, // 4 bottom-right
        { x:   0, y:  hh, dx:  0, dy:  1 }, // 5 bottom-center
        { x: -hw, y:  hh, dx: -S, dy:  S }, // 6 bottom-left
        { x: -hw, y:   0, dx: -1, dy:  0 }, // 7 middle-left
    ];
}

// Which edges each handle controls: [left, top, right, bottom]
const HANDLE_EDGES = [
    [1,1,0,0], // 0 TL
    [0,1,0,0], // 1 TC
    [0,1,1,0], // 2 TR
    [0,0,1,0], // 3 MR
    [0,0,1,1], // 4 BR
    [0,0,0,1], // 5 BC
    [1,0,0,1], // 6 BL
    [1,0,0,0], // 7 ML
];

export function createCalibOverlay(canvas, onChange) {
    const ctx = canvas.getContext('2d');
    let W = canvas.width, H = canvas.height;
    let digits = 6;

    // Rect state: x,y is top-left corner (before rotation), rot in degrees
    let rect = { x: 0, y: 0, w: 100, h: 50, rot: 0 };

    // Interaction
    let action = null;  // null | 'move' | 'rotate' | 0-7 (handle index)
    let start = null;   // { mx, my, rect: {...} }

    // --- Coordinate helpers ---

    function center() {
        return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    }

    function rotRad() { return rect.rot * Math.PI / 180; }

    function toLocal(px, py) {
        const c = center(), r = -rotRad();
        const dx = px - c.x, dy = py - c.y;
        return { x: dx * Math.cos(r) - dy * Math.sin(r),
                 y: dx * Math.sin(r) + dy * Math.cos(r) };
    }

    // --- Hit testing ---

    function hitTest(px, py) {
        const loc = toLocal(px, py);
        const hw = rect.w / 2, hh = rect.h / 2;

        // Rotation handle
        const ry = -hh - ROT_OFFSET;
        if (loc.x * loc.x + (loc.y - ry) * (loc.y - ry) < HIT_R * HIT_R) return 'rotate';

        // Resize handles (hit-test on stem tip, not rect edge)
        const handles = localHandles(hw, hh);
        for (let i = 0; i < 8; i++) {
            const tipX = handles[i].x + handles[i].dx * STEM_LEN;
            const tipY = handles[i].y + handles[i].dy * STEM_LEN;
            const dx = loc.x - tipX, dy = loc.y - tipY;
            if (dx * dx + dy * dy < HIT_R * HIT_R) return i;
        }

        // Move (inside rect)
        if (Math.abs(loc.x) <= hw && Math.abs(loc.y) <= hh) return 'move';

        return null;
    }

    // --- Boundary clamping (rotated AABB inside stage) ---

    function clampToStage() {
        const c = center(), r = rotRad();
        const hw = rect.w / 2, hh = rect.h / 2;
        const cos = Math.abs(Math.cos(r)), sin = Math.abs(Math.sin(r));
        const bw = hw * cos + hh * sin;  // half-width of AABB
        const bh = hw * sin + hh * cos;  // half-height of AABB
        const cx = Math.max(bw, Math.min(W - bw, c.x));
        const cy = Math.max(bh, Math.min(H - bh, c.y));
        rect.x = cx - hw;
        rect.y = cy - hh;
    }

    // --- Drawing ---

    function draw() {
        ctx.clearRect(0, 0, W, H);
        const c = center(), r = rotRad();
        const hw = rect.w / 2, hh = rect.h / 2;

        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.rotate(r);

        // Fill + border
        ctx.fillStyle = STYLE.fill;
        ctx.strokeStyle = STYLE.stroke;
        ctx.lineWidth = 1;
        ctx.fillRect(-hw, -hh, rect.w, rect.h);
        ctx.strokeRect(-hw, -hh, rect.w, rect.h);

        // Digit dividers
        ctx.strokeStyle = STYLE.divider;
        const dw = rect.w / digits;
        for (let i = 1; i < digits; i++) {
            const lx = -hw + dw * i;
            ctx.beginPath();
            ctx.moveTo(lx, -hh);
            ctx.lineTo(lx, hh);
            ctx.stroke();
        }

        // Resize handles with stems extending outward
        const handles = localHandles(hw, hh);
        for (const h of handles) {
            const tipX = h.x + h.dx * STEM_LEN;
            const tipY = h.y + h.dy * STEM_LEN;
            // Stem line
            ctx.beginPath();
            ctx.moveTo(h.x, h.y);
            ctx.lineTo(tipX, tipY);
            ctx.strokeStyle = STYLE.rotLine;
            ctx.lineWidth = 1;
            ctx.stroke();
            // Handle circle at tip
            ctx.beginPath();
            ctx.arc(tipX, tipY, HANDLE_R, 0, Math.PI * 2);
            ctx.fillStyle = STYLE.handleFill;
            ctx.fill();
            ctx.strokeStyle = STYLE.handleStroke;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }

        // Rotation handle + stem
        const ry = -hh - ROT_OFFSET;
        ctx.beginPath();
        ctx.moveTo(0, -hh);
        ctx.lineTo(0, ry);
        ctx.strokeStyle = STYLE.rotLine;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, ry, HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle = STYLE.handleFill;
        ctx.fill();
        ctx.strokeStyle = STYLE.handleStroke;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.restore();
    }

    // --- Throttled redraw (once per animation frame) ---

    let rafPending = false;
    function scheduleRedraw() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            rafPending = false;
            draw();
            onChange();
        });
    }

    // --- Pointer events ---

    function ptrPos(e) {
        const br = canvas.getBoundingClientRect();
        return { x: e.clientX - br.left, y: e.clientY - br.top };
    }

    function onDown(e) {
        const p = ptrPos(e);
        const hit = hitTest(p.x, p.y);
        if (hit === null) return;
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        action = hit;
        start = { mx: p.x, my: p.y, rect: { ...rect } };
    }

    function onMove(e) {
        if (action === null) {
            // Cursor hint
            const p = ptrPos(e);
            const hit = hitTest(p.x, p.y);
            canvas.style.cursor = hit === null ? 'default'
                : hit === 'move' ? 'move'
                : hit === 'rotate' ? 'crosshair' : 'nwse-resize';
            return;
        }
        e.preventDefault();
        const p = ptrPos(e);
        const s = start;

        if (action === 'move') {
            rect.x = s.rect.x + (p.x - s.mx);
            rect.y = s.rect.y + (p.y - s.my);
            clampToStage();
        } else if (action === 'rotate') {
            const c = { x: s.rect.x + s.rect.w / 2, y: s.rect.y + s.rect.h / 2 };
            const angle = Math.atan2(p.x - c.x, -(p.y - c.y)) * 180 / Math.PI;
            // Snap to 0/90/180/270 within 5 degrees
            const snapped = [0, 90, 180, 270, -90, -180].find(a => Math.abs(angle - a) < 5);
            rect.rot = snapped !== undefined ? snapped : angle;
            clampToStage();
        } else {
            // Resize: handle index 0-7
            resizeFromHandle(action, p.x, p.y);
        }

        scheduleRedraw();
    }

    function onUp(e) {
        if (action !== null) {
            canvas.releasePointerCapture(e.pointerId);
            action = null;
            start = null;
        }
    }

    function resizeFromHandle(idx, mx, my) {
        const s = start.rect;
        const sc = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
        const r = -s.rot * Math.PI / 180;
        const cos = Math.cos(r), sin = Math.sin(r);

        // Mouse in local (unrotated) space of the *original* rect
        const dx = mx - sc.x, dy = my - sc.y;
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;

        // Current edges in local space
        let left = -s.w / 2, right = s.w / 2;
        let top = -s.h / 2, bottom = s.h / 2;

        const edges = HANDLE_EDGES[idx];
        if (edges[0]) left = Math.min(lx, right - MIN_W);
        if (edges[2]) right = Math.max(lx, left + MIN_W);
        if (edges[1]) top = Math.min(ly, bottom - MIN_H);
        if (edges[3]) bottom = Math.max(ly, top + MIN_H);

        const nw = right - left;
        const nh = bottom - top;
        const nlx = (left + right) / 2;  // new center in local space
        const nly = (top + bottom) / 2;

        // Convert new local center back to canvas space
        const rr = s.rot * Math.PI / 180;
        const cos2 = Math.cos(rr), sin2 = Math.sin(rr);
        const ncx = sc.x + nlx * cos2 - nly * sin2;
        const ncy = sc.y + nlx * sin2 + nly * cos2;

        rect.w = nw;
        rect.h = nh;
        rect.x = ncx - nw / 2;
        rect.y = ncy - nh / 2;
        rect.rot = s.rot;
        clampToStage();
    }

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.style.touchAction = 'none';  // prevent scroll while interacting

    // --- Public API ---

    return {
        draw,

        resize(w, h) {
            if (w === W && h === H) return;
            if (!w || !h) return;  // skip zero/invalid dimensions
            W = w; H = h;
            canvas.width = w;
            canvas.height = h;
            draw();
        },

        setRect(x, y, w, h, rot) {
            rect = { x, y, w, h, rot: rot || 0 };
            draw();
        },

        getRect() {
            return { ...rect };
        },

        setDigits(n) {
            digits = n;
            draw();
        },

        stageWidth() { return W; },
        stageHeight() { return H; },

        destroy() {
            canvas.removeEventListener('pointerdown', onDown);
            canvas.removeEventListener('pointermove', onMove);
            canvas.removeEventListener('pointerup', onUp);
        },
    };
}
