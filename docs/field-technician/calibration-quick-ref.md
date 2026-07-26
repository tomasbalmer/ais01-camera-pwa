# AIS01-CB — Calibration Quick Reference Card

**Use this when:** Device is mounted and powered on. Now you need to calibrate the camera.

---

## Calibration in 5 Steps

### Step 1 — Choose your method
- **Android phone** → use PWA (browser app) via USB
- **iPhone** → use BLE (Bluefy app) via Bluetooth

---

### Step 2 — Connect to the device

**PWA (Android):**
1. USB OTG adapter → phone, USB cable → device USB port
2. Open Chrome → go to PWA URL
3. Tap **Connect** → allow USB access

**BLE (iPhone / Android):**
1. Open Bluefy (iOS) or Chrome (Android) → go to PWA URL
2. Tap **BLE Calibration** mode
3. Select device from Bluetooth picker

---

### Step 3 — Validate camera position

Tap **Validate Position** in the menu.

| Indicator | Goal | If failing |
|-----------|------|-----------|
| ✅ Brightness | Image is well-lit | Adjust device height (5–15 cm) |
| ✅ Flash glare | Not over-white | Raise device slightly |
| ✅ Contrast | Digits visible | Clean lens; check lighting |
| ✅ Edge detail | Digits sharp | Reduce distance to meter |

All green? Proceed. Any ⚠️? Adjust and re-validate.

---

### Step 4 — Draw the digit rectangle

Tap **Calibrate ROI (Touch)** in the menu.

1. Image freezes — prompt says *"Draw a rectangle over the digits"*
2. With your finger, draw a rectangle:
   - Left edge = left side of first digit
   - Right edge = right side of last digit
   - Height = full digit height (not the whole meter face)
3. Blue boxes appear for each digit — should line up one-to-one with digits
4. Use the digit count picker to match your meter (usually **6** for GENEBRE)

**Good:** each blue box frames exactly one digit  
**Bad:** boxes are too small, too large, or covering the wrong area → redraw

---

### Step 5 — Send and verify

1. Tap **Send ROI** → calibration is saved to the device
2. The stream resumes — watch the AI reading (status bar)
3. Compare AI reading to physical meter

**Match?** ✅ Done — calibration complete.  
**Mismatch?** Redo calibration — likely the rectangle didn't cover all digits correctly.

---

## Common Calibration Problems

| Problem | Fix |
|---------|-----|
| AI reads fewer digits than meter has | Wrong digit count selected — change the picker and redraw |
| Reading is 10× or 100× off | Decimal dials included in rectangle — redo covering only integer digits |
| Digits blurry in live view | Device too far (>15 cm) or lens dirty — move closer or clean lens |
| Rectangle keeps slipping | Use two fingers to steady phone; freeze image is your canvas |
| BLE stream too slow to see | Normal — switch to ROI mode (smaller image, faster refresh) |

---

## LED During Calibration

| LED | Meaning |
|-----|---------|
| 🔵 Blue blinking | Camera is active (streaming) |
| All OFF | Device went to sleep — press reset to wake it |

---

## After Calibration

The calibration persists across power cycles — no need to redo it unless the device is remounted. Press reset to trigger a fresh reading cycle and confirm the first reading reaches Waterplan.
