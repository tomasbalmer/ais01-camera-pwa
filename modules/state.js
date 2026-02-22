// === Shared mutable state ===
export const state = {
    device: null,
    epOutNum: null,
    running: false,
    rawEnabled: false,
    frameCount: 0,
    fpsCount: 0,
    lastFpsTime: 0,
    currentFps: 0,
    lastAiResult: null,
    drawerOpen: false,
    activeMode: 'validate', // 'validate' | 'calibrate' | 'settings'
    imageMode: null,         // null (unknown) | 'full' | 'roi' — detected from frame dims

    // Calibration state
    calibMode: false,
    calibDigits: 6,
    calibInterval: null,
    calibRectTouched: false,

    // Konva calibration objects
    konvaStage: null,
    konvaLayer: null,
    konvaRect: null,
    konvaTransformer: null,
    konvaDividers: null,
};
