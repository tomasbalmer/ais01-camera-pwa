/*
 * CERTMOD certificate write — Dragino v1.3, over BLE from the phone.
 *
 * Proven 2026-08-06 against unit 869181072714122: all three files accepted on
 * the first attempt, `+QFUPL: 1208,5769` for the Amazon root CA — the same
 * pair `cli/ais01_cli/commands/certs.py` produced, and the acceptance test for
 * this file.
 *
 * Four things are load-bearing. Changing any of them silently corrupts a
 * certificate that still reports success:
 *
 * 1. THE CADENCE. The console accepts one line and discards the next two, on a
 *    clock of roughly two seconds. It is the whole problem — every other
 *    suspect (part size, BLE slicing, modem echo, ACK mode, antenna) was tested
 *    and cleared. `io.floorMs` in provision.js carries the number, and
 *    `streamParts` explains how it was measured.
 *
 * 2. THE UNIT MUST BE IDLE. Write after `NB module power-off successful`, not
 *    during a cycle. Mid-cycle the modem is taken away underneath the upload
 *    and the failure reads as a dead device.
 *
 * 3. THE TERMINATOR IS A LONE `\r`. The app truncates each console line at its
 *    first CR/LF and appends CRLF unconditionally before forwarding, so the
 *    modem stores exactly `part + CRLF`. A full CRLF sends a SECOND terminator
 *    into a handler that raises `line_ready` on either one — see
 *    `console-line-law.js`, and `wireParts` for what that cost.
 *
 * 4. WHAT IS STORED IS NOT WHAT IS SENT. `+QFUPL` describes the canonical-CRLF
 *    content, so the size declared and the checksum gated on come from
 *    `canonicalBytes`, never from the wire bytes.
 *
 * Echo is a confidentiality matter and nothing more: it is left on for the two
 * public files and silenced immediately before the private key. It was once
 * thought to carry the transfer; it does not.
 */

import { checkParts, forwardedBytes, wireImage } from './console-line-law.js';

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

/*
 * What goes on the wire: one part per PEM line, terminated by a BARE CR.
 *
 * This is the reference writer's recipe — `certs.py:wire_parts`, the code that
 * produced `+QFUPL: 1208,5769` over USB — and it was abandoned here for two
 * windows on a claim that could not have been measured.
 *
 * The claim was "this firmware appends nothing, so send canonical CRLF", and
 * its evidence was a one-line probe declaring 28 that answered `+QFUPL:
 * 28,6c53`. That probe cannot distinguish the two behaviours, because the modem
 * truncates to the size it was told and the truncation drops exactly the byte
 * in dispute: `line+CR` forwarded untouched and `line+CRLF` forwarded as
 * `line+CRLF` both present the same first 28 bytes. Two runs, no information.
 *
 * What settles it is not a probe but the firmware, disassembled in
 * `console-line-law.js`: `normalize()` writes NUL over the first CR or LF
 * (0x0801a450) and the forward path appends CR and LF itself (0x0801108a,
 * 0x08011096). The app appends. It always did.
 *
 * So a trailing LF is not harmless padding, it is a second terminator into a
 * handler that raises `line_ready` on either byte. Whenever the main loop runs
 * in the gap between the CR and the LF, the LF dispatches alone: a stray `\r\n`
 * into the upload, and an extra dispatch turn during which the NEXT part lands
 * in a buffer that is not ready and is discarded — the single 300-byte buffer
 * has no queue.
 *
 * That is the line loss. It is a race, which is why it presented as twenty
 * lines failing while one line always worked: with one line there is no next
 * part to destroy, and the stray CRLF arrives after the modem already has the
 * byte count it was promised. The one-line probe is structurally blind to it.
 */
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

/*
 * The same result, for a line whose head did not survive the trip.
 *
 * Observed twice on 2026-08-06, both times on the one line the whole write is
 * judged by:
 *
 *     ?eUA1? 29,6653          should have been  +QFUPL: 29,6653
 *     ?eUA1? 430,846          should have been  +QFUPL: 430,846
 *
 * Losing the head of a line is the failure this transport has shown all day in
 * the other direction; this is it on the way back. The consequence is worse
 * than a cosmetic one: `QFUPL_RE` needs the literal `+QFUPL:`, so a write that
 * SUCCEEDED and reported `+QFUPL: 1242,5D64` would be read as no answer at
 * all, retried over a slot that already held the correct file, and finally
 * given up on. Any run today could have been that, and nobody would have
 * known.
 *
 * So a line is also accepted when it ends in the exact shape of a result —
 * decimal size, comma, one to four hex digits, nothing after it. That shape is
 * specific enough not to collide with PEM base64 (which carries no comma) or
 * with the firmware's own `[12345]...` lines (which carry no comma either).
 * The strict form is still tried first and wins whenever it survived.
 */
const QFUPL_MANGLED_RE = /(?:^|\s)(\d{1,7})\s*,\s*([0-9A-Fa-f]{1,4})\s*$/;

/*
 * The firmware announcing that it has taken the modem away.
 *
 * This is not an error the modem returns — it is the app's own cycle ending on
 * schedule, and it ends the write whether or not the write was going well.
 * Observed 2026-08-05 in the middle of an upload:
 *
 *     [53291] CONNECT                        <- the upload opens
 *     [68606] Turn off the module receiving and sending RF function.
 *     [73377] Closing NB module...
 *     [73408] NB module power-off successful.
 *
 * Fifteen seconds. Everything after that point in the run — the 40 s wait for a
 * `+QFUPL` nobody was left to send, `QFLST`, and two more full attempts — was
 * spent talking to a modem that was not there. Recognising the announcement is
 * what turns that into an immediate, correctly-named failure.
 */
const MODEM_GONE_RE =
    /NORMAL POWER DOWN|Closing NB module|NB module power-off|Turn off the module receiving/i;

/* The LAST result in a response window — an earlier attempt must not be read
 * as this one's verdict. */
export function parseQfupl(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = QFUPL_RE.exec(lines[i]);
        if (m) return { size: parseInt(m[1], 10), checksum: parseInt(m[2], 16) };
    }
    /* Only once no intact result exists anywhere: a mangled head costs the
     * literal marker but not the numbers, and the numbers are still checked
     * against the expected size AND checksum before anything is believed. */
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = QFUPL_MANGLED_RE.exec(lines[i]);
        if (m) {
            return { size: parseInt(m[1], 10), checksum: parseInt(m[2], 16) };
        }
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
    /* `secret` decides whether an unsilenced echo is a reason to refuse. The
     * CA ships in this file's source and the client certificate is presented
     * in the clear on every TLS handshake; the key is the one that matters. */
    return [
        { ...of('CA', BG95_NAMES.ca, AMAZON_ROOT_CA1), secret: false },
        { ...of('client certificate', BG95_NAMES.cert, bundle.certificate),
          secret: false },
        { ...of('private key', BG95_NAMES.key, bundle.private_key),
          secret: true },
    ];
}

/* ── Pacing ─────────────────────────────────────────────────────────────── */

/*
 * A part must be given at least its own drain time before the next one — and
 * the drain that matters is not the wire's.
 *
 * `cli/ais01_cli/core/console_line_law.py`, read off the firmware itself, is
 * the authority: the console has ONE 300-byte line buffer and no queue. The RX
 * handler fills it and raises `line_ready`; the main loop dispatches, then
 * zeroes it. Anything that arrives in between is discarded outright. A burst
 * does not stress the link, it destroys lines.
 *
 * So the floor is set by how often that main loop comes round, not by 9600
 * baud. The proven writer picked 600 ms and labelled it "conservative
 * BLE-safe"; this ran at 150 and lost a fifth of every certificate to a
 * buffer that had not been emptied yet. Four times too fast, silently, which
 * is exactly the failure mode the law describes.
 */
export function partDelayMs(partBytes, floorMs = 600) {
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
/*
 * Wait for a marker, then drain whatever shared its batch.
 *
 * The drain is not optional: a collector leaves the set synchronously on the
 * line that matches, so anything delivered after it in the same batch reaches
 * nobody. That is the bug that cost a session on 2026-08-04, and every early
 * resolve reintroduces it unless the drain follows.
 */
async function reply(io, pattern, ceilingMs, drainMs = 250) {
    const lines = await io.until(pattern, ceilingMs);
    return lines.concat(await io.listen(drainMs));
}

/* What ends an AT exchange. An echoed command is not an answer, so the
 * terminator has to be the answer itself. */
const AT_DONE = /^\s*(OK|ERROR|CONNECT|\+CM[ES] ERROR)/im;

/*
 * One AT command, resolved by its answer rather than by a stopwatch.
 *
 * `windowMs` used to be a duration and is now a ceiling. Every exchange in a
 * cert write was paying its full budget whether or not the device had already
 * answered — `ATE0`, the echo probe, and two `QFDEL`s alone spent ten seconds
 * waiting for replies that had arrived in a few hundred milliseconds. In a
 * window worth about twenty-five seconds that was most of it, and it is why
 * three files never fit into one.
 */
async function at(io, command, windowMs) {
    io.log(command, 'tx');
    const replies = reply(io, AT_DONE, windowMs);
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
        /*
         * Every attempt waits, including the second one, and the reason is not
         * the one this wait was named for.
         *
         * Skipping it after the first attempt looked free — init cannot restart
         * once a heartbeat has been seen — and it broke entry immediately:
         * `NORMAL POWER DOWN` at 12:17:46, re-entry 1.5 s later, `Enter
         * certificate mode` and then no RDY at all. Leaving passthrough powers
         * the BG95 down, and what this wait actually buys on the second toggle
         * is the modem's power cycle. It is load-bearing under a misleading
         * name, so it stays.
         */
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
        /*
         * An echo that will not go off is a disclosure risk, and the risk is
         * not the same for all three files. The Amazon root CA and the client
         * certificate are public — the CA ships in this app's source. Only the
         * private key is a secret, and only it is worth refusing over.
         *
         * So the outcome is recorded and enforced per file, rather than
         * stopping a write that discloses nothing. See `writeTarget`.
         */
        /*
         * The echo is left on here and silenced later, per file.
         *
         * It was once believed to carry the transfer — the run that completed
         * had it on, and with `ATE0` applied only the first line ever arrived.
         * That was a coincidence of two variables moving together: the real
         * cause was the cadence (see `streamParts`), and the echo turned out
         * to make no difference either way once the pacing was right.
         *
         * What survives is the confidentiality rule, unchanged in substance
         * and only moved in time. The CA ships in this file's own source and
         * the client certificate crosses every TLS handshake in the clear, so
         * echoing them discloses nothing. The private key is different, and
         * `writeCerts` silences the modem immediately before it — close to the
         * one file that needs it, rather than over the whole session.
         */
        io.echoOff = false;
        await radioOff(io);
        return;
    }
    throw new Error('could not enter CERTMOD with a confirmed BG95 RDY');
}

/*
 * Turn the BG95's echo off, and prove it rather than believe it.
 *
 * Entering passthrough reboots the modem, which comes back at its `ATE1`
 * default, so the echo the firmware silenced during its own init is on again.
 * `OK` after `ATE0` was being taken as proof and is not: on 2026-08-04 every
 * later command still came back echoed, and so did the certificate body —
 * `b6dNqcmzU5L/qw` appeared verbatim in the log during the upload.
 *
 * Two reasons that matters, and only one of them is tidiness:
 *
 *   - a private key echoed onto a phone screen is the disclosure this gate
 *     exists to prevent;
 *   - the echo doubles the return traffic through a 9600-baud console, and it
 *     showed: at 16:34:13 the display was rendering device time [53443] from
 *     about nine seconds earlier. A `+QFUPL` answer arriving into a backlog
 *     that deep can miss its window without ever having been lost.
 *
 * The probe has to reach the modem to mean anything, and the obvious choice
 * does not. `console_line_law.py` reads it off the firmware: `at_dispatch`
 * answers a bare `AT` locally and never forwards it, so the first version of
 * this probe was asking the app whether the modem echoes. It always came back
 * clean, and every following command was still echoed. `ATI` is neither
 * locally answered nor one of the 58 table entries the app intercepts, so it
 * crosses into the BG95 and its echo is the modem's own.
 */
/*
 * Put the radio to sleep for the duration of the write.
 *
 * This unit never finds a network — every `Signal Strength` line it prints is
 * 99 or 0, which is 3GPP for "not detectable" — so the BG95 spends the whole
 * window hunting at full transmit power. On 2026-08-05 that showed up as the
 * modem restarting in the MIDDLE of an upload:
 *
 *     23:16:36  APP RDY          <- part 9 of 20 had just gone out
 *     23:17:24  C?AA?RDY
 *
 * and the file was left truncated wherever the reset caught it. Three runs, the
 * same certificate, three different sizes reported by `AT+QFLST`:
 *
 *     600 ms/line, ~17 s   ->  557 B
 *       0 ms/line,  ~8 s   ->  407 B
 *     1500 ms/line, ~38 s  ->  203 B
 *
 * No relationship to pacing at all — the truncation point is wherever the
 * modem happened to fall over. That is what makes this a power problem rather
 * than a timing one, and why every cadence tried so far failed differently.
 *
 * `AT+CFUN=0` is minimum functionality: the radio stops, the AT interface and
 * the file system keep working, which is exactly the subset an upload needs
 * (`docs/hardware/05-modem-at-commands.md`). `AT+CFUN=1` puts it back.
 *
 * It is not fatal if it is refused — a modem that will not go quiet can still
 * be written to, it is just likelier to fall over doing it, and the checksum
 * gate will say so.
 */
async function radioOff(io) {
    /*
     * Four seconds, not twenty — the budget changed owners on 2026-08-06.
     *
     * The 20 s window (raised from 6 s on 2026-08-05) assumed the enemy was a
     * slow detach: give `AT+CFUN=0` long enough and the countermeasure lands.
     * Watched live on 2026-08-06, the enemy turned out to be a clock. On an
     * unregistered unit the app firmware power-cycles the BG95 on its own
     * NB-retry schedule — `NORMAL POWER DOWN`, then `RDY` — every 45–75 s,
     * and entering CERTMOD starts a fresh modem life. Everything between that
     * `RDY` and the last upload byte has to fit inside one life: the run of
     * 2026-08-06 03:22 spent 20 s here, died at 1085/1208 B, and lost the
     * race by two seconds.
     *
     * On this unit `AT+CFUN=0` has never answered at all — silence at 6 s,
     * silence at 20 s, echo but no `OK` either time. Waiting longer buys
     * nothing and costs exactly the seconds the write is short of. Four
     * seconds keeps the attempt (a modem that CAN comply answers well within
     * that) without funding it out of the upload's lifetime.
     *
     * Known risk, accepted: if a modem ever confirmed late, its stray `OK`
     * would land in the next command's reply window. Both observed windows
     * say this unit's silence is forever-silence, and the checksum gate is
     * still behind everything this function fails to prevent.
     */
    for (const [cmd, what] of [['AT+CFUN=0', 'minimum functionality'],
                               ['AT+CFUN=4', 'transmit disabled']]) {
        const seen = (await at(io, cmd, 4000)).join('\n');
        if (/\bOK\b/.test(seen)) {
            io.log(`  radio off (${cmd}, ${what}) — the modem stops ` +
                   `transmitting into a missing antenna, which is what was ` +
                   `resetting it mid-upload`, 'note');
            io.radioOff = cmd === 'AT+CFUN=0' ? 1 : 4;
            return;
        }
        /* `ERROR` means this firmware does not take it and the next form is
         * worth a try; silence means the modem is not answering at all, and a
         * second command will not change that. */
        if (!/ERROR/i.test(seen)) break;
        io.log(`  ${cmd} refused — trying the weaker form`, 'note');
    }
    io.log('  radio could not be silenced — writing with it still on, which on ' +
           'a unit with no antenna is the condition that truncates the file',
           'fail');
    io.radioOff = 0;
}

async function radioOn(io) {
    if (!io.radioOff) return;
    await at(io, 'AT+CFUN=1', 6000);
    io.radioOff = false;
}

const ECHO_PROBE = 'ATI';

async function silenceEcho(io, attempts = 3) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        await at(io, 'ATE0', 3000);

        const probe = await at(io, ECHO_PROBE, 2500);
        /*
         * ONE copy back is the BT24's, not the modem's. The bridge echoes
         * what it is handed, locally, before any of it reaches the device — so
         * "did the text come back" cannot answer this question and said echo
         * was off while it was on, then on while it was off.
         *
         * The count separates them, and the live logs show it cleanly: with
         * echo still on, `ATE0` came back TWICE from one send; once `ATE0` had
         * taken, `ATI` came back once and its answer followed. Two copies is
         * the modem adding its own to the bridge's.
         */
        const copies = probe.filter(l => l.trim() === ECHO_PROBE).length;
        const echoed = copies >= 2;
        const answered = probe.some(l => /\bOK\b/.test(l));

        if (answered && !echoed) {
            io.log(`  echo off (${ECHO_PROBE} came back without its own text)`,
                   'note');
            return true;
        }
        if (!answered) {
            io.log(`  no answer to the echo probe; retry ${attempt + 1}/${attempts}`,
                   'note');
            continue;
        }
        io.log(`  echo still on after ATE0; retry ${attempt + 1}/${attempts}`,
               'note');
    }
    return false;
}

/*
 * Leave passthrough — and check which way the toggle actually went.
 *
 * `AT+CERTMOD` is a toggle with no query form, so "exit" is only an intention.
 * Observed 2026-08-04: when the firmware powered the NB module off at [58245]
 * it had already left certificate mode on its own, so the exit sent at [71752]
 * ENTERED instead, answered `Enter certificate mode` + `RDY`, and the run
 * finished by leaving the unit inside the state it was trying to leave.
 *
 * That is where every following run's `was inside passthrough` came from: a
 * cost we were charging ourselves, twice — a wasted entry attempt and the
 * seconds it takes, in a window that has none to spare.
 *
 * So the reply decides. `Enter` means the unit was already out and is now in;
 * one more toggle puts it back.
 */
async function exitCertmod(io, toggles = 2) {
    for (let i = 1; i <= toggles; i++) {
        const seen = (await at(io, 'AT+CERTMOD', 12000)).join('\n');

        if (/Exit certificate mode/i.test(seen)) {
            io.log('CERTMOD exit: confirmed', 'note');
            return true;
        }
        if (/Enter certificate mode/i.test(seen)) {
            /* The firmware had already left. This toggle put it back in, so it
             * takes one more to undo — and that one will answer `Exit`. */
            io.log('CERTMOD was already out; that toggle re-entered it — ' +
                   'toggling back', 'note');
            continue;
        }
        io.log('CERTMOD exit: no answer to the toggle', 'fail');
        return false;
    }
    io.log('CERTMOD exit: UNCONFIRMED after both toggles', 'fail');
    return false;
}

const QFLST_RE = /\+QFLST:\s*"([^"]+)"\s*,\s*(\d+)/;

/*
 * Ask a second time, down a quieter channel.
 *
 * A missing `+QFUPL` had been read as "the modem is still waiting for bytes",
 * and that is one of two possibilities. The other is that the transfer
 * finished, the modem answered, and the answer did not survive the trip back.
 * The 2026-08-04 logs make the second one credible: the echo returning during
 * an upload arrives in fragments and stops mid-line — `b24gUm9vdCBDQSAxMB4XDTE1M`
 * where sixty-four characters were sent. A return path dropping that much can
 * drop one line of answer just as easily.
 *
 * `AT+QFLST` settles it, and it is the right instrument precisely because it
 * is small: one command and one short line, asked once the flood has stopped.
 *
 *   the file is there at the declared size  the write landed; the ANSWER was
 *                                           lost, not the data
 *   the file is absent or short             the modem really is short of bytes
 *
 * A size is still not proof of content — only the checksum is that, and this
 * changes nothing about the gate. It is here to name the failure, which is
 * what turns a third identical run into a different one.
 */
async function explainSilence(io, target, want) {
    const lines = await at(io, `AT+QFLST="${target.bg95Name}"`, 3000);
    const found = lines.map(l => QFLST_RE.exec(l)).find(Boolean);
    const answered = lines.some(l => /\b(OK|ERROR)\b|\+CM[ES] ERROR/.test(l));

    if (lines.some(l => MODEM_GONE_RE.test(l))) {
        io.log('  the firmware powered the NB module off — the modem left ' +
               'mid-write, so nothing here is a verdict on the bytes', 'fail');
        return 'gone';
    }
    if (!found && !answered) {
        /* Nothing came back at all, which is not the same as the file being
         * absent — and reading it that way on 2026-08-05 produced a confident
         * "bytes were lost on the way in" about a modem that had been powered
         * off eleven seconds earlier. A question nobody was awake to hear
         * proves nothing. */
        io.log('  QFLST got no answer either — the modem is gone, so this run ' +
               'cannot say whether the transfer completed', 'note');
        return 'gone';
    }
    if (!found) {
        io.log('  QFLST finds no such file — the modem never completed the ' +
               'transfer, so bytes were lost on the way in', 'fail');
        return 'short';
    }
    const size = parseInt(found[2], 10);
    if (size === want.size) {
        io.log(`  QFLST says the file IS there at ${size}B — the transfer ` +
               `landed and it was the +QFUPL answer that was lost coming back`,
               'ok');
        return 'landed';
    }
    io.log(`  QFLST says ${size}B of ${want.size}B — the modem is genuinely ` +
           `short by ${want.size - size}`, 'fail');
    return 'short';
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
/* The last part is done when the modem answers — or when the firmware says the
 * modem is leaving, which is equally final and arrives much sooner. */
const FINAL_DONE = new RegExp(`${QFUPL_RE.source}|${MODEM_GONE_RE.source}`, 'i');

/*
 * The upload cadence, and why it is the only thing that ever mattered.
 *
 * The console accepts one line and discards the next two. Measured
 * 2026-08-06 from three identical attempts that answered
 * `+QFUPL: 389,041E`: the lines that came back echoed were parts 1, 4, 7,
 * 10, 13, 16 and 19 — one in three, no exceptions — and the stored size
 * accounts for exactly those and nothing else (29 + 5x66 + 30 = 389). So
 * the loss is not corruption or truncation; whole lines are dropped, on a
 * clock, and the fix is to send slower than that clock. `io.floorMs` in
 * provision.js carries the number.
 *
 * The echo is kept in view but never acted on. It was acted on for most of
 * that day — a line whose echo did not return aborted the attempt — and
 * since the abort fired on part 2, no run ever reached the end and the
 * one-in-three pattern stayed invisible. Counting the echoes is what
 * finally showed it; stopping on them is what hid it.
 *
 * The verdict is the modem's own `+QFUPL: <size>,<checksum>`, because that
 * number is computed over what was actually stored and no observation from
 * this end can be.
 */
/* QFUPL's own idle timeout is 60 s from the last byte; the result follows. */
const CONFESSION_MS = 70000;

async function streamParts(io, target) {
    let collected = [];
    let receipted = 0;

    for (let i = 0; i < target.parts.length; i++) {
        const part = target.parts[i];
        const final = i === target.parts.length - 1;
        /* Parts are encoded bytes (`wireParts`); the echo to look for is the
         * line as the console forwards it, without its terminator. */
        const fb = forwardedBytes(part);
        const wire = String.fromCharCode(...fb.subarray(0, fb.length - 2));

        io.log(`[${target.bg95Name} PEM part ${i + 1}/${target.parts.length} redacted]`,
               'tx');
        /* The final part waits for the `+QFUPL` result — the modem answers the
         * moment it has the byte count it was promised. Every other part waits
         * out its pacing and nothing else. */
        const replies = final
            ? reply(io, FINAL_DONE, CONFESSION_MS)
            : io.listen(Math.max(60, partDelayMs(part.length, io.floorMs)));
        await io.sendRaw(part);
        const seen = await replies;
        collected = collected.concat(seen);
        if (seen.some(l => l === wire)) receipted++;

        /* Stop the moment the firmware announces the power-off. Continuing
         * writes PEM into a closed port and waits for an answer that has no
         * one to send it. */
        if (collected.some(l => MODEM_GONE_RE.test(l))) {
            io.log(`  the firmware took the NB module away at part ${i + 1}/` +
                   `${target.parts.length} — abandoning the stream`, 'fail');
            return { got: null, gone: true };
        }
    }

    /* Reported, never acted on — see the note above the cadence. The count
     * separates a run that echoed every line from one that echoed a third of
     * them, which is the difference between correct pacing and silent loss. */
    io.log(`  ${receipted}/${target.parts.length} lines echoed back ` +
           `(diagnostic — the +QFUPL checksum is the verdict)`, 'note');
    return { got: parseQfupl(collected), gone: false };
}

/*
 * Replace one file and accept only an exact size AND checksum match. A
 * matching size proves nothing on its own — a corrupted stream of the right
 * length is exactly the failure this gate exists for.
 */
/* One wording for the one thing the operator has to do about it. The failure is
 * the window, not the certificate — so it must not read like a bad bundle. */
const modemGoneMessage = target =>
    `${target.bg95Name}: the firmware powered the NB module off before the ` +
    `write finished. This is the window ending, not a problem with the ` +
    `certificate — wake the unit and run ② again on a fresh cycle.`;

async function writeTarget(io, target, retries = 3) {
    const want = { size: target.declaredSize, checksum: target.expectedChecksum };

    if (target.secret && io.echoOff === false) {
        throw new Error(
            'BG95 echo could not be turned off — refusing to stream the ' +
            'private key into a console that echoes it back onto this screen');
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        io.log(`${target.label} → ${target.bg95Name} ` +
               `(attempt ${attempt}/${retries}, size=${want.size}, ` +
               `checksum=${hex4(want.checksum)})`, 'note');

        /* QFDEL returning ERROR when the file is absent is expected and
         * allowed; the upload still starts from a clean slot. */
        await at(io, `AT+QFDEL="${target.bg95Name}"`, 2000);

        /*
         * The third argument is how long the modem will sit in data mode
         * waiting for the rest of the file, and it is 60 because that is what
         * the run that WORKED used.
         *
         * `cli/logs/2026-07-12_20-36-00_daemon/raw.log` is the only recorded
         * success on this device — BLE, this certificate, `+QFUPL: 1208,5769`
         * confirmed by `+QFLST: "cacert.pem",1208` — and it opened with:
         *
         *     AT+QFUPL="cacert.pem",1208,60
         *
         * This had been lowered to 20 to stop a finished upload from eating the
         * commands sent after it. That reasoning was sound and the number was
         * not: at 1.5 s a line the stream runs 34 s, so the modem was abandoning
         * the transfer before it ended and every byte after the cutoff went
         * nowhere. Matching the proven value removes one more difference
         * between the run that worked and the runs that do not.
         *
         * No ackmode. The `,1` of v0.38.0 never yielded a single `A` through
         * the console, and the proven run did not use it — the flow control
         * here is the echo receipt, per streamParts.
         */
        const opened = await at(
            io, `AT+QFUPL="${target.bg95Name}",${want.size},60`, 3000);

        if (opened.some(l => MODEM_GONE_RE.test(l))) {
            throw new Error(modemGoneMessage(target));
        }

        if (!opened.some(l => l.includes('CONNECT'))) {
            io.log('  QFUPL did not return CONNECT', 'fail');
        } else {
            const { got, gone } = await streamParts(io, target);
            if (gone) throw new Error(modemGoneMessage(target));

            if (got && got.size === want.size && got.checksum === want.checksum) {
                io.log(`  VERIFIED +QFUPL: ${got.size},${hex4(got.checksum)}`, 'ok');
                /* The verdict itself, not a boolean about it. It is the only
                 * evidence in this path the modem computed rather than we did,
                 * so it is what the caller records. */
                return got;
            }
            if (!got) {
                io.log('  no +QFUPL result received', 'fail');
                /* A modem that has been powered off cannot be retried into.
                 * Two further attempts against it is how one lost window
                 * became one lost window plus four minutes. */
                if (await explainSilence(io, target, want) === 'gone') {
                    throw new Error(modemGoneMessage(target));
                }
            }
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
 *
 * `onProgress(done, total, proof)` fires after each verified file, where
 * `proof` is `{ label, name, size, checksum }` — the modem's own `+QFUPL`
 * verdict for that file, carried out so the caller can record it rather than
 * re-derive it. A count says a file passed; the checksum says which bytes.
 */
export async function writeCerts(io, bundle, onProgress = () => {}) {
    const targets = buildTargets(bundle);

    /*
     * Check the parts against the firmware's own law before spending a single
     * second of window on them.
     *
     * This gate is here because the bug it catches is invisible from the
     * device end: a part with the wrong terminator uploads, the modem stores
     * something, and the run fails as silence twenty lines later — which reads
     * like line loss, and was read like line loss for two weeks. The law
     * (`console-line-law.js`, disassembled from the app) can say it in
     * microseconds, on a laptop, with no unit connected.
     *
     * It refuses rather than warns. A part that the app intercepts or truncates
     * cannot produce a correct file, so continuing only buys a more confusing
     * failure later.
     */
    const issues = targets.flatMap(t => checkParts(t.parts)
        .map(issue => `${t.label}: ${issue}`));
    if (issues.length) {
        for (const issue of issues.slice(0, 5)) io.log(`  ${issue}`, 'fail');
        throw new Error(
            `${issues.length} part(s) violate the console line law and would ` +
            `not land verbatim — refusing to write. See console-line-law.js.`);
    }

    let exited = false;
    await enterCertmod(io);
    try {
        for (let i = 0; i < targets.length; i++) {
            /*
             * Silence the echo for the key, and only for the key.
             *
             * The confidentiality rule has not moved: nothing secret may cross
             * a console that repeats it onto a phone screen. What moved is
             * WHEN, because the echo turned out to be load-bearing for the
             * transfer itself — see the note in `enterCertmod`. Public
             * material therefore rides with the echo on, which is the only
             * condition under which a certificate has ever been observed to
             * land complete, and the modem is silenced here, immediately
             * before the one file that cannot be shown.
             *
             * If the key then fails to transfer where the public files
             * succeeded, that is not a regression to debug away — it is the
             * hypothesis confirming itself, and it says the key needs a path
             * that does not lean on the echo.
             */
            if (targets[i].secret && io.echoOff !== true) {
                io.echoOff = await silenceEcho(io);
            }
            const proof = await writeTarget(io, targets[i]);
            onProgress(i + 1, targets.length, {
                label: targets[i].label,
                name: targets[i].bg95Name,
                size: proof.size,
                checksum: hex4(proof.checksum),
            });
        }
        await listFiles(io);
    } finally {
        /* Hand the radio back before leaving, so a unit that fails here is not
         * also left in airplane mode. Cheap, and it runs on the failure path
         * precisely because that is where it would otherwise be forgotten. */
        try { await radioOn(io); } catch { /* the exit matters more */ }
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
