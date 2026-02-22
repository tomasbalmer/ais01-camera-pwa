# PWA de Control y Calibración de Cámara AIS01-LB

Stage: `Completed`
Last Updated: 2026-02-22

> **CORRECTION (2026-02-22)**: Command code values in Grupo 0x00 were swapped. Field testing confirmed: SHOW FULL IMAGE = 0x04, SHOW ROI = 0x05. Canonical protocol reference: `ais01-lorawan-endnode-v2/specs/2026/02/main/001-camera-protocol-standardization.md`

## High-Level Objective

Construir una PWA Android completa para el control y calibración en campo de la cámara Himax HM0360 del sensor Dragino AIS01-LB. La app se conecta vía USB OTG al hub FTDI (FT230X), muestra el stream JPEG en tiempo real, y envía todos los comandos de calibración documentados en el protocolo C0 5A — reemplazando completamente el software Windows propietario HMX_FT4222H_GUI.

## Mid-Level Objectives

- [ ] Documentar referencia completa del protocolo C0 5A (todos los comandos, formatos, payloads)
- [ ] Implementar comunicación WebUSB bidireccional con FT230X (TX comandos + RX stream)
- [ ] Visualizar stream JPEG en tiempo real con indicadores de FPS y tamaño de frame
- [ ] Controles de modo de imagen: Full Image / ROI / Enable RAW / Disable RAW
- [ ] Lectura y escritura de registros del sensor (Addr/Val)
- [ ] Configuración de ROI completa: Digit Wheel, Long Dial, Short Dial con coordenadas
- [ ] Instalable como PWA standalone (offline, ícono en home screen)

## Context

### Hardware

**Dispositivo**: Dragino AIS01-LB (AI Image Sensor con LoRaWAN)
- **Sensor de imagen**: Himax HM0360 (grayscale, 640×480 nativo)
- **MCU LoRaWAN**: ASR6601 (Cortex-M4F @ 48 MHz)
- **Conexión MCU↔Cámara**: UART1 bidireccional @ 921600 bps, 8N1

### USB Hub de Calibración

| Chip | VID:PID | Función |
|------|---------|---------|
| **FT230X** | 0403:6015 | UART (stream + comandos) |
| **FT4222H** | 0403:601C | SPI/I2C/GPIO (no usado para comandos) |

**Descubrimiento clave**: Los comandos viajan por UART vía FT230X usando el driver D2XX nativo. El driver VCP de macOS NO funciona para TX. WebUSB en Android SÍ funciona.

### Secuencia de Inicialización D2XX (confirmada)

```
1. FT_ResetDevice      → SIO_RESET value=0
2. FT_SetBaudRate      → SIO_SET_BAUD_RATE wValue=0x8003 (921600)
3. FT_SetDataChar      → SIO_SET_DATA value=0x0008 (8N1)
4. FT_SetFlowControl   → SIO_SET_FLOW_CTRL value=0 (NONE)
5. FT_Purge            → SIO_RESET value=1 (RX), value=2 (TX)
6. FT_SetLatencyTimer   → SIO_SET_LATENCY_TIMER value=1 (1ms)
7. FT_SetDtr           → SIO_SET_MODEM_CTRL value=0x0101
8. FT_SetRts           → SIO_SET_MODEM_CTRL value=0x0202
```

### Protocolo C0 5A — Referencia Completa de Comandos

Todos los comandos tienen formato: `C0 5A [Cmd Group] [Cmd ID] [Payload 2 bytes] [Trailer]`

#### Grupo 0x00 — Control de Imagen/Output

| Comando | Bytes | Trailer | Descripción |
|---------|-------|---------|-------------|
| **SEND** | `C0 5A 00 00 00 00 01` | 0x01 | Trigger general — ejecuta operación seleccionada |
| **ENABLE RAW** | `C0 5A 00 00 00 00 02` | 0x02 | Habilita datos RAW + JPEG (datos adicionales por fila) |
| **DISABLE RAW** | `C0 5A 00 00 00 00 03` | 0x03 | Vuelve a JPEG-only |
| **SHOW FULL IMAGE** | `C0 5A 00 00 00 00 04` | 0x04 | Muestra imagen completa (640×480) |
| **SHOW ROI** | `C0 5A 00 00 00 00 05` | 0x05 | Muestra imagen con ROI (160×64) |

#### Grupo 0x03 — Sistema/Control/Calibración

| Comando | Bytes | Descripción |
|---------|-------|-------------|
| **START** | `C0 5A 03 04 00 00 00` | Inicializa sesión de comunicación (obligatorio antes de otros) |
| **SET MODE** | `C0 5A 03 05 00 00 LL` | Selecciona modo de calibración. LL = largo del payload siguiente |
| **ROI DATA** | `C0 5A 03 03 [payload]` | Bloque de datos ROI/calibración (sigue a SET MODE) |
| **READ ROI** | `C0 5A 03 04 00 00 00` | Mismo que START — pide al sensor devolver ROI almacenado |

#### Grupo 0x04 — Acceso a Registros del Sensor

| Comando | Bytes | Descripción |
|---------|-------|-------------|
| **READ REG** | `C0 5A 04 09 00 AA 00` | Lee registro en dirección AA |
| **WRITE REG** | `C0 5A 04 0A 00 AA VV` | Escribe valor VV en dirección AA |

**Registros conocidos (lectura)**:

| Addr | Valor observado | Notas |
|------|-----------------|-------|
| 0x00 | 0x01 | |
| 0x01 | 0xB0 | |
| 0x02 | 0xFF | |
| 0x03 | 0xB0 | |
| 0x04 | 0xFF | |
| 0x05 | 0x00 | |
| 0x06 | 0x01 | |
| 0x07 | 0xFF | |

### Protocolo de Calibración ROI — SET MODE + ROI DATA

La calibración envía una secuencia de 2 frames:

**Frame A — SET MODE**: `C0 5A 03 05 00 00 50`
- Selecciona modo (Digit Wheel / Long Dial / Short Dial)
- Último byte (0x50 = 80) indica tamaño del bloque de datos siguiente

**Frame B — ROI DATA**: `C0 5A 03 03 [80 bytes de datos]`

Estructura del payload de 80 bytes (Little Endian):

```
┌─────────────────────────────────────────────────────────────┐
│ (1) Digit Setting: ROI Points          │ 32 bytes (8 pares X,Y) │
│ (2) Common Settings / Flags            │ 12 bytes              │
│ (3) Dial Settings                      │ 32 bytes (8 pares org/center) │
│ (4) Single Surface Boundary            │  4 bytes + padding    │
└─────────────────────────────────────────────────────────────┘
```

**(1) Digit ROI Points** — 8 pares de coordenadas (x, y) en Little Endian (uint16):
```
ROI_1_x, ROI_1_y, ROI_2_x, ROI_2_y, ..., ROI_8_x, ROI_8_y
```
Ejemplo: `2A 00 3E 00` → (42, 62)

**(2) Common Settings**:
```
Num Digits (u16) | Num Dials (u16) | Flags/Reserved (8 bytes, zeros)
```
Ejemplo: `06 00 00 00 00 00 00 00 00 00 00 00` → 6 dígitos, 0 diales

**(3) Dial Settings** — 4 diales × 2 puntos (origin + center) × (x, y):
```
dial1_org_x, dial1_org_y, dial1_c_x, dial1_c_y, ..., dial4_org_x, dial4_org_y, dial4_c_x, dial4_c_y
```

**(4) Surface Boundary**:
```
boundary_x (u16) | boundary_y (u16) | padding (3 bytes zeros)
```

### Modos de Calibración

| Modo | Frame A | Descripción |
|------|---------|-------------|
| **Digit Wheel** | `C0 5A 03 05 00 00 50` | Medidores de rueditas numéricas |
| **Long Dial** | `C0 5A 03 05 00 00 50` | Diales analógicos grandes |
| **Short Dial** | Sin sniffear aún | Diales analógicos pequeños |

### Stream de la Cámara (Sensor → PC)

```
[RAW Buffer 80 80 80...] → [Frame Header C0 5A ...] → [JPEG FF D8...FF D9] → [AI Result 11 bytes] → [Footer 00 00...]
```

**Frame Header** (después de C0 5A):
- Length/Flags: 2 bytes
- Reserved: 3 bytes
- Sensor Timestamp: 4 bytes (LE)
- Exposure Value: 4 bytes
- Gain/Analog: 4 bytes

**AI Result Block** (11 bytes, LE, después de FF D9):

| Offset | Campo | Tipo | Descripción |
|--------|-------|------|-------------|
| 0-3 | integer_part | uint32 | Lectura entera del medidor |
| 4-7 | decimal_part | uint32 | Parte decimal (×1e-6) |
| 8-9 | confidence | uint16 | Score de confianza AI |
| 10 | detection_flags | uint8 | Flags de estado |

### Resoluciones

| Modo | Resolución | Tamaño JPEG | FPS |
|------|-----------|-------------|-----|
| ROI | 160×64 | ~742 bytes | ~1.8 |
| Full Image | 640×480 | ~3-6 KB | ~1.8 |

### Estado Actual de la PWA

**Repo**: `https://github.com/tomasbalmer/ais01-camera-pwa`
**Hosting**: GitHub Pages → `https://tomasbalmer.github.io/ais01-camera-pwa/`

**Archivos**:
- `index.html` — estructura y layout
- `style.css` — visual
- `app.js` — lógica WebUSB + FTDI + JPEG stream
- `manifest.json` — config PWA

**Funcionalidad actual**:
- Conexión WebUSB con FT230X (init D2XX confirmado funcionando)
- Botones: Full Image, ROI, RAW toggle, Stop
- Stream JPEG con detección SOI/EOI
- Indicadores: frame count, FPS, KB recibidos

**Funcionalidad faltante**:
- Lectura/escritura de registros del sensor
- Configuración ROI completa (Digit Wheel, Long Dial, Short Dial)
- Visualización de AI Result (lectura del medidor, confianza)
- UI mejorada para calibración en campo

### Funcionalidades del Software Windows (HMX_FT4222H_GUI)

| Sección GUI | Funcionalidad | Comando(s) | Estado PWA |
|-------------|---------------|------------|------------|
| **UART Setting** | Start | `C0 5A 03 04 00 00 00` | Implementado |
| | Send | `C0 5A 00 00 00 00 01` | Implementado |
| | Enable/Disable RAW | `...02` / `...03` | Implementado |
| | Show Full Image / ROI | `...04` / `...05` | Implementado |
| **Sensor Config** | Read Register | `C0 5A 04 09 00 AA 00` | Falta |
| | Write Register | `C0 5A 04 0A 00 AA VV` | Falta |
| **ROI Setting** | Digit Wheel | SET MODE + ROI DATA | Falta |
| | Long Dial | SET MODE + ROI DATA | Falta |
| | Short Dial | SET MODE + ROI DATA | Falta |
| **Common Setting** | Hand Shake Pin | Desconocido | Falta |

## Proposed Solution

Evolucionar la PWA existente en fases incrementales, agregando funcionalidad progresivamente. Cada fase deja la app en estado funcional y testeado.

**Fase 1 (actual, completa)**: Conexión + stream + comandos básicos (Full/ROI/RAW)

**Fase 2**: Lectura/escritura de registros del sensor — permite inspeccionar y modificar configuración interna.

**Fase 3**: Configuración ROI — UI para definir coordenadas de dígitos, diales, y boundary. Genera y envía el bloque de 80 bytes.

**Fase 4**: Visualización de AI Result — parsear el stream para extraer y mostrar la lectura del medidor, confianza, y flags.

**Fase 5**: UX de calibración de campo — flujo guiado paso a paso para que un técnico pueda calibrar sin conocimiento técnico.

### Alcance

Este spec cubre la **referencia completa del protocolo** y la **hoja de ruta de funcionalidades** de la PWA. Cada fase puede tener su propio `/pair:plan` para implementación detallada.

NO cubre: firmware del MCU, comunicación LoRaWAN, ni el canal SPI/I2C del FT4222H.

## Implementation Notes

### Key Decisions

- **Registros**: Solo lectura por ahora (Read Register). Escritura se agrega después cuando se entienda mejor el efecto de cada registro.
- **ROI**: Solo Digit Wheel. Es el modo que usan los medidores de agua en campo.
- **Short Dial**: No se implementa (no hay sniffing aún).

### Phase 2: Lectura de Registros del Sensor

Agregar panel colapsable "Sensor Config" con campo de dirección y botón Read. Muestra el valor leído en el log y en un campo de resultado.

- [x] Step 2.1: Agregar función `sendRawBytes(bytes)` para enviar bytes arbitrarios
  - MODIFY `app.js`: Extraer la lógica de TX de `sendCommand()` a una función genérica:
    ```diff
    +// === Send raw bytes to sensor ===
    +async function sendRawBytes(bytes) {
    +    if (!device || !epOutNum) { log('Not connected'); return; }
    +    const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    +    log(`TX → ${hex}`);
    +    try {
    +        const result = await device.transferOut(epOutNum, new Uint8Array(bytes));
    +        log(`TX OK: ${result.bytesWritten} bytes`);
    +    } catch (err) {
    +        log(`TX ERROR: ${err.message}`);
    +    }
    +}
    ```
  - MODIFY `sendCommand()` para usar `sendRawBytes()` internamente

- [x] Step 2.2: Agregar función `readRegister(addr)`
  - MODIFY `app.js`:
    ```diff
    +async function readRegister(addr) {
    +    const cmd = [0xC0, 0x5A, 0x04, 0x09, 0x00, addr & 0xFF, 0x00];
    +    log(`READ REG 0x${addr.toString(16).padStart(2, '0')}`);
    +    await sendRawBytes(cmd);
    +}
    ```

- [x] Step 2.3: Agregar panel UI "Sensor Config"
  - MODIFY `index.html`: Agregar sección colapsable debajo del toolbar:
    ```diff
    +<div id="sensor-panel" class="panel">
    +    <div class="panel-header" onclick="togglePanel('sensor-panel')">Sensor Config</div>
    +    <div class="panel-body">
    +        <div class="input-row">
    +            <label>Addr</label>
    +            <input type="text" id="regAddr" value="0x00" maxlength="4">
    +            <button class="cmd-btn" onclick="onReadRegister()">Read</button>
    +        </div>
    +    </div>
    +</div>
    ```

- [x] Step 2.4: Agregar estilos para paneles colapsables
  - MODIFY `style.css`: Agregar estilos `.panel`, `.panel-header`, `.panel-body`, `.input-row`

- [x] Step 2.5: Agregar handler `onReadRegister()` y `togglePanel()`
  - MODIFY `app.js`:
    ```diff
    +function onReadRegister() {
    +    const addrStr = document.getElementById('regAddr').value.trim();
    +    const addr = parseInt(addrStr, 16) || parseInt(addrStr, 10) || 0;
    +    readRegister(addr);
    +}
    +
    +function togglePanel(id) {
    +    document.getElementById(id).classList.toggle('open');
    +}
    ```

**Verification**
- Abrir PWA en Android, conectar cámara
- Expandir panel "Sensor Config"
- Ingresar `0x00` en Addr, presionar Read
- Verificar en log que se envía `C0 5A 04 09 00 00 00`
- Nota: la respuesta del sensor se verá en el log como bytes RX (si el stream parser los captura)

### Phase 3: Visualización de AI Result

Parsear el stream para extraer los 11 bytes de AI Result después del EOI (FF D9) de cada frame JPEG. Mostrar la lectura del medidor y la confianza en la barra de stats.

- [x] Step 3.1: Modificar `extractAndDisplayFrames()` para capturar bytes post-EOI
  - MODIFY `app.js`: Después de encontrar FF D9, leer 11 bytes adicionales del accumulator:
    ```diff
     const jpeg = new Uint8Array(acc.slice(0, eoi + 2));
    -acc.splice(0, eoi + 2);
    +// Extract AI Result (11 bytes after EOI)
    +let aiResult = null;
    +if (acc.length >= eoi + 2 + 11) {
    +    const aiBytes = acc.slice(eoi + 2, eoi + 2 + 11);
    +    aiResult = parseAiResult(aiBytes);
    +    acc.splice(0, eoi + 2 + 11);
    +} else {
    +    acc.splice(0, eoi + 2);
    +}
    ```

- [x] Step 3.2: Agregar función `parseAiResult(bytes)`
  - MODIFY `app.js`:
    ```diff
    +function parseAiResult(bytes) {
    +    const buf = new ArrayBuffer(11);
    +    const view = new DataView(buf);
    +    for (let i = 0; i < 11; i++) view.setUint8(i, bytes[i]);
    +    return {
    +        integer: view.getUint32(0, true),
    +        decimal: view.getUint32(4, true),
    +        confidence: view.getUint16(8, true),
    +        flags: view.getUint8(10),
    +    };
    +}
    ```

- [x] Step 3.3: Mostrar AI Result en stats bar
  - MODIFY `app.js`: Actualizar la línea de stats para incluir la lectura:
    ```diff
    -stats.textContent = `#${frameCount} | ${currentFps.toFixed(1)} FPS | ${(totalBytes / 1024).toFixed(0)} KB`;
    +let aiText = '';
    +if (lastAiResult) {
    +    const reading = lastAiResult.integer + lastAiResult.decimal / 1000000;
    +    aiText = ` | ${reading.toFixed(2)} (${lastAiResult.confidence})`;
    +}
    +stats.textContent = `#${frameCount} | ${currentFps.toFixed(1)} FPS | ${(totalBytes / 1024).toFixed(0)} KB${aiText}`;
    ```

- [x] Step 3.4: Agregar variable de estado `lastAiResult`
  - MODIFY `app.js`: Agregar `let lastAiResult = null;` en sección State y actualizar en `extractAndDisplayFrames()`

**Verification**
- Conectar cámara, ver stream
- Verificar que la barra de stats muestra la lectura del medidor (ej: `182545.89 (2631)`)
- Verificar que la lectura se actualiza con cada frame
- Si la cámara no está apuntando a un medidor, el valor puede ser 0 o inválido — eso está OK

### Phase 4: Configuración ROI — Digit Wheel

Agregar panel "ROI Setting" con selector Digit Wheel, campos de coordenadas para hasta 8 dígitos, número de dígitos, y botón Send ROI que construye y envía la secuencia de 2 frames (SET MODE + ROI DATA).

- [x] Step 4.1: Agregar panel UI "ROI Setting"
  - MODIFY `index.html`: Agregar panel colapsable con:
    - Selector de cantidad de dígitos (4-8)
    - Grilla de inputs X/Y para cada dígito
    - Campo boundary X/Y
    - Botón "Send ROI"

- [x] Step 4.2: Agregar función `buildRoiPayload(config)`
  - MODIFY `app.js`: Construir el bloque de 80 bytes en el formato documentado:
    ```diff
    +function buildRoiPayload(config) {
    +    const payload = new Uint8Array(80);
    +    const view = new DataView(payload.buffer);
    +    let offset = 0;
    +    // (1) Digit ROI Points — 8 pares x,y (u16 LE)
    +    for (let i = 0; i < 8; i++) {
    +        const pt = config.digits[i] || { x: 0, y: 0 };
    +        view.setUint16(offset, pt.x, true); offset += 2;
    +        view.setUint16(offset, pt.y, true); offset += 2;
    +    }
    +    // (2) Common Settings — numDigits(u16), numDials(u16), 8 bytes reserved
    +    view.setUint16(offset, config.numDigits, true); offset += 2;
    +    view.setUint16(offset, 0, true); offset += 2; // numDials = 0 for digit wheel
    +    offset += 8; // reserved zeros
    +    // (3) Dial Settings — 8 pares org/center (unused for digit wheel, zeros)
    +    offset += 32;
    +    // (4) Surface Boundary
    +    view.setUint16(offset, config.boundaryX, true); offset += 2;
    +    view.setUint16(offset, config.boundaryY, true); offset += 2;
    +    // 3 bytes padding (already zero)
    +    return payload;
    +}
    ```

- [x] Step 4.3: Agregar función `sendRoiConfig(config)`
  - MODIFY `app.js`: Envía la secuencia de 2 frames:
    ```diff
    +async function sendRoiConfig(config) {
    +    // Frame A: SET MODE (Digit Wheel, payload=80 bytes)
    +    await sendRawBytes([0xC0, 0x5A, 0x03, 0x05, 0x00, 0x00, 0x50]);
    +    await new Promise(r => setTimeout(r, 50));
    +    // Frame B: ROI DATA
    +    const payload = buildRoiPayload(config);
    +    const frame = new Uint8Array(4 + payload.length);
    +    frame.set([0xC0, 0x5A, 0x03, 0x03]);
    +    frame.set(payload, 4);
    +    await sendRawBytes(Array.from(frame));
    +    log(`ROI sent: ${config.numDigits} digits`);
    +}
    ```

- [x] Step 4.4: Agregar handler `onSendROI()`
  - MODIFY `app.js`: Lee valores de los inputs, construye config, llama `sendRoiConfig()`

- [x] Step 4.5: Agregar estilos para grilla de coordenadas ROI
  - MODIFY `style.css`: Grid responsivo para mobile con inputs pequeños

**Verification**
- Conectar cámara, expandir panel "ROI Setting"
- Seleccionar 6 dígitos, ingresar coordenadas de prueba
- Presionar "Send ROI"
- Verificar en log que se envían 2 frames: `C0 5A 03 05 00 00 50` seguido de `C0 5A 03 03 ...`
- Verificar que la imagen cambia (el sensor aplica el nuevo ROI)

## Success Criteria

- [x] **SC-1**: Referencia completa del protocolo C0 5A documentada con todos los comandos, formatos, y payloads
- [x] **SC-2**: PWA envía todos los comandos básicos (START, SEND, RAW, ROI, FULL) confirmados en Android
- [x] **SC-3**: PWA lee registros del sensor (solo lectura por ahora)
- [x] **SC-4**: PWA envía configuración ROI completa (Digit Wheel con coordenadas)
- [x] **SC-5**: PWA muestra AI Result parseado del stream (lectura, confianza)
- [x] **SC-6**: App instalable como PWA standalone en Android (GitHub Pages)

## Notes

### Fuentes de Información

- **Sniffing UART** (Linear doc): Análisis completo de tráfico TX del software de calibración capturado con CH340
- **Dragino Wiki**: Manual de usuario y guía de calibración
- **Análisis binario**: Strings de HMX_FT4222H_GUI.exe y HMX_WEI_LIB.dll
- **Testing D2XX**: Pruebas con libftd2xx.dylib confirmaron TX funcional
- **PWA WebUSB**: Pruebas en Android confirmaron conexión y stream

### Preguntas Abiertas

1. ¿Short Dial usa el mismo SET MODE (03 05) con diferente payload, o tiene un comando distinto?
2. ¿El campo "Hand Shake Pin" del software Windows tiene relevancia para la PWA?
3. ¿Los registros del sensor tienen documentación oficial (datasheet HM0360)?
4. ¿El trailer byte en grupo 0x00 es un checksum o un command selector?
5. ¿Read ROI devuelve el bloque 03 03 por RX? (pendiente capturar tráfico RX)

<!-- FEEDBACK: protocol_completeness
El protocolo TX está completamente documentado. RX (respuestas del sensor) se descubrirá incrementalmente al implementar Read Register — el log de la PWA captura todo el tráfico RX.
Status: ADDRESSED
-->

<!-- FEEDBACK: pwa_phases
Decisiones tomadas: Solo Read Register (sin Write por ahora). Solo Digit Wheel para ROI. Prioridad de fases confirmada: Registers → AI Result → ROI.
Status: ADDRESSED
-->
