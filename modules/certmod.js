/*
 * CERTMOD certificate write — port of the proven v1.3 path.
 *
 * Reference: AIS01-CB-LTE `cli/ais01_cli/commands/certs.py`, whose pure
 * functions are unit-tested against real modem vectors and whose live run on
 * 2026-07-13 produced `+QFUPL: 1208,5769` for the Amazon root CA over USB.
 * That pair is the acceptance test for this file: the same certificate over
 * BLE must echo the same size and checksum.
 *
 * Four things here are load-bearing and were learned the hard way. Changing
 * any of them silently corrupts a certificate that still reports success:
 *
 * 1. PARTS ARE PER LINE, AND PACED. The STM32 console has a single 300-byte
 *    line buffer with no queue — anything arriving before the main loop drains
 *    it is discarded outright. This is what destroys a large verbatim burst,
 *    and it is why pacing is not a BLE concession: the USB path needs it too.
 *
 * 2. THE TERMINATOR IS A LONE `\r`. The app truncates each console line at its
 *    first CR/LF and appends CRLF unconditionally before forwarding, so the
 *    modem stores exactly `part + CRLF`. Send a full CRLF and the trailing LF
 *    can drain as a second, empty line, adding a stray CRLF that changes the
 *    stored bytes and fails the checksum.
 *
 * 3. WHAT IS STORED IS NOT WHAT IS SENT. `+QFUPL` describes the canonical-CRLF
 *    content, so the size declared to QFUPL and the checksum gated on come
 *    from `canonicalBytes`, never from the wire bytes.
 *
 * 4. ECHO OFF BEFORE ANY KEY MATERIAL MOVES. `ATE0` must be confirmed or this
 *    refuses to stream. On a phone this matters more than on a laptop: the
 *    terminal is on screen, in a photo, over a shoulder.
 */

/* Public, identical on every unit — so it ships here rather than per device. */
export const AMAZON_ROOT_CA1 = `-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF
ADA5MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6
b24gUm9vdCBDQSAxMB4XDTE1MDUyNjAwMDAwMFoXDTM4MDExNzAwMDAwMFowOTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJv
b3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALJ4gHHKeNXj
ca9HgFB0fW7Y14h29Jlo91ghYPl0hAEvrAIthtOgQ3pOsqTQNroBvo3bSMgHFzZM
9O6II8c+6zf1tRn4SWiw3te5djgdYZ6k/oI2peVKVuRF4fn9tBb6dNqcmzU5L/qw
IFAGbHrQgLKm+a/sRxmPUDgH3KKHOVj4utWp+UhnMJbulHheb4mjUcAwhmahRWa6
VOujw5H5SNz/0egwLX0tdHA114gk957EWW67c4cX8jJGKLhD+rcdqsq08p8kDi1L
93FcXmn/6pUCyziKrlA4b9v7LWIbxcceVOF34GfID5yHI9Y/QCB/IIDEgEw+OyQm
jgSubJrIqg0CAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC
AYYwHQYDVR0OBBYEFIQYzIU07LwMlJQuCFmcx7IQTgoIMA0GCSqGSIb3DQEBCwUA
A4IBAQCY8jdaQZChGsV2USggNiMOruYou6r4lK5IpDB/G/wkjUu0yKGX9rbxenDI
U5PMCCjjmCXPI6T53iHTfIUJrU6adTrCC2qJeHZERxhlbI1Bjjt/msv0tadQ1wUs
N+gDS63pYaACbvXy8MWy7Vu33PqUXHeeE6V/Uq2V8viTO96LXFvKWlJbYK8U90vv
o/ufQJVtMVT8QtPHRh8jrdkPSHCa2XV4cdFyQzR1bldZwgJcJmApzyMZFo6IQ6XU
5MsI+yMRQ+hDKXJioaldXgjUkK642M4UwtBV8ob2xJNDd2ZhwLnoQdeXeGADbkpy
rqXRfboQnoZsG4q5WTP468SQvvG5
-----END CERTIFICATE-----`;

/* On-modem filenames the Dragino app firmware reads. */
export const BG95_NAMES = {
    ca: 'cacert.pem',
    cert: 'client.pem',
    key: 'user_key.pem',
};

/* ── Pure functions (mirror certs.py) ───────────────────────────────────── */

function pemLines(pemText) {
    const lines = pemText.trim().split('\n').map(l => l.replace(/\r+$/, ''));
    if (!lines.length || !lines[0]) throw new Error('certificate is empty');
    return lines;
}

/* What the BG95 STORES: every line terminated by canonical CRLF. Its length is
 * the size to declare to QFUPL; its checksum is the integrity gate. */
export function canonicalBytes(pemText) {
    return new TextEncoder().encode(pemLines(pemText).join('\r\n') + '\r\n');
}

/* What goes on the wire: one part per PEM line, each ending in a BARE CR. */
export function wireParts(pemText) {
    const enc = new TextEncoder();
    return pemLines(pemText).map(l => enc.encode(l + '\r'));
}

/* XOR over 16-bit big-endian words; a trailing odd byte pairs with 0. This
 * reproduces the modem's `+QFUPL: <size>,<checksum>` value. */
export function qfuplChecksum(bytes) {
    let acc = 0;
    for (let i = 0; i < bytes.length; i += 2) {
        const hi = bytes[i];
        const lo = i + 1 < bytes.length ? bytes[i + 1] : 0;
        acc ^= (hi << 8) | lo;
    }
    return acc & 0xFFFF;
}

const QFUPL_RE = /\+QFUPL:\s*(\d+)\s*,\s*([0-9A-Fa-f]+)/;

/* The LAST result in a response window — an earlier attempt must not be read
 * as this one's verdict. */
export function parseQfupl(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = QFUPL_RE.exec(lines[i]);
        if (m) return { size: parseInt(m[1], 10), checksum: parseInt(m[2], 16) };
    }
    return null;
}

export function hex4(n) {
    return n.toString(16).toUpperCase().padStart(4, '0');
}

/*
 * The three writes, derived from the bundle. The CA is not per-unit and comes
 * from the constant above; only the client pair travels with the device.
 */
export function buildTargets(bundle) {
    const of = (label, name, text) => {
        const canonical = canonicalBytes(text);
        return {
            label, bg95Name: name, text,
            declaredSize: canonical.length,
            expectedChecksum: qfuplChecksum(canonical),
            parts: wireParts(text),
        };
    };
    return [
        of('CA', BG95_NAMES.ca, AMAZON_ROOT_CA1),
        of('client certificate', BG95_NAMES.cert, bundle.certificate),
        of('private key', BG95_NAMES.key, bundle.private_key),
    ];
}

/* ── Pacing ─────────────────────────────────────────────────────────────── */

/*
 * A part must be given at least its own drain time before the next one. The
 * dominant constraint is the firmware's single line buffer, but the 9600-baud
 * bridge sets a hard floor that is easy to compute and cheap to double.
 */
export function partDelayMs(partBytes, floorMs = 150) {
    const wireMs = (partBytes * 10 / 9600) * 1000;
    return Math.max(floorMs, Math.ceil(wireMs * 2));
}

/* ── Orchestration ──────────────────────────────────────────────────────── */

const realSleep = ms => new Promise(r => setTimeout(r, ms));

/* Pacing is a device property, so it is injectable like every other one. A
 * simulated modem has no 300-byte buffer to drain and should not cost nine
 * seconds a run to say so. */
const pause = (io, ms) => (io.sleep || realSleep)(ms);

/*
 * `io` is the whole device dependency, so this module never imports a
 * transport and can be exercised without one:
 *   send(text)      one console line (transport appends CRLF)
 *   sendRaw(bytes)  exact bytes, no terminator — the PEM parts
 *   listen(ms)      resolve with every line received during the window
 *   until(re, ms)   same, but resolve as soon as `re` matches — ms is a ceiling
 *   log(text, kind) display; callers pass already-redacted text only
 */
async function at(io, command, windowMs) {
    io.log(command, 'tx');
    const replies = io.listen(windowMs);
    await io.send(command);
    return replies;
}

/*
 * Enter passthrough.
 *
 * `AT+CERTMOD` is a TOGGLE, and leaving passthrough POWERS THE MODEM DOWN —
 * both observed live on 2026-08-04:
 *
 *     >>> AT+CERTMOD
 *     [35102]Exit certificate mode
 *     NORMAL POWER DOWN            <- the BG95 going away
 *     >>> AT+CERTMOD
 *     [40820]Enter certificate mode
 *     RDY                          <- and coming back
 *     [42470]Signal Strength:0     <- with no network yet, which is not the
 *                                     same thing as not being there
 *
 * The state is therefore recoverable in software: a unit found inside is
 * toggled out and straight back in, inside the same window, at the cost of a
 * few seconds rather than a reset. `Signal Strength:0` had previously been
 * read as a modem that was gone — it is a modem that has just booted.
 *
 * Leaving a unit inside passthrough is still a real cost, not an untidiness.
 * `enterCertmod` therefore cleans up after itself: if it engages and cannot
 * confirm the modem, it toggles back out before throwing, so the next attempt
 * starts from a known state instead of inheriting this one.
 *
 * BG95 `RDY` remains the mandatory engagement proof — the firmware printing
 * entry means the STM32 flipped while the modem may not have, and streaming
 * into that writes nowhere. It arrives seconds late (it is a reboot), so the
 * wait ends on the marker rather than on a fixed window.
 */
/*
 * Wait until the firmware has finished talking to the BG95 itself.
 *
 * After every boot the firmware runs its own NB init — frequency band, network
 * category, data format, APN — and it drives the modem for the whole of it.
 * Entering passthrough in the middle lands on a modem that is already in
 * another conversation, and `RDY` never comes. Observed 2026-08-04, twice, and
 * the two runs differ in nothing else:
 *
 *     [31891]Enter certificate mode   <- inside init, and the firmware kept
 *     [33433]Configure Network Category   going: no RDY, ever
 *     [36366]Set APN successfully
 *
 *     [28053]Set APN successfully     <- init finished first
 *     [40820]Enter certificate mode
 *     RDY                             <- immediately
 *
 * `Signal Strength:` is the heartbeat that only starts once init is done, and
 * it repeats for the rest of the window. So waiting for one is both the gate
 * and self-healing: on a unit that is already past init, the next beat is
 * seconds away rather than a state to reconstruct.
 *
 * It never blocks. If the heartbeat does not come the entry is attempted
 * anyway and the RDY gate stays the arbiter — a wait that can strand the
 * operator would be worse than the collision it avoids.
 */
async function awaitFirmwareIdle(io, ms = 20000) {
    const beat = /Signal Strength:/i;
    io.log('waiting for the firmware to finish its NB init', 'note');
    const seen = await io.until(beat, ms);
    if (seen.some(l => beat.test(l))) return true;
    io.log('no Signal Strength heartbeat — entering anyway, NB init may still ' +
           'own the modem', 'note');
    return false;
}

async function enterCertmod(io, attempts = 3) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        await awaitFirmwareIdle(io);
        io.log('AT+CERTMOD', 'tx');

        /*
         * ONE collector spans the whole entry, from the command to the answer
         * that settles it. Two sequential collectors lose everything that
         * arrives between them, and on 2026-08-04 that cost a good session:
         * the device sent `Enter certificate mode` / `OK` / `RDY` in a single
         * batch, the first collector resolved on the first line and left the
         * set synchronously, and the collector that then went looking for RDY
         * registered a beat too late. It waited its full 25 s for a line that
         * had already gone past, and the code took that silence for a modem
         * that was not there — while the modem was up and waiting.
         *
         * So the wait ends on what actually decides the outcome: BG95 `RDY`,
         * or the `Exit` that says the unit was already inside.
         */
        const settled = io.until(
            /Exit certificate mode|(^|\s)RDY(\s|$)/i, 15000);
        await io.send('AT+CERTMOD');
        let seen = (await settled).join('\n');

        /* Lines sharing a batch with the resolving one are delivered after it.
         * A short drain is what makes the buffer complete rather than merely
         * long enough — it is the same gap, one level down. */
        seen += '\n' + (await io.listen(400)).join('\n');

        if (/Exit certificate mode/i.test(seen)) {
            /* A previous attempt left it inside, and it is now out. Leaving
             * powers the BG95 down, but entering brings it back — observed
             * live: `Exit` + `NORMAL POWER DOWN`, then a re-entry answered
             * with `RDY`. So this is a state to pass through, not a reason to
             * send the operator back for a reset. The RDY gate below is what
             * stays honest if the modem does not in fact return. */
            io.log('was inside passthrough — now out, re-entering', 'note');
            await pause(io, 1500);
            continue;
        }

        if (!/Enter certificate mode/i.test(seen)) {
            io.log(`no CERTMOD response; retry ${attempt + 1}/${attempts}`, 'note');
            await pause(io, 1500);
            continue;
        }

        if (!/(^|\s)RDY(\s|$)/.test(seen)) {
            io.log('no RDY — leaving passthrough so the next attempt starts clean',
                   'note');
            await exitCertmod(io);
            throw new Error(
                'CERTMOD state unknown: the firmware printed entry but BG95 RDY ' +
                'was never seen. The modem is not responding — press RESET and ' +
                'read the log before retrying');
        }

        io.log('CERTMOD engaged (Enter certificate mode + BG95 RDY)', 'note');
        const echo = await at(io, 'ATE0', 3000);
        if (!echo.some(l => /\bOK\b/.test(l))) {
            await exitCertmod(io);
            throw new Error(
                'BG95 did not confirm ATE0 — refusing to stream key material ' +
                'into a console that may echo it back onto this screen');
        }
        return;
    }
    throw new Error('could not enter CERTMOD with a confirmed BG95 RDY');
}

async function exitCertmod(io) {
    const lines = await at(io, 'AT+CERTMOD', 12000);
    const confirmed = lines.join('\n').includes('Exit certificate mode');
    io.log(`CERTMOD exit: ${confirmed ? 'confirmed' : 'UNCONFIRMED'}`,
           confirmed ? 'note' : 'fail');
    return confirmed;
}

/*
 * Inventory, after the writes. The reference is explicit that this is evidence
 * and not an integrity gate — the checksums above remain the only proof of
 * correct stored content. It is here because "the file exists on the modem with
 * this size" is an independent second opinion, and independent second opinions
 * are what let you believe the first one.
 */
async function listFiles(io) {
    await at(io, 'AT+QFLST="*"', 3000);
}

/* Stream one PEM as paced bare-CR parts. Nothing of the payload is displayed —
 * only a redacted progress label. */
async function streamParts(io, target) {
    let collected = [];
    for (let i = 0; i < target.parts.length; i++) {
        const part = target.parts[i];
        const final = i === target.parts.length - 1;

        io.log(`[${target.bg95Name} PEM part ${i + 1}/${target.parts.length} redacted]`,
               'tx');
        const replies = io.listen(final ? 15000 : 60);
        await io.sendRaw(part);
        collected = collected.concat(await replies);

        if (!final) await pause(io, partDelayMs(part.length, io.floorMs));
    }
    return parseQfupl(collected);
}

/*
 * Replace one file and accept only an exact size AND checksum match. A
 * matching size proves nothing on its own — a corrupted stream of the right
 * length is exactly the failure this gate exists for.
 */
async function writeTarget(io, target, retries = 3) {
    const want = { size: target.declaredSize, checksum: target.expectedChecksum };

    for (let attempt = 1; attempt <= retries; attempt++) {
        io.log(`${target.label} → ${target.bg95Name} ` +
               `(attempt ${attempt}/${retries}, size=${want.size}, ` +
               `checksum=${hex4(want.checksum)})`, 'note');

        /* QFDEL returning ERROR when the file is absent is expected and
         * allowed; the upload still starts from a clean slot. */
        await at(io, `AT+QFDEL="${target.bg95Name}"`, 2000);

        const opened = await at(
            io, `AT+QFUPL="${target.bg95Name}",${want.size},100`, 3000);

        if (!opened.some(l => l.includes('CONNECT'))) {
            io.log('  QFUPL did not return CONNECT', 'fail');
        } else {
            const got = await streamParts(io, target);
            if (got && got.size === want.size && got.checksum === want.checksum) {
                io.log(`  VERIFIED +QFUPL: ${got.size},${hex4(got.checksum)}`, 'ok');
                return true;
            }
            if (!got) io.log('  no +QFUPL result received', 'fail');
            else io.log(`  INTEGRITY MISMATCH: got ${got.size},${hex4(got.checksum)}` +
                        ` — expected ${want.size},${hex4(want.checksum)}`, 'fail');
        }

        /* Never leave a known-bad file in the modem between attempts. */
        await at(io, `AT+QFDEL="${target.bg95Name}"`, 2000);
        if (attempt < retries) await pause(io, 2000);
    }
    throw new Error(
        `${target.bg95Name} failed the checksum gate after ${retries} attempts`);
}

/*
 * Write all three. Resolves when every file passed its gate; throws on the
 * first that did not, leaving nothing half-written behind it.
 * `onProgress(done, total)` fires after each verified file.
 */
export async function writeCerts(io, bundle, onProgress = () => {}) {
    const targets = buildTargets(bundle);
    let exited = false;
    await enterCertmod(io);
    try {
        for (let i = 0; i < targets.length; i++) {
            await writeTarget(io, targets[i]);
            onProgress(i + 1, targets.length);
        }
        await listFiles(io);
    } finally {
        /* Always attempt the exit, including after a failure — leaving the unit
         * in passthrough is worse than the failure that got us here. */
        exited = await exitCertmod(io);
    }

    if (!exited) throw new Error('CERTMOD exit was not confirmed');

    /*
     * Dragino's guide requires a restart after certificate changes, so this is
     * part of the write and not an afterthought: certs that are stored but
     * never picked up read exactly like certs that were never written.
     *
     * It ends the session — the device reboots, the AT window closes and the
     * BLE link drops until the next cycle. That is the expected outcome of a
     * successful run, not a failure.
     */
    io.log('ATZ — restarting: Dragino requires it after a certificate change', 'note');
    await at(io, 'ATZ', 500);
    return targets.length;
}
