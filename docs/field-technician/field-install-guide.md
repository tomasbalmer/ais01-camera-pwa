# AIS01-CB LTE-M Field Technician Guide
## Install, Calibrate, and Verify a Water Meter Sensor On-Site

**Audience:** Field installers and contractors  
**Device:** Dragino AIS01-CB (LTE-M/NB-IoT AI Image Sensor)  
**Purpose:** Everything you need to install and verify a device at a meter location

> **STATUS: DRAFT — do not hand to a field installer yet.**
> Blocked on the production calibration-app (PWA) URL, which is still a
> `<TODO: …>` placeholder in two places (§What you need on site, §Calibrate
> the camera). It also has no named owner for pre-release review.
> Remove this block once the URL is filled in and an owner is assigned, and
> re-read the whole guide before every field release.
>
> **Provenance.** This guide moved here from the firmware repo
> (`AIS01-CB-LTE`), where it had landed by accident. It lives here because the
> installer's tool is this PWA and this repo owns the URL above. The
> device-side claims it repeats — what a healthy cycle looks like, why signal
> reads 99, what the LEDs mean — are owned by the firmware repo
> (`firmware-factory/docs/golden-path.md`, `.agentic/skills/factory-debug/`).
> Re-check them there before a field release rather than editing them here.

---

## Before You Start

The device you received has already been provisioned by Waterplan's technical team. That means:
- Firmware is already flashed
- SIM card is inserted and pre-configured
- Security certificates are loaded
- Network settings are pre-configured

**You do not need to do any technical setup.** Your job is to physically install the device, align the camera on the meter dial, run the calibration from your phone, and confirm it is sending readings.

### What you need on site
- [ ] The AIS01-CB device (already provisioned)
- [ ] Mounting bracket (if not already attached to device)
- [ ] Your Android or iPhone
- [ ] The Waterplan calibration app (PWA) — open `<TODO: production PWA URL not yet supplied>` on your phone's browser, or use the BLE app
- [ ] A stable Wi-Fi or mobile data connection on your phone (for the PWA)

---

## 1. What Is This Device?

The AIS01-CB is a battery-powered cellular sensor that mounts directly over a water meter. It takes photos of the meter dial, reads the digits automatically using an AI chip inside the device, and sends the reading to the Waterplan platform every hour (or at whatever interval is configured).

```
Water meter in ground → Device mounted over dial → Photo taken hourly
                                                  → Reading sent over LTE-M
                                                  → Data appears in Waterplan
```

### What's in the box

| Item | Description |
|------|-------------|
| AIS01-CB device | The sensor unit with camera, battery, and antenna |
| Mounting bracket | For securing device over meter |
| Screws / hardware | As applicable for the bracket type |

### Device anatomy

```
┌─────────────────────────────────────────┐
│              AIS01-CB                    │
│                                          │
│  [Top of device]                         │
│  ┌──────────────────────────────────┐   │
│  │   LED indicators (top edge)      │   │
│  │   🔵 Blue  🔴 Red  🟢 Green      │   │
│  └──────────────────────────────────┘   │
│                                          │
│  [Side of device]                        │
│  ├── USB port (for provisioning only)    │
│  ├── Reset button                        │
│  └── ISP/Flash switch (leave on FLASH)   │
│                                          │
│  [Bottom of device]                      │
│  └── Camera lens pointing downward       │
│      toward the meter dial               │
└─────────────────────────────────────────┘
```

**Battery life:** The device runs on a built-in 8,500 mAh lithium battery. Under normal operation (reading every hour), it lasts several years. The battery is non-rechargeable — when depleted, the battery must be replaced.

---

## 2. Installation

### Step 1 — Choose the mounting position

The camera sits inside the device body and points straight down. The device must be positioned so the camera is directly above the meter's digit display. Correct distance is 5–15 cm from the camera lens to the meter dial surface.

**Good positioning:**
- Digits fill most of the camera frame
- Even lighting — not too dark, not over-exposed
- Camera is perpendicular to the dial (not tilted)

### Step 2 — Mount the device

1. Position the bracket over the meter according to the bracket instructions for that meter type.
2. Attach the device to the bracket so the camera faces down and the LED indicators face up where you can see them.
3. Tighten mounting hardware. The device is IP67 rated — it can handle outdoor exposure, rain, and brief submersion, but the mounting must be mechanically stable.
4. Confirm the camera is centered over the digit wheel, not the surrounding dial face.

### Step 3 — Power on

The AIS01-CB powers on automatically when the battery jumper is installed (the device ships with this ready). If the device is off, check the **JP2 jumper** on the side of the device — it should be installed.

**To power on:** Press the **reset button** on the side of the device. The device will boot within a few seconds.

### Step 4 — Read the LED indicators

Watch the LEDs on the top edge of the device immediately after powering on:

| LED | Pattern | Meaning |
|-----|---------|---------|
| 🔵 Blue — solid ON | Boot has started, device is initializing | Normal |
| 🔵 Blue — blinking | Camera is on and taking a photo | Normal — wait |
| 🟢 Green — brief flash | Camera read digits successfully | Good |
| 🔴 Red — brief flash | Camera failed to read digits | Needs attention |
| 🔵 Blue — solid ON again | Connecting to cellular network | Normal — wait |
| 🟢 Green — brief flash | Connected to cellular network | Good |
| 🟢 Green — solid 1 second | Reading published to Waterplan | 
| 🔴 Red — brief flash | Failed to publish reading | Needs attention |
| All OFF | Device is sleeping until next reading cycle | Normal |

The full active cycle (boot to sleep) takes about 60–90 seconds. After that, all LEDs turn off and the device sleeps until the next reading interval.

**First boot after physical install:** The device may not have a calibrated camera position yet. You will calibrate this in the next step. Even without calibration, the device will still power on, attempt a reading, and show LED feedback.

---

## 3. Camera Calibration

Calibration tells the device exactly where the digits are in the camera's view. Without calibration, the AI may misread digits or return incorrect readings. Calibration is required once per installation — after that, it is stored in the device and does not need to be repeated unless you remount the device.

### Which method to use?

| Method | Best for | What you need |
|--------|----------|---------------|
| **PWA (browser app)** | Android phones | Android Chrome browser |
| **BLE (Bluetooth)** | iPhone or any phone | Browser with Web Bluetooth (e.g. Bluefy on iOS) |

Both methods produce the same result — a calibrated camera position stored in the device.

---

### Method A: Calibrate via PWA (Android)

The PWA is a web app that connects to the device via USB (using an OTG adapter). It shows a live camera feed from the device on your phone screen.

**You will need:** Android phone + USB OTG adapter + USB cable (to connect phone to the device's USB port)

#### Steps

1. **Connect your phone to the device**
   - Plug the USB OTG adapter into your Android phone
   - Connect a USB cable from the OTG adapter to the device's USB port
   - On your phone, open Chrome and navigate to the PWA URL: `<TODO: production PWA URL not yet supplied>`

2. **Connect to the camera stream**
   - Tap **Connect** in the PWA
   - Allow the browser to access the USB device if prompted
   - You should see a live black-and-white image from the camera on your phone screen

3. **Validate the camera position**
   - Tap the menu (hamburger icon) → tap **Validate Position**
   - The app will analyze the image and show indicators:
     - ✅ **Brightness** — the image is well-lit
     - ✅ **Flash glare** — not overexposed from the LED flash
     - ✅ **Contrast** — digits are visible
     - ✅ **Edge detail** — digit boundaries are sharp
   - If any show ⚠️, adjust the device position and re-validate
   - Common fixes: tilt device slightly, clean the lens, add/reduce ambient light

4. **Draw the digit rectangle**
   - Tap **Calibrate ROI (Touch)** from the menu
   - The image freezes — you will see a hint: *"Draw a rectangle over the digits"*
   - Using your finger, draw a rectangle that covers exactly the digit area of the meter:
     - Start from the left edge of the first digit
     - Drag to the right edge of the last digit
     - Cover the full height of the digit display
   - Blue sub-rectangles will appear showing each individual digit area
   - Use the digit count selector (4–8) to match the number of digits on your meter — for GENEBRE and similar meters, this is typically **6**

5. **Send the calibration**
   - When the rectangle looks correct (each sub-box matches one digit), tap **Send ROI**
   - The PWA sends the calibration to the device
   - Tap **Cancel** to exit calibration mode — the camera stream resumes
   - The device now knows where the digits are

6. **Verify calibration**
   - Watch the stream for 1–2 frames
   - You should see the digit areas highlighted or the AI reading in the status bar
   - If the reading shown matches the actual meter value, calibration is correct

---

### Method B: Calibrate via BLE (iPhone or any phone)

BLE calibration uses Bluetooth instead of USB — no cable or adapter needed. The process is the same as PWA but over a wireless connection.

**You will need:** A phone with Web Bluetooth support. On iOS, use the **Bluefy** browser app (free on the App Store).

#### Steps

1. **Open the calibration app**
   - On iOS: Open Bluefy browser, navigate to the PWA URL
   - On Android: Open Chrome, navigate to the PWA URL

2. **Connect via Bluetooth**
   - Tap **BLE Calibration** mode in the app (not regular BLE Install mode)
   - A Bluetooth device picker will appear — select the device labeled **AIS01-CB** or similar
   - The app sends `AT+CALIB` to the device over Bluetooth
   - The device powers on its camera and starts streaming images over BLE

3. **View the live stream**
   - The image stream over BLE is slower than USB (~1 frame every 10 seconds for full image)
   - This is normal — BLE has lower bandwidth than USB
   - Use this to position the camera correctly, then proceed

4. **Switch to ROI preview** (optional)
   - Tap **ROI Mode** to switch to the smaller 160×64 pixel view — this updates faster (~1 fps) and is easier to use for calibration

5. **Draw the digit rectangle** — same as Method A steps 4 and 5 above

6. **Send calibration**
   - Tap **Apply** — the app sends the 80-byte calibration payload over Bluetooth to the device
   - The device stores this in camera memory — it persists across power cycles

7. **Exit calibration**
   - Tap **Stop** — sends `AT+STOP` to the device
   - Device returns to normal duty cycle

---

### How do I know calibration worked?

- The AI reading shown in the app matches the physical meter value
- On the next reading cycle (after calibration), the device publishes a reading that matches the meter
- In the Waterplan platform, the reading for this device updates with the correct value

**If the reading is wrong:** The most common cause is the rectangle not covering all digits correctly. Redo calibration, making sure to include the full height and width of every digit.

---

## 4. Connectivity Check

After calibration, confirm the device is online and sending readings to Waterplan.

### Signal strength indicator (LED during boot)

During the active cycle, watch the LEDs:
- 🔵 Blue solid → device is connecting to network
- 🟢 Green flash → network registered (this means the SIM is connected to a carrier)
- 🟢 Green solid 1 second → reading published successfully

If you see 🟢 Green solid, the device is confirmed online and sending.

### What "good" connectivity looks like

The device connects over LTE-M or NB-IoT cellular. Good connectivity means:
- Network registration completes in under 30 seconds
- Signal strength (RSSI) is above -100 dBm (shown in device logs)
- DNS resolves successfully
- MQTT connection to AWS establishes within 10 seconds

You typically cannot see these numbers in the field unless you connect a laptop. The green LED solid for 1 second is the simplest field indicator.

### Force a new cycle to verify connectivity

If the device has already gone to sleep and you want to check connectivity now:
- Press the **reset button** on the side of the device
- The device will boot and run a full cycle (boot → read → connect → publish → sleep)
- Watch the LEDs — you should see blue solid, then green flash (network), then green solid (published)

---

## 5. Verifying a Reading

After installation and calibration, confirm that the reading arriving at Waterplan is correct.

### From the field (without platform access)

1. Read the physical meter — note the current value in cubic meters (m³)
2. Press reset to trigger a new cycle
3. Wait for the green LED to go solid (reading published) — about 60–90 seconds
4. Ask your Waterplan contact to check the platform for this device's latest reading
5. The platform reading should match (or be within the sensor's tolerance of) the physical meter reading

### From the Waterplan platform

If you have platform access:
1. Log in to the Waterplan platform
2. Navigate to the device by IMEI or site name
3. Check the latest reading timestamp and value
4. The reading should be within the last few minutes (if you just pressed reset)

### What a correct reading looks like

```json
{
  "Reading": 888184.56,
  "time": "2026-07-17T14:22:00Z",
  "battery": 3.52,
  "signal": 27
}
```

- **Reading** — meter value in m³ (cubic meters)
- **time** — UTC timestamp of the reading
- **battery** — device battery voltage; should be 3.4–3.6V for a healthy battery
- **signal** — signal strength; higher = better (27 is good; below 10 is weak)

---

## 6. Troubleshooting

### 🔴 Red LED after camera phase — camera failed to read digits

| Cause | What to do |
|-------|-----------|
| Camera is not calibrated | Run calibration (Section 3) |
| Device not centered over digits | Adjust physical mounting |
| Image too dark or over-exposed | Check lens for dirt; adjust camera height |
| Digits blurry | Camera distance too large (>15 cm) or lens dirty — clean lens and reduce distance |

### 🔴 Red LED after network phase — failed to publish

| Cause | What to do |
|-------|-----------|
| No signal at this location | Check cellular coverage — if NB-IoT/LTE-M is absent, contact Waterplan |
| SIM not activated | Contact Waterplan — the SIM may need activation at this location |
| Device hit a wall or underground box with no coverage | Try resetting once — if still failing after 2–3 resets, log the issue |

### Device shows no LED activity after pressing reset

| Cause | What to do |
|-------|-----------|
| Battery depleted | Battery replacement required — contact Waterplan |
| JP2 jumper missing | Check the jumper on the device side; install it if missing |
| Switch in wrong position | Check ISP/Flash switch — must be in **Flash** position for normal operation |

### Calibration shows correct position but reading is still wrong

| Cause | What to do |
|-------|-----------|
| Wrong number of digits selected | Redo calibration with the correct digit count for this meter model |
| Rectangle covered the decimal dials, not the main digits | Redo calibration covering only the integer display |
| Meter brand not yet trained | Contact Waterplan — this meter model may need a model update |

### Phone can't connect to device via BLE

| Cause | What to do |
|-------|-----------|
| Using Safari on iPhone | Safari does not support Web Bluetooth — use **Bluefy** app instead |
| Device not in BLE calibration mode | The device must be in an active cycle; press reset and try again quickly |
| Too far away | Stay within 3 meters of the device |

### Image shows all white or all black

| Cause | What to do |
|-------|-----------|
| All white (overexposed) | Flash glare from close distance — raise the device slightly (try 8–10 cm) |
| All black | Camera too far from meter, or lens covered — check physical setup |
| Image upside down or sideways | Device mounted in wrong orientation — rotate so camera faces straight down |

---

## 7. FAQ and Glossary

### Frequently Asked Questions

**Q: Does the device need Wi-Fi?**  
A: No. The device sends readings over the LTE-M/NB-IoT cellular network (same towers as your phone, but a low-power channel). It does not need Wi-Fi or a nearby router.

**Q: How often does it send readings?**  
A: By default, once per hour. This is configured by Waterplan before you receive the device.

**Q: Do I need to charge the battery?**  
A: No. The battery is non-rechargeable lithium (Li/SOCl2). Under normal operation it lasts several years. When it is depleted, the battery module must be replaced — contact Waterplan.

**Q: What happens if there is no cellular signal at the meter location?**  
A: The device will attempt to connect, fail, and go back to sleep. It will try again on the next reading cycle. If coverage is consistently absent, contact Waterplan — alternate connectivity (e.g. LoRaWAN version) may be needed.

**Q: The meter was recently replaced. Do I need to recalibrate?**  
A: Yes. If the meter model or position changes, redo calibration.

**Q: The platform shows readings but the value seems off by a factor of 10 or 100. Why?**  
A: The decimal position may be miscalibrated. Contact Waterplan to adjust the digit/decimal mapping for this meter.

**Q: Can I leave the USB cable connected after calibration?**  
A: Yes, but it's not necessary. The device operates normally with or without USB connected. For clean installation, disconnect it.

**Q: What is the camera flash? Will it bother people?**  
A: The device has a small LED flash that fires when it takes a photo. It is low-power and brief. In most installations inside meter boxes, it is not noticeable.

---

### Glossary

| Term | Plain-English meaning |
|------|-----------------------|
| **AIS01-CB** | The full name of this device — "AI Image Sensor, Cellular, Battery" |
| **LTE-M / NB-IoT** | Cellular network standards for low-power devices — think of them as a slow but energy-efficient phone signal |
| **ROI (Region of Interest)** | The rectangle that tells the camera where to look for digits |
| **Calibration** | Setting the ROI — telling the device which part of the image contains the meter digits |
| **PWA** | Progressive Web App — a web app that runs in your phone's browser, no install needed |
| **BLE** | Bluetooth Low Energy — the wireless connection used for BLE calibration |
| **IMEI** | The device's unique ID number, printed on the device label |
| **TDC** | Time between readings (e.g. 3600 seconds = every 1 hour) |
| **MQTT** | The protocol the device uses to send readings to Waterplan's cloud |
| **IP67** | Dust-tight and water-resistant to 1m depth for 30 minutes |
| **m³** | Cubic meters — the unit for water meter readings |

---

## Device Label Reference

Each device has a label with:
- **IMEI** — unique device ID (15 digits, e.g. `869181072714122`)
- **Password** — device password (needed for technical support / remote configuration)

Keep the IMEI handy when contacting Waterplan support. It identifies exactly which device is installed at which meter.

---

## Summary Checklist

After completing the installation, confirm:

- [ ] Device is physically mounted, stable, and camera faces down over meter dial
- [ ] Device powers on — LEDs visible during boot cycle
- [ ] Camera calibrated — digit rectangle aligned in PWA or BLE app
- [ ] Connectivity confirmed — green LED solid (published) observed
- [ ] First reading verified — platform value matches physical meter
- [ ] IMEI noted for the site record
- [ ] USB cable removed (if used for calibration)

**Installation complete.** The device will send readings automatically every hour. No further action required.
