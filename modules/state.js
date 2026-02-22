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

    // Calibration state
    calibMode: false,
    calibDigits: 6,
    calibInterval: null,

    // Konva calibration objects
    konvaStage: null,
    konvaLayer: null,
    konvaRect: null,
    konvaTransformer: null,
    konvaDividers: null,
};
