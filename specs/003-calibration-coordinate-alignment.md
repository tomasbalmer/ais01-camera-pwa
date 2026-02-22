# Alineación de Coordenadas de Calibración — PWA vs Software Original

Stage: `Research`
Last Updated: 2026-02-21

## High-Level Objective

El proceso de calibración de la cámara AIS01-LB (HM0360) desde nuestra PWA no produce los mismos resultados que el software original de Windows (HMX_FT4222H_GUI). Necesitamos entender exactamente cómo el software original mapea los puntos de calibración sobre la imagen, en qué espacio de coordenadas trabaja, y qué estructura exacta tiene el payload de 80 bytes que envía, para replicar ese comportamiento exacto en nuestra aplicación.

## Mid-Level Objectives

- [ ] Comparar lado a lado los puntos de calibración: misma posición de cámara, software original vs PWA
- [ ] Determinar el espacio de coordenadas del software original (320x240 vs 640x480)
- [ ] Validar la estructura exacta del payload ROI de 80 bytes (offsets, campos, significado)
- [ ] Corregir los bugs identificados en la PWA: command codes invertidos, offset del boundary, espacio de coordenadas
- [ ] Lograr que la calibración desde la PWA produzca el mismo resultado que la del software original
- [ ] Documentar el protocolo de calibración ROI completo

## Context

### Estado Actual de la PWA

La PWA (`ais01-camera-pwa`) ya tiene implementado:
- Stream JPEG en vivo via WebUSB (FT230X)
- Modo calibración con Konva.js: rectángulo draggable + transformer + rotación
- División automática en N dígitos (4-8 configurable)
- 4 puntos de referencia equiespaciados × 2 esquinas (top/bottom) = 8 pares de coordenadas
- Envío de SET_MODE (`C0 5A 03 05 00 00 50`) + ROI DATA (`C0 5A 03 03 [80 bytes]`)
- Validación de posición (brillo, contraste, flash, bordes)

**Problema**: La calibración no funciona correctamente — el sensor no reconoce los dígitos después de enviar el ROI desde la PWA.

### Bugs Identificados en la Investigación

#### ~~Bug 1: Command Codes INVERTIDOS~~ — **NOT A BUG** (resolved 2026-02-22)

> **Field testing confirmed** (2026-02-22) that the PWA code values are CORRECT:
> - `SHOW_FULL_IMAGE = 0x04` — switches to 640x480 ✓
> - `SHOW_ROI = 0x05` — switches to 160x64 ✓
>
> The original documentation (SPEC-camera-command-channel.md, old PWA) had the values swapped. The NEW PWA is correct.
> Canonical reference: `ais01-lorawan-endnode-v2/specs/2026/02/main/001-camera-protocol-standardization.md`

#### Bug 2: Espacio de Coordenadas — 320x240 vs 640x480

La PWA trabaja en espacio 640x480:
```javascript
const SENSOR_W = 640, SENSOR_H = 480;
```

Pero el software de Windows trabaja en **320x240** (`PrivSet.ini`):
```ini
Raw Image Resolution -  Width=320
Raw Image Resolution - Height=240
```

Los archivos ROI binarios del software original confirman coordenadas en 320x240:
```
Punto 1: (106, 92)   — encaja en 320x240, NO en 640x480 (sería muy pequeño)
Punto 4: (203, 112)  — max X=203 < 320 ✓
```

**La PWA está enviando coordenadas al doble de escala** que lo que el sensor espera.

#### Bug 3: Offset del Boundary INCORRECTO

En `buildRoiPayload()` de la PWA:
```javascript
offset += 8;       // skip bytes 36-43
offset += 32;      // skip bytes 44-75
// offset = 76
view.setUint16(offset, config.boundaryX, true);  // byte 76 ← INCORRECTO
view.setUint16(offset, config.boundaryY, true);  // byte 78 ← INCORRECTO
```

En los archivos ROI reales del software Windows, el boundary está en **bytes 72-73 y 74-75**:
```
Archivo 100850: bytes 72-75 = [70, 00, 70, 00]  → boundary 70x70
Archivo 111201: bytes 72-75 = [24, 00, 24, 00]  → boundary 36x36
Archivo 180534: bytes 72-75 = [46, 00, 46, 00]  → boundary 70x70
```

#### Bug 4: Campo numDials no se está enviando

Bytes 34-35 del payload siempre tienen valor 4 en el software original, pero la PWA envía 0.

### Análisis del Payload ROI (80 bytes) del Software Original

Estructura decodificada de los 3 archivos ROI binarios capturados del HMX_FT4222H_GUI:

```
Offset  Tamaño  Contenido                           Descripción
------  ------  ----------------------------------  -----------
0-31    32B     8 pares (x,y) u16 LE               4 puntos de referencia de dígitos × 2 esquinas (top, bottom)
32-33   2B      u16 LE = 5                          numDigits (cantidad de dígitos enteros)
34-35   2B      u16 LE = 4                          numDials (cantidad de dígitos decimales/diales)
36-39   4B      0x0000 0x0000                       Reservado
40-63   24B     6 pares (x,y) u16 LE               3 puntos de referencia de diales × 2 esquinas
64-71   8B      2 pares (x,y) u16 LE               2 puntos adicionales de referencia (varían entre sesiones)
72-73   2B      u16 LE = 70 (o 36)                  boundary_x
74-75   2B      u16 LE = 70 (o 36)                  boundary_y
76-79   4B      0x0000 0x0000                       Reservado
```

#### Puntos de Referencia de Dígitos (constantes en las 3 sesiones):

| Ref | Esquina Top (x,y)  | Esquina Bottom (x,y) | Notas |
|-----|--------------------|-----------------------|-------|
| R1  | (106, 92)          | (105, 110)            | Primer grupo |
| R2  | (141, 92)          | (141, 111)            | Segundo grupo |
| R3  | (168, 92)          | (168, 111)            | Tercer grupo |
| R4  | (203, 92)          | (203, 112)            | Cuarto grupo |

**Observaciones**: Los 4 puntos de referencia NO son el centro de cada dígito individual, sino que parecen ser puntos de referencia equiespaciados a lo largo de la zona de dígitos. El firmware interpola la posición de cada dígito individual a partir de estos 4 puntos + boundary.

### Flujo Propuesto de Validación

1. Posicionar la cámara en su montura apuntando al medidor
2. Abrir el software Windows (HMX_FT4222H_GUI) → obtener los puntos de calibración seleccionados
3. Anotar las coordenadas exactas de cada punto y el cuadrante asignado
4. Sin mover la cámara, abrir nuestra PWA
5. Hacer el mismo proceso de calibración → anotar las coordenadas calculadas
6. Comparar ambos conjuntos de coordenadas
7. Identificar la transformación necesaria (escala, offset, inversión de ejes)

## Proposed Solution

### Enfoque en 3 pasos

**Paso 1 — Fix inmediato de bugs conocidos** (sin necesidad de prueba comparativa)

Corregir los 4 bugs identificados en la PWA:
1. Invertir SHOW_ROI/SHOW_FULL_IMAGE command codes
2. Cambiar espacio de coordenadas de 640x480 a 320x240 (dividir por 2)
3. Mover boundary offset de bytes 76-77 a bytes 72-73
4. Agregar campo numDials en bytes 34-35

**Paso 2 — Prueba comparativa** (validación empírica)

Ejecutar el flujo de validación propuesto: misma posición de cámara, software Windows vs PWA, comparar coordenadas. Esto confirmará:
- Si el espacio 320x240 es el correcto
- Si el origen de coordenadas es el mismo (esquina superior izquierda vs inferior izquierda)
- Si los puntos de referencia del software coinciden con los calculados por la PWA
- Si hay algún offset adicional no detectado

**Paso 3 — Ajuste fino**

Basado en los resultados de la prueba comparativa, aplicar las correcciones necesarias (escala, offset, flip de eje Y, etc.).

### Alcance

Este spec cubre exclusivamente la alineación de coordenadas de calibración entre la PWA y el software original. NO cubre:
- El problema del canal de comandos USB (SPEC-camera-command-channel.md — ese es otro spec)
- Cambios en el firmware del MCU
- La funcionalidad de la PWA que ya funciona correctamente (stream, UI, validación de posición)

**Nota (actualizado 2026-02-22)**: El canal de comandos USB ya fue resuelto — la PWA envía comandos via WebUSB al FT230X usando D2XX vendor control transfers. Ver protocolo canónico: `ais01-lorawan-endnode-v2/specs/2026/02/main/001-camera-protocol-standardization.md`

## Implementation Notes

_Pendiente — se completará en `/pair:plan` después de la prueba comparativa._

## Success Criteria

- [x] **SC-1**: ~~Los command codes SHOW_ROI/SHOW_FULL_IMAGE están corregidos~~ — NOT A BUG: field testing (2026-02-22) confirmed PWA code is correct
- [ ] **SC-2**: Las coordenadas calculadas por la PWA coinciden (±5 pixels) con las del software original para la misma posición de cámara
- [ ] **SC-3**: El payload de 80 bytes generado por la PWA tiene la misma estructura que los archivos ROI del software original
- [ ] **SC-4**: La calibración enviada desde la PWA produce el mismo resultado que la del software original (el sensor reconoce los dígitos correctamente)

## Notes

### Archivos ROI del Software Original

Ubicación: `camera-usb/HIMAX_AMR_PC_Tool/HIMAX_AMR_PC_Tool/Save/ROI_data_*.bin`

| Archivo | Fecha | Boundary | Puntos extra |
|---------|-------|----------|--------------|
| ROI_data_20230808_100850.bin | 2023-08-08 | 70x70 | 6 coord pairs en bytes 40-63, 0 en 64-71 |
| ROI_data_20230808_111201.bin | 2023-08-08 | 36x36 | 6 coord pairs en bytes 40-63, 2 en 64-71 |
| ROI_data_20230808_180534.bin | 2023-08-08 | 70x70 | 6 coord pairs en bytes 40-63, 2 en 64-71 |
| ROI_data_20251228_180639.bin | 2025-12-28 | N/A | Patrón repetitivo 0x3C1B — posible calibración fallida o default |

### Pregunta Abierta: Origen de Coordenadas

La documentación de Dragino menciona: "The (x,y) coordinate on the image is located at the bottom left corner". Si el software usa origen **abajo-izquierda** (como en coordenadas cartesianas), pero la PWA usa origen **arriba-izquierda** (como en canvas/CSS), habría que invertir el eje Y:
```
sensor_y = 240 - display_y   (si espacio 320x240)
```

Esto explicaría por qué la calibración no funciona incluso si la escala fuera correcta. Será validado en la prueba comparativa.

### Relación con otros Specs

- `SPEC-camera-command-channel.md` — Blocker del canal USB (problema separado)
- `002-touch-calibration-position-validation.md` — Implementación actual de la calibración táctil (este spec corrige bugs en esa implementación)

<!-- FEEDBACK: coordinate_space
Pregunta crítica: ¿El sensor espera coordenadas en espacio 320x240 o 640x480?
Los archivos ROI binarios sugieren 320x240, pero el sensor nativo es 640x480.
Posibilidad: el software Windows trabaja en 320x240 pero el sensor acepta ambas escalas,
o hay un factor de conversión interno.
Esto se confirma con la prueba comparativa.
Status: OPEN
-->

<!-- FEEDBACK: origin_convention
¿El origen de coordenadas del sensor está en la esquina superior izquierda (screen convention)
o en la esquina inferior izquierda (math convention)?
La doc dice "bottom left corner" pero necesita validación empírica.
Status: OPEN
-->

<!-- FEEDBACK: num_dials
El campo numDials (bytes 34-35) siempre es 4 en los archivos del software original.
¿Qué es exactamente? ¿Cantidad de dígitos decimales? ¿Cantidad de indicadores de dial?
El medidor GENEBRE tiene 6 dígitos enteros + posiblemente 4 diales rotativos rojos.
Necesita confirmación visual del software original.
Status: OPEN
-->
