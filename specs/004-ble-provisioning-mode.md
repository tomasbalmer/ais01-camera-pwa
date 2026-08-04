# BLE Provisioning Mode — technician-timed, bench-side

Stage: `Research`
Last Updated: 2026-08-04

## High-Level Objective

Provision a factory Dragino **v1.3** unit from a phone over BLE, at a bench with
WiFi, *before* the unit goes to the field — with the technician owning all
timing and no state machine on the app side. This replaces the laptop harness
for the provisioning job only; it does not replace it for engineering or debug.

## Mid-Level Objectives

- [ ] Add a provisioning mode to the PWA that reuses the existing BT24/FFE1 transport unchanged
- [ ] Show device output as a raw terminal — the technician reads the AT window with their own eyes
- [ ] Expose the provisioning actions as always-enabled buttons, in order, never gated by parsed state
- [ ] Load per-unit material as one bundle file the technician picks, carrying the IMEI so a wrong-unit write is refused rather than silently succeeding
- [ ] Confirm success server-side — "did this unit publish?" — rather than from a local file
- [ ] Leave the laptop harness (`AIS01-CB-LTE`) untouched and authoritative for debugging

## Context

### Why this exists

Provisioning currently needs a laptop running the `ais01d` harness: a daemon
that owns the link, a reactor that classifies device state, an await/sentinel
loop that wakes an LLM on every boot, an evidence trail, and a dashboard to make
any of it visible. That machinery is not there because provisioning is hard. It
is there because **the decider is an LLM that is frozen between turns and has to
reconstruct device state every time it wakes.**

A human at a bench is not frozen. They can watch. Two consequences drive this
whole spec:

1. The expensive half of the harness — timing, wake protocol, state inference,
   the dashboard that renders it — exists to compensate for a decider that this
   design does not use.
2. Provisioning happens indoors, before installation, with WiFi and with the
   unit on a table. Missing the AT window costs one button press (`RESET`), not
   a truck roll. Timing stops being a risk and becomes an inconvenience.

### What already exists in this app

| Piece | Where | Reused? |
|---|---|---|
| Web Bluetooth → BT24, FFE1 notify + write, 9600 | `modules/ble.js` | **yes, unchanged** |
| GATT reconnect handling, `writeWithoutResponse` only | `modules/ble.js` | **yes, unchanged** |
| Boot-phase detection + "Missed Window" (`SETUP_STEPS`, `SETUP_ERRORS`) | `modules/constants.js` | **no — see decision below** |
| Camera calibration flow (`AT+INSTALL`, `AT+SETROI`, …) | `app.js`, `modules/` | untouched, different job |

Note the app talks to **our custom firmware** today (`AT+INSTALL`, banner
`Custom Firmware`). Provisioning targets **Dragino v1.3**, which has a different
AT vocabulary and different banners. The BT24 bridge and everything below it are
identical; the strings above it are not.

### Decision: no provisioning state machine

The app does **not** parse the device stream to infer provisioning phase, does
not enable/disable buttons based on inferred state, and does not maintain a
local provisioning record.

```
  DETECTION (rejected)              TERMINAL (chosen)
  ────────────────────              ─────────────────
  parse stream, infer phase         display the stream
  gate the buttons                  buttons always enabled
  auto "Missed Window"              the technician sees it scroll past
  strings to maintain per firmware  nothing to maintain
```

The technician is still the detector — they read `NBIOT has responded.` on
screen. What is removed is the *code deciding on their behalf*.

**Residual risk, accepted:** the AT window opens at ~16.4 s. A password sent
before it is silently eaten and the device answers `Password Incorrect`, which
reads as a wrong password rather than "too early". This is the single most
misleading failure in the system. Mitigation without detection is a **static
cheat line in the UI** next to the login button — not a parser:

> Wait for `NBIOT has responded.` before logging in.
> `Password Incorrect` this early means too soon, not wrong.

If this trap costs real units in practice, the smallest fix is to re-enable the
existing `SETUP_ERRORS` mechanism for that one string — the machinery is already
written and proven in the calibration flow.

### The one thing that stays automatic

Everything else can be checked by eye and redone cheaply. **Whether the unit
actually reached AWS cannot.** A unit that leaves the bench believing it is
provisioned is discovered in the field, and that is the one failure this app
must not permit.

```
  today                          this spec
  ─────                          ─────────
  laptop writes                  the device publishes to AWS IoT
  provisioning-state.json        and the backend confirms it
       ↓                              ↓
  proof lives on one laptop      proof lives where the platform
                                 already keeps everything else
```

`waterplan-lambdas/stacks/water-meter-stack/` already receives these messages.
Provisioned = the platform saw an uplink from that IMEI. Nothing local to write,
nothing to sync, nothing to lose with a phone.

## The sequence

Four stages, fixed order, no branching — a fresh unit has no prior state to
resume from. Authorities are pointers, never copies; the AT detail lives in the
`AIS01-CB-LTE` repo and must not be duplicated here.

| # | Action | What it does | Authority |
|---|---|---|---|
| 0 | **Identify** | read IMEI off the unit | `firmware-factory/scripts/identify-device.py` |
| 1 | **Certs** | `AT+CERTMOD` passthrough into the BG95, then `QFDEL`/`QFUPL` per file, checksum-gated | `cli/ais01_cli/commands/certs.py` (`write-certmod`) |
| 2 | **Network + MQTT** | read `AT+CFG` once, send only the deltas | `firmware-factory/scripts/configure-network.py`, `configure-mqtt.py` |
| 3 | **Verify** | reset, let one cycle run, ask the backend whether it published | this app + platform |

Stage numbering follows `firmware-factory/stages.json` → `routes.v1_3.order`.
There are no flash stages on v1.3 — that is the entire reason a phone can do
this at all.

Two settings are law and must be sent even when they look already correct;
`SNI=1` breaks the MQTT CONNECT silently:

```
  AT+SNI=0
  AT+MQOS=0
```

`AT+CFG` returns the full property dump in one command, so the app reads once
and diffs — it never queries settings one at a time.

## Screen

Approved layout: **terminal dominant, actions in a compact row underneath.** The
raw device stream is the instrument, not a detail hidden behind a tap — which is
the whole point of the technician owning timing.

```
  ┌──────────────────────────────┐
  │ AIS01 Provision      ● BLE   │
  │ IMEI 869181072714122         │
  ├──────────────────────────────┤
  │ 16:04:19 Camera detected     │
  │ 16:04:31 NB module init...   │
  │ 16:04:33 NBIOT has responded.│
  │ 16:04:40 > AT+CERTMOD        │
  │ 16:04:41 OK                  │
  │ 16:04:44 +QFUPL: 1188,3A7C   │
  │ 16:04:44   VERIFIED  1/3     │
  │ 16:04:47 > AT+QFUPL="cli...  │
  │                              │
  │                     ▼ live   │
  ├──────────────────────────────┤
  │ wait for "NBIOT has          │
  │ responded." before login     │
  ├──────────────────────────────┤
  │ ①LOGIN ②CERTS ③CFG ④VERIFY   │
  └──────────────────────────────┘
```

Rules this layout has to keep:

- **Buttons are never disabled by device state.** They may show the result of
  the command *they* sent (`VERIFIED 1/3`, `no answer`), because that is
  confirmation, not phase inference. They must not grey out because the app
  thinks the window is closed.
- **Sent commands and device output share one stream**, distinguished by a `>`
  prefix. Two panes would force the operator to correlate them by timestamp.
- **`▼ live` means the view is pinned to the tail.** Scrolling up unpins it;
  the marker is how the operator knows they are no longer seeing the present.
- **The cheat line is static text.** It never changes, never reacts, and is
  never hidden — it is documentation printed on the tool, not a state readout.

## Device material: one bundle file per unit

There is no integration with device creation yet — things and certificates are
created in AWS IoT by hand, and the material is filed per device. That is fine
and does not block anything, but **what the phone loads should be one file, not
a folder of five.**

```json
AIS01-CB-<IMEI>.json
{
  "imei":        "869181072714122",
  "thing_name":  "AIS01-CB-869181072714122",
  "password":    "……",
  "certificate": "-----BEGIN CERTIFICATE-----\n…",
  "private_key": "-----BEGIN RSA PRIVATE KEY-----\n…",
  "expect": { "certificate": "3A7C", "private_key": "91B2" },
  "mqtt":   { "endpoint": "…-ats.iot.<region>.amazonaws.com",
              "endpoint_ip": "…", "tdc": 3600 }
}
```

`mqtt` is environment configuration rather than per-unit material, but it rides
in the bundle on purpose: the app refuses to build a `AT+SERVADDR` from a
default it invented, and the command that writes the bundle is the thing that
already knows the environment. `AT+BKDNS` is only sent when `endpoint_ip` is
present, and `AT+TDC` only when `tdc` is.

Lives in the shared Drive folder, one per unit. The technician picks it once,
per unit, and types nothing.

### Why one file and not the AWS folder

**It carries the IMEI, so the app can refuse a mismatch.** In a bench session of
N units this is the most likely human error and today nothing catches it:
picking the wrong folder writes unit A's identity into unit B, both writes
succeed, and the mistake surfaces weeks later in the field as two units that
will not connect. The app compares the `imei` in the bundle against the unit it
is talking to and refuses to write if they differ. That check is impossible if
the app is handed loose `.pem` files, which carry no identity.

Three smaller reasons:

- **One gesture.** Mobile file pickers handle a single file well; directory
  picking (`webkitdirectory`) is patchy on Android and effectively absent in
  Bluefy on iOS.
- **The password rides along** instead of being a second source and a typed
  field.
- **`expect` carries the checksums** the modem must echo back
  (`+QFUPL: <size>,<checksum>`). They come from `ais01 certs certmod-plan`, so
  the phone compares rather than derives.

`AmazonRootCA1.pem` is public and ships inside the app — it is not per-device
and does not belong in the bundle.

### Producing the bundle

New command in `AIS01-CB-LTE`, next to the one that already computes the
checksums:

```bash
./cli/ais01 certs bundle <cert_dir>        # → AIS01-CB-<IMEI>.json
```

One extra step in a process that is already manual, and it can run over the
whole `firmware-factory/devices/` tree at once. The bundle is generated
material: it belongs in Drive, never in git — the same `.gitignore` rule that
already covers `firmware-factory/devices/` applies.

### Fallback, if the extra step is unwanted

The app also accepts the two `.pem` files plus a typed 6-digit password. It
works, and it loses the IMEI check — which is the reason not to prefer it.

### Later: create the certificate at provisioning time

The private key is returned by `CreateKeysAndCertificate` **once and never
again**, so the file in Drive is the only copy, not a cache. The moment device
creation is integrated, the better model is for the backend to create the
certificate when the technician presses ② and return it in that response: it
goes straight into the BG95 and is never stored anywhere.

Nothing here blocks that. The app already knows how to write a certificate; only
the source changes, from a file picker to a call. Building the picker first is
what lets the sequence be proven against real hardware before any API is
committed to.

## No agent on the phone

The technician executes. There is no assistant on the device, and this is a
design decision, not a limitation waiting to be lifted.

```
  MANUAL   four buttons, the human decides when     ← this spec
  AUTO     one button, the app waits and chains     ← needs detection back
  AGENT    a model decides what and when            ← nothing to decide
```

An agent earns its cost where there are decisions. Here the sequence is fixed
and the only judgement left is *when*, which is precisely what a model frozen
between turns is worst at and a person watching a screen is best at.

Note what "manual" does and does not mean:

| The human | The app |
|---|---|
| presses RESET | composes every AT command |
| watches the log | chunks and uploads each certificate |
| presses four buttons in order | verifies the checksum the modem echoes |
| loads the bundle once | reads `AT+CFG` and sends only the deltas |

**Nobody types an AT command, ever.**

### Two kinds of timing — only one belongs to the technician

"The technician owns timing" is about *when an action starts*, never about the
rhythm inside it. Conflating the two would mean asking a person to hand-pace
sixty PEM lines, which is neither possible nor desirable.

| | Scale | Owner | Why |
|---|---|---|---|
| When an action starts | seconds — the AT window | **technician** | a person watching a line on screen is the right sensor; a model frozen between turns is the wrong one |
| Rhythm inside an action | ~120 ms between PEM parts, 20-byte chunks | **code** | derived from byte count, not chosen; no human can hold it |

So ② is **one tap**. Behind it runs the whole loop: enter `AT+CERTMOD`, then per
file `QFDEL` → `QFUPL` → wait for `CONNECT` → stream the paced parts → gate on
the echoed `+QFUPL: <size>,<checksum>` → next file, then exit. The operator
watches `VERIFIED 1/3 … 3/3` go by and does nothing.

### Why the pacing exists at all, and why BLE needs more of it than USB

The USB path writes a whole PEM line to a serial port with a driver and a
hardware buffer behind it. BLE has neither:
`writeValueWithoutResponse` resolves when the packet is *queued*, not sent, so
there is no backpressure — and BLE delivers well above 2 kB/s while the BT24's
UART drains at 9600 baud, or 960 B/s. Push faster than that and the module's
buffer overflows and drops bytes **silently**.

Pacing is therefore computed, not guessed: a part must be given at least its own
drain time, `bytes × 10 / 9600` seconds. A 65-byte PEM line needs ≥68 ms; at
120 ms there is roughly double the margin and a full certificate takes about
three seconds.

Nothing else about the write changes between transports — same parts, same bare
`\r` terminator (the CRLF conversion happens in the STM32 passthrough, not in
the link), same XOR-16 checksum. The pure functions in
`AIS01-CB-LTE cli/ais01_cli/commands/certs.py` are unit-tested against real
modem vectors and are ported as-is.

**The experiment has a known answer.** The CA file returned
`+QFUPL: 1208,5769` over USB on 2026-07-13. The same file over BLE must echo
the same pair. A different checksum means bytes were lost in transit and the
pacing floor is too low — it does not mean the certificate is wrong.

### Interrupted uploads leave nothing behind

If the window closes mid-upload the device sleeps, the transfer dies, and no
`+QFUPL` arrives. The technician presses RESET and taps ② again. Every attempt
begins with `QFDEL`, so a half-written file never survives to be trusted — and
on a bench, retrying is free. That is the property the whole design rests on.

### When something fails in a way the sequence does not cover

The technician retries once. If it fails again they **stop and escalate** — the
laptop harness, with its agent, is where an unknown failure gets diagnosed. This
app never explains a failure it was not built to expect, and it should not
pretend to.

### Manual now does not close auto later

Chaining the four steps automatically only requires re-enabling string
detection, and that machinery already exists and is proven in this app's
calibration flow (`SETUP_STEPS`, `SETUP_ERRORS`). The reverse would have been
the trap: maintaining detection strings for two different firmwares before
knowing the sequence works at all.

## The one endpoint this still needs

Only stage 3 requires the backend: **"has this IMEI published since
`<timestamp>`?"** It is the single automatic check in the whole design, and the
reason is in *The one thing that stays automatic* above.

Reachable by construction — provisioning happens at a bench with WiFi.

## Non-goals

- **Debugging a unit that misbehaves.** Stays on the laptop harness, unchanged.
  Provisioning a known-good unit and diagnosing a broken one are different jobs
  with different tools — the same split this repo already applies elsewhere.
- **The v1.2 flash lane.** Requires `stm32flash`, an ISP switch and vendor
  images. A phone cannot and should not.
- **Field calibration.** Already shipped in this app; it happens later, at the
  meter, and is not touched here.
- **Any autonomous agent.** The decider here is a person.

## Resolved

**Who provisions — a small, trained team.** This is what makes "no detection"
safe rather than merely cheap. The design leans on the operator knowing what
`NBIOT has responded.` means; that assumption is now explicit, and it is the
first thing to revisit if provisioning is ever handed to people outside the
team.

**The boot marker is exact.** `cli/ais01_cli/core/at_window.py` is the authority:

```
  ~0s     bootloader banner            CLOSED
  ~5s     camera detected              CLOSED  (trap: looks alive, is not)
  ~15s    NB module initializing       CLOSED  (password EATEN here)
  ~16.4s  NBIOT has responded.    <==  OPEN
  ...     whole awake period           OPEN
  end     power-off successful         CLOSED → asleep until the next cycle
```

The cheat line quotes `NBIOT has responded.` verbatim, period included.

**Interrupted cert upload — already solved, and worth copying exactly.**
`cli/ais01_cli/commands/certs.py` deletes the slot before *and* after every
attempt (`AT+QFDEL="<name>"`; `ERROR` when the file is absent is expected and
allowed), so a known-bad file is never left in the modem between tries. The
write is trusted only when the modem echoes `+QFUPL: <size>,<checksum>` and both
match. **A matching size proves nothing — only the checksum does.**

The expected size and checksum can be computed with no device attached:

```bash
./cli/ais01 certs certmod-plan <cert_dir>
```

That means the phone does not need to derive them: they can ship alongside the
cert bundle from the backend, and the app only has to compare.

## Open questions

- [ ] Batch ergonomics: the bench case is N units in a row. Does the app keep a
      session per unit, or is one-at-a-time acceptable for the first version?
- [ ] iOS: Safari has no Web Bluetooth, so this inherits the existing **Bluefy**
      requirement. Acceptable, or is this Android-only in practice?
- [ ] Backend: which repo owns the one endpoint — `waterplan-api`, or a lambda
      in `water-meter-stack` next to the ingest that already sees the uplinks?
- [ ] Until that endpoint exists, what stands in for stage 3? Checking the AWS
      console by hand is honest and works for the first units; what is not
      acceptable is calling a unit provisioned because the writes returned `OK`.
