# Calibración Táctil de ROI + Validación de Posición

Stage: `Done`
Last Updated: 2026-02-21

## High-Level Objective

Agregar dos features críticas para el flujo de instalación en campo del sensor AIS01-LB. **Calibración Táctil**: permite al operario dibujar un rectángulo sobre los dígitos del medidor en la imagen en vivo y la app calcula automáticamente las coordenadas ROI para el sensor. **Validación de Posición**: analiza la imagen en tiempo real para guiar al operario sobre si la cámara está bien posicionada (brillo, flash, enfoque, distancia).

Ambas features eliminan la necesidad del software Windows propietario y permiten calibración completa desde el celular Android en campo.

## Mid-Level Objectives

- [x] Imagen más grande en pantalla (sin zoom por ahora, pero maximizar uso del espacio)
- [x] Modo calibración: el operario dibuja UN rectángulo sobre los dígitos arrastrando con el dedo
- [x] División automática del rectángulo en N partes iguales (4-8 dígitos configurable)
- [x] Cálculo de coordenadas ROI en pixels del sensor (640x480) y envío via protocolo C0 5A
- [x] Overlay visual de los rectángulos de dígitos sobre la imagen en vivo
- [x] Validación de posición con análisis de imagen: brillo, saturación, contraste, bordes
- [x] Feedback visual claro para el operario: indicadores de estado por cada criterio

## Context

### Hardware y Imagen

- **Sensor**: Himax HM0360, grayscale, resolución nativa **640x480** pixels
- **Output**: JPEG comprimido (~3-6 KB por frame), ~1.8 FPS
- **Escenario**: Medidores de agua (marca GENEBRE y similares) con **6 dígitos** tipo digit wheel
- **Iluminación**: Flash LED integrado en el sensor. Opera tanto de día como de noche
- **Montaje**: Cámara fija apuntando a la cara del medidor, distancia ~5-15 cm

### Análisis de la Imagen de Referencia (GENEBRE 163482)

```
  Imagen 640x480 (grayscale, JPEG):
  ┌────────────────────────────────────────┐
  │              GENEBRE                    │ ← Marca del medidor
  │                                         │
  │    ┌───┬───┬───┬───┬───┬───┐           │ ← Zona de dígitos (~30% ancho)
  │    │ 1 │ 6 │ 3 │ 4 │ 8 │ 2 │  m³      │    Y: ~35-45% de la altura
  │    └───┴───┴───┴───┴───┴───┘           │    X: ~15-65% del ancho
  │         CE info...                      │
  │                                         │
  │    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓            │ ← Reflejo del flash (saturación)
  └────────────────────────────────────────┘
```

**Observaciones clave:**
- Los dígitos son oscuros sobre fondo claro (buen contraste)
- Cada dígito ocupa ~50px de ancho en la imagen de 640px
- El flash genera una zona saturada en la parte inferior (problema a detectar)
- La imagen es mayormente oscura excepto la cara del medidor

### Mapeo de Coordenadas Touch → Sensor

La imagen de 640x480 se muestra escalada en el celular (~360px de ancho en un phone típico). Para convertir coordenadas de toque a coordenadas del sensor:

```
scale_x = 640 / img_display_width
scale_y = 480 / img_display_height

sensor_x = touch_x_relative_to_img * scale_x
sensor_y = touch_y_relative_to_img * scale_y
```

El `<img>` con `object-fit: contain` puede tener padding (letterbox), que hay que descontar del touch point.

### Protocolo ROI (de spec 001)

La calibración envía 2 frames:
1. **SET MODE**: `C0 5A 03 05 00 00 50` (Digit Wheel, payload=80 bytes)
2. **ROI DATA**: `C0 5A 03 03 [80 bytes]`

Payload de 80 bytes — Sección relevante (Digit ROI Points):
- 8 pares (x, y) como uint16 Little Endian = 32 bytes
- Cada par es el **centro** del rectángulo de cada dígito
- Después: numDigits (u16), numDials=0 (u16), 8 bytes reserved, 32 bytes dials (zeros), boundary_x (u16), boundary_y (u16)

**Boundary**: define el tamaño del rectángulo alrededor de cada punto centro. Es igual para todos los dígitos. Según la documentación de Dragino, los puntos se extraen manualmente de una BMP usando una herramienta de dibujo. La doc dice "The (x,y) coordinate on the image is located at the bottom left corner" refiriéndose al origen del sistema de coordenadas. No especifica explícitamente si es centro o esquina del dígito. Los valores de boundary observados en sniffing son 70x70. **Se verificará empíricamente si boundary es tamaño total o radio.**

### Estado Actual de la PWA

- Stream JPEG en vivo funcionando en Android
- Bottom action bar con Full/ROI/RAW/Stop
- Drawer lateral con Sensor Config y ROI Setting (inputs manuales)
- AI Result visible en stats bar
- Layout mobile-first con flexbox (sin position:fixed)

### Análisis de Imagen con Canvas

El browser puede analizar pixels de un JPEG usando Canvas 2D:

```javascript
const canvas = document.createElement('canvas');
canvas.width = 640;
canvas.height = 480;
const ctx = canvas.getContext('2d');
ctx.drawImage(imgElement, 0, 0);
const imageData = ctx.getImageData(0, 0, 640, 480);
const pixels = imageData.data; // RGBA, 4 bytes per pixel
```

Métricas extraíbles:
- **Brillo medio**: promedio de valores de pixel (grayscale → R=G=B)
- **Saturación**: % de pixels > 240 (zones quemadas por flash)
- **Contraste**: desviación estándar de valores de pixel
- **Bordes**: gradiente horizontal/vertical (Sobel simplificado) — detecta presencia de dígitos
- **Distribución espacial**: analizar por zonas (centro vs bordes) para detectar problemas

## Proposed Solution

### Feature 1: Calibración Táctil

Agregar un **modo calibración** accesible desde el action bar. Al activarlo:

1. La imagen se congela en el último frame (para estabilidad al dibujar)
2. Aparece un selector de cantidad de dígitos (4-8)
3. El operario toca y arrastra sobre la imagen para dibujar UN rectángulo
4. La app divide el rectángulo en N partes iguales y muestra el overlay
5. Un botón "Enviar ROI" calcula los centros y envía al sensor
6. El stream se reanuda y el operario puede verificar el resultado

**Cálculo de centros desde el rectángulo:**
```
Para N dígitos en rectángulo (x1,y1)→(x2,y2):
  width_per_digit = (x2 - x1) / N
  center_y = (y1 + y2) / 2

  Para dígito i (0-indexed):
    center_x = x1 + width_per_digit * i + width_per_digit / 2

  Boundary: width_per_digit × (y2 - y1)
```

### Feature 2: Validación de Posición

Agregar un botón "Validar" en el action bar que analiza el frame actual y muestra un panel con indicadores:

| Indicador | Bien | Mal | Cómo medir |
|-----------|------|-----|------------|
| **Brillo** | 40-180 promedio | <30 o >200 | Media de pixels en zona central |
| **Flash** | <5% saturados | >15% saturados | % pixels > 240 en zona inferior |
| **Contraste** | StdDev > 30 | StdDev < 15 | Desviación estándar en zona central |
| **Bordes** | Gradiente > umbral | Gradiente bajo | Sobel simplificado en zona central |

El resultado se muestra como una card overlay sobre la imagen con semáforo por cada criterio.

### Flujo Completo del Operario

```
Conectar → Ver stream → [Validar Posición] → Ajustar cámara si necesario
                                ↓
                         [Calibrar ROI] → Dibujar rectángulo → Enviar
                                ↓
                         Verificar AI Result → Listo
```

## Implementation Notes

### Phase 5: Imagen Más Grande + Canvas Overlay

Ajustar CSS para maximizar la imagen. Agregar un `<canvas>` overlay sobre la imagen que se usará tanto para validación como para calibración.

- [x] Step 5.1: Agrandar la imagen
  - MODIFY `style.css` — hacer que `#cam` use `width: 100%` para llenar el ancho:
    ```diff
     #cam {
         display: none;
    -    max-width: 100%;
    -    max-height: 100%;
    +    width: 100%;
    +    height: auto;
    +    max-height: 100%;
         object-fit: contain;
     }
    ```

- [x] Step 5.2: Agregar canvas overlay en HTML
  - MODIFY `index.html` — agregar `<canvas>` dentro de `#viewer`, sobre la imagen:
    ```diff
     <main id="viewer">
         <img id="cam" />
    +    <canvas id="overlay-canvas"></canvas>
         <div id="connect-screen">
    ```

- [x] Step 5.3: Estilizar canvas overlay
  - MODIFY `style.css` — posicionar canvas exactamente sobre la imagen:
    ```diff
    +#overlay-canvas {
    +    display: none;
    +    position: absolute;
    +    top: 0;
    +    left: 0;
    +    pointer-events: none;
    +}
    +#overlay-canvas.active {
    +    display: block;
    +    pointer-events: auto;
    +}
    ```

- [x] Step 5.4: Agregar función `getImageRect()` para mapeo de coordenadas
  - MODIFY `app.js` — calcula la posición real de la imagen renderizada dentro del `<img>` (accounting for object-fit: contain letterbox):
    ```javascript
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
    ```

- [x] Step 5.5: Agregar función `syncOverlay()` para posicionar el canvas
  - MODIFY `app.js` — redimensiona el canvas para que coincida con la imagen renderizada:
    ```javascript
    const overlayCanvas = document.getElementById('overlay-canvas');
    const overlayCtx = overlayCanvas.getContext('2d');

    function syncOverlay() {
        const r = getImageRect();
        overlayCanvas.style.left = (cam.offsetLeft + r.ox) + 'px';
        overlayCanvas.style.top = (cam.offsetTop + r.oy) + 'px';
        overlayCanvas.width = r.w;
        overlayCanvas.height = r.h;
    }
    ```

**Verification**
- Abrir PWA en Android, conectar cámara
- Verificar que la imagen ocupa el ancho completo de la pantalla
- Verificar en DevTools que `#overlay-canvas` existe (hidden por defecto)

---

### Phase 6: Validación de Posición

Agregar botón "Validate" en el drawer que analiza el frame actual usando Canvas y muestra resultados como un overlay sobre la imagen.

- [x] Step 6.1: Agregar función `analyzeFrame()`
  - MODIFY `app.js` — dibuja el frame actual en un canvas offscreen, analiza 4 métricas:
    ```javascript
    function analyzeFrame() {
        const c = document.createElement('canvas');
        c.width = cam.naturalWidth || 640;
        c.height = cam.naturalHeight || 480;
        const ctx = c.getContext('2d');
        ctx.drawImage(cam, 0, 0);
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        const W = c.width, H = c.height;

        // Center region (20%-80% x, 20%-80% y)
        let sum = 0, sumSq = 0, cnt = 0, saturated = 0, totalPx = 0;
        let gradSum = 0, gradCnt = 0;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                const v = data[i]; // grayscale: R channel
                totalPx++;
                if (v > 240) saturated++;
                const inCenter = x > W * 0.2 && x < W * 0.8 && y > H * 0.2 && y < H * 0.8;
                if (inCenter) {
                    sum += v; sumSq += v * v; cnt++;
                    // Horizontal gradient
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
    ```

- [x] Step 6.2: Agregar función `showValidationOverlay(results)`
  - MODIFY `app.js` — dibuja resultados en el overlay canvas:
    ```javascript
    function showValidationOverlay(r) {
        syncOverlay();
        overlayCanvas.classList.add('active');
        const ctx = overlayCtx;
        const W = overlayCanvas.width, H = overlayCanvas.height;
        ctx.clearRect(0, 0, W, H);

        // Semi-transparent background
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

        // Auto-dismiss after 4 seconds
        setTimeout(() => { overlayCanvas.classList.remove('active'); ctx.clearRect(0, 0, W, H); }, 4000);
    }

    function onValidatePosition() {
        if (!cam.src || cam.style.display === 'none') { log('No frame to analyze'); return; }
        const results = analyzeFrame();
        log(`Validate: brightness=${results.brightness.toFixed(0)} contrast=${results.contrast.toFixed(0)} flash=${results.flashPct.toFixed(1)}% edges=${results.edgeStrength.toFixed(1)}`);
        showValidationOverlay(results);
        if (drawerOpen) toggleDrawer();
    }
    ```

- [x] Step 6.3: Agregar botón "Validate Position" en el drawer
  - MODIFY `index.html` — agregar sección antes de Sensor Config:
    ```diff
         <div class="drawer-content">
    +        <!-- Quick Actions -->
    +        <div class="drawer-section">
    +            <button class="drawer-action" onclick="onValidatePosition()">
    +                <span>Validate Position</span>
    +            </button>
    +        </div>
             <!-- Sensor Config Section -->
    ```

- [x] Step 6.4: Agregar estilo `.drawer-action`
  - MODIFY `style.css`:
    ```diff
    +.drawer-action {
    +    display: flex;
    +    align-items: center;
    +    gap: 8px;
    +    width: 100%;
    +    padding: 14px;
    +    background: none;
    +    border: none;
    +    color: var(--text);
    +    font-size: 14px;
    +    font-weight: 600;
    +    cursor: pointer;
    +    touch-action: manipulation;
    +    -webkit-tap-highlight-color: transparent;
    +    text-align: left;
    +}
    +.drawer-action:active { background: rgba(255,255,255,0.05); }
    ```

**Verification**
- Conectar cámara, abrir drawer, tap "Validate Position"
- Verificar que aparece overlay con 4 métricas y semáforo
- Verificar que se auto-cierra después de 4 segundos
- Verificar en log que se imprimen los valores

---

### Phase 7: Calibración Táctil de ROI

Modo calibración fullscreen: el operario dibuja un rectángulo sobre los dígitos, la app divide en N partes, muestra overlay, y envía las coordenadas ROI al sensor.

- [x] Step 7.1: Agregar estado de calibración
  - MODIFY `app.js` — nuevas variables de estado:
    ```javascript
    let calibMode = false;
    let calibRect = null;      // {x1, y1, x2, y2} in canvas coords
    let calibDigits = 6;
    let calibDragging = false;
    let calibStartPt = null;
    ```

- [x] Step 7.2: Agregar función `enterCalibMode()` / `exitCalibMode()`
  - MODIFY `app.js`:
    ```javascript
    function enterCalibMode() {
        if (!cam.src || cam.style.display === 'none') { log('No frame'); return; }
        calibMode = true;
        calibRect = null;
        freezeStream = true; // freeze on current frame
        syncOverlay();
        overlayCanvas.classList.add('active');
        document.getElementById('calib-toolbar').style.display = 'flex';
        if (drawerOpen) toggleDrawer();
        drawCalibOverlay();
        log('Calibration mode ON');
    }

    function exitCalibMode() {
        calibMode = false;
        calibRect = null;
        freezeStream = false;
        overlayCanvas.classList.remove('active');
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        document.getElementById('calib-toolbar').style.display = 'none';
        log('Calibration mode OFF');
    }
    ```

- [x] Step 7.3: Agregar `freezeStream` a la lógica de display
  - MODIFY `app.js` — agregar variable `let freezeStream = false;` y condicionar la actualización de `cam.src`:
    ```diff
    +let freezeStream = false;
     ...
     // Inside extractAndDisplayFrames, wrap cam.src update:
    +if (!freezeStream) {
         const blob = new Blob([jpeg], { type: 'image/jpeg' });
         ...
         cam.src = url;
    +}
     frameCount++;
     fpsCount++;
    ```

- [x] Step 7.4: Agregar touch handlers para dibujar rectángulo
  - MODIFY `app.js`:
    ```javascript
    overlayCanvas.addEventListener('touchstart', (e) => {
        if (!calibMode) return;
        e.preventDefault();
        const t = e.touches[0];
        const rect = overlayCanvas.getBoundingClientRect();
        calibStartPt = { x: t.clientX - rect.left, y: t.clientY - rect.top };
        calibDragging = true;
        calibRect = null;
    }, { passive: false });

    overlayCanvas.addEventListener('touchmove', (e) => {
        if (!calibDragging) return;
        e.preventDefault();
        const t = e.touches[0];
        const rect = overlayCanvas.getBoundingClientRect();
        const x = t.clientX - rect.left;
        const y = t.clientY - rect.top;
        calibRect = {
            x1: Math.min(calibStartPt.x, x), y1: Math.min(calibStartPt.y, y),
            x2: Math.max(calibStartPt.x, x), y2: Math.max(calibStartPt.y, y),
        };
        drawCalibOverlay();
    }, { passive: false });

    overlayCanvas.addEventListener('touchend', () => {
        calibDragging = false;
        if (calibRect) drawCalibOverlay();
    });
    ```

- [x] Step 7.5: Agregar función `drawCalibOverlay()`
  - MODIFY `app.js` — dibuja el rectángulo principal y los sub-rectángulos:
    ```javascript
    function drawCalibOverlay() {
        const W = overlayCanvas.width, H = overlayCanvas.height;
        const ctx = overlayCtx;
        ctx.clearRect(0, 0, W, H);

        if (!calibRect) {
            // Draw hint text
            ctx.fillStyle = 'rgba(0,0,0,0.4)';
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = '#fff';
            ctx.font = '14px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Draw a rectangle over the digits', W / 2, H / 2);
            return;
        }

        const { x1, y1, x2, y2 } = calibRect;
        const n = calibDigits;
        const dw = (x2 - x1) / n;

        // Dim outside selection
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, W, y1);
        ctx.fillRect(0, y2, W, H - y2);
        ctx.fillRect(0, y1, x1, y2 - y1);
        ctx.fillRect(x2, y1, W - x2, y2 - y1);

        // Sub-rectangles
        for (let i = 0; i < n; i++) {
            const sx = x1 + dw * i;
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(sx, y1, dw, y2 - y1);
            // Center dot
            ctx.fillStyle = '#38bdf8';
            ctx.beginPath();
            ctx.arc(sx + dw / 2, (y1 + y2) / 2, 3, 0, Math.PI * 2);
            ctx.fill();
        }

        // Outer rectangle
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }
    ```

- [x] Step 7.6: Agregar función `computeAndSendRoi()`
  - MODIFY `app.js` — convierte coordenadas canvas a sensor y envía:
    ```javascript
    function computeAndSendRoi() {
        if (!calibRect) { log('No rectangle drawn'); return; }
        const { ox, oy, w, h, scale } = getImageRect();
        // Canvas coords → sensor coords
        const sx1 = Math.round(calibRect.x1 / scale);
        const sy1 = Math.round(calibRect.y1 / scale);
        const sx2 = Math.round(calibRect.x2 / scale);
        const sy2 = Math.round(calibRect.y2 / scale);

        const n = calibDigits;
        const dw = (sx2 - sx1) / n;
        const cy = Math.round((sy1 + sy2) / 2);

        const digits = [];
        for (let i = 0; i < 8; i++) {
            if (i < n) {
                digits.push({ x: Math.round(sx1 + dw * i + dw / 2), y: cy });
            } else {
                digits.push({ x: 0, y: 0 });
            }
        }

        const boundaryX = Math.round(dw);
        const boundaryY = Math.round(sy2 - sy1);

        log(`ROI from touch: ${n} digits, boundary=${boundaryX}x${boundaryY}`);
        digits.slice(0, n).forEach((d, i) => log(`  D${i+1}: (${d.x}, ${d.y})`));

        sendRoiConfig({ numDigits: n, digits, boundaryX, boundaryY });

        // Also update the manual ROI inputs in the drawer
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
    ```

- [x] Step 7.7: Agregar UI de calibración
  - MODIFY `index.html` — agregar toolbar de calibración (visible solo en modo calib) y botón en drawer:
    ```diff
    +    <!-- Calibration toolbar (visible in calib mode) -->
    +    <div id="calib-toolbar">
    +        <select id="calibDigitSelect" onchange="calibDigits = +this.value; drawCalibOverlay()">
    +            <option value="4">4 digits</option>
    +            <option value="5">5 digits</option>
    +            <option value="6" selected>6 digits</option>
    +            <option value="7">7 digits</option>
    +            <option value="8">8 digits</option>
    +        </select>
    +        <button class="calib-btn send" onclick="computeAndSendRoi()">Send ROI</button>
    +        <button class="calib-btn cancel" onclick="exitCalibMode()">Cancel</button>
    +    </div>
    ```
    Y en el drawer, agregar botón "Calibrate ROI" después de "Validate Position":
    ```diff
    +        <div class="drawer-section">
    +            <button class="drawer-action" onclick="enterCalibMode()">
    +                <span>Calibrate ROI (Touch)</span>
    +            </button>
    +        </div>
    ```

- [x] Step 7.8: Agregar estilos para calibración
  - MODIFY `style.css`:
    ```css
    #calib-toolbar {
        display: none;
        position: absolute;
        bottom: 8px;
        left: 8px;
        right: 8px;
        gap: 6px;
        align-items: center;
        z-index: 20;
    }
    #calib-toolbar select {
        background: var(--bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px;
        font-size: 13px;
    }
    .calib-btn {
        flex: 1;
        padding: 10px;
        border: none;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        touch-action: manipulation;
    }
    .calib-btn.send { background: var(--accent); color: #000; }
    .calib-btn.cancel { background: var(--elevated); color: var(--text2); }
    ```

**Verification**
- Conectar cámara, abrir drawer, tap "Calibrate ROI (Touch)"
- Verificar que la imagen se congela y aparece hint "Draw a rectangle over the digits"
- Dibujar rectángulo con el dedo → sub-rectángulos aparecen con centros azules
- Cambiar selector a 5 dígitos → sub-rectángulos se re-dividen
- Tap "Send ROI" → verificar en log que se envían coordenadas y frames C0 5A
- Verificar que los inputs manuales del drawer se actualizan con las coordenadas calculadas
- Tap "Cancel" → imagen se descongela, overlay desaparece

## Success Criteria

- [ ] **SC-1**: Imagen ocupa el máximo espacio disponible en pantalla mobile
- [ ] **SC-2**: Validación de posición analiza brillo, flash, contraste y bordes con feedback visual
- [ ] **SC-3**: Operario puede dibujar rectángulo sobre dígitos con touch-drag
- [ ] **SC-4**: App divide rectángulo en N partes y muestra overlay de los sub-rectángulos
- [ ] **SC-5**: Coordenadas ROI se calculan correctamente y se envían via C0 5A protocol
- [ ] **SC-6**: Flujo completo funciona en Android Chrome via USB OTG

## Notes

### Referencia: Coordenadas de la Imagen de Ejemplo

Estimación de posiciones de dígitos en la imagen GENEBRE 163482 (640x480):
- Zona de dígitos: aprox X=96..416, Y=168..216 (ancho=320, alto=48)
- Cada dígito: ~53px de ancho, ~48px de alto
- Centros estimados: (122,192), (175,192), (228,192), (281,192), (334,192), (387,192)
- Boundary estimado: 53 × 48

### Limitaciones Conocidas

- La imagen es ~1.8 FPS, así que el análisis no necesita ser en tiempo real — analizar 1 frame es suficiente
- Grayscale: simplifica el análisis (1 canal en vez de 3)
- JPEG compression artifacts pueden afectar detección de bordes, pero a 640x480 el efecto es mínimo
- El pinch-to-zoom en un `<img>` requiere touch event handling manual o una librería ligera

### Decisiones Tomadas

- **Dígitos siempre equiespaciados**: Confirmado por el usuario — todos los medidores tienen dígitos uniformes
- **Boundary**: Se verificará empíricamente (enviar y ver resultado). Implementar asumiendo tamaño total.
- **Sin zoom por ahora**: Se ajusta la imagen para que se vea más grande, pero sin pinch-to-zoom. Se agrega después si es necesario.
- **Umbrales de validación**: Se estiman inicialmente y se ajustan con pruebas en campo.

### Preguntas Abiertas

1. ¿El boundary del protocolo ROI es el ancho/alto total o radio? → A verificar empíricamente
2. ¿Los umbrales de validación necesitan calibrarse con más imágenes?  → Sí, se ajustarán iterativamente

<!-- FEEDBACK: validation_thresholds
Los umbrales de brillo/contraste/saturación son estimaciones basadas en una sola imagen de referencia. Se ajustarán iterativamente con pruebas en campo.
Status: ADDRESSED
-->
