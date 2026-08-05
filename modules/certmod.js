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

/*
 * What goes on the wire: one part per PEM line, terminated by CRLF.
 *
 * The reference writer sends a bare CR because the app it talks to truncates
 * each console line at its first CR/LF and appends CRLF itself — so what the
 * modem stores is `line + CRLF` either way, and a full CRLF risks the trailing
 * LF draining as a second, empty line.
 *
 * This unit does not do that. Measured on 2026-08-05 with a one-line probe
 * declaring its exact wire count: `+QFUPL: 28,6c53`, which is the checksum of
 * `-----BEGIN CERTIFICATE-----` plus a bare CR — the terminator arrived
 * untouched and nothing was appended. Every size this file declared was
 * therefore one byte per line too large, 20 of them for the CA, and the modem
 * sat waiting for bytes that were never coming. That is the whole of the
 * silence: no `+QFUPL`, no stored file, and every retry talking into an upload
 * that was still open.
 *
 * Sending CRLF makes the stored content the canonical bytes again, so the
 * declared size and the checksum stay exactly what the proven USB run
 * produced — `+QFUPL: 1208,5769` remains the acceptance test rather than
 * becoming a second convention to keep straight.
 */
export function wireParts(pemText) {
    const enc = new TextEncoder();
    return pemLines(pemText).map(l => enc.encode(l + '\r\n'));
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
        io.echoOff = await silenceEcho(io);
        if (!io.echoOff) {
            io.log('echo is STILL ON — public material may be written, the ' +
                   'private key will not be', 'fail');
        }
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

    if (!found && !answered) {
        /* Nothing came back at all, which is not the same as the file being
         * absent — and reading it that way on 2026-08-05 produced a confident
         * "bytes were lost on the way in" about a modem that had been powered
         * off eleven seconds earlier. A question nobody was awake to hear
         * proves nothing. */
        io.log('  QFLST got no answer either — the modem is gone, so this run ' +
               'cannot say whether the transfer completed', 'note');
        return;
    }
    if (!found) {
        io.log('  QFLST finds no such file — the modem never completed the ' +
               'transfer, so bytes were lost on the way in', 'fail');
        return;
    }
    const size = parseInt(found[2], 10);
    if (size === want.size) {
        io.log(`  QFLST says the file IS there at ${size}B — the transfer ` +
               `landed and it was the +QFUPL answer that was lost coming back`,
               'ok');
    } else {
        io.log(`  QFLST says ${size}B of ${want.size}B — the modem is genuinely ` +
               `short by ${want.size - size}`, 'fail');
    }
}

/*
 * Ask the modem how it counts what we send it.
 *
 * The write has been failing with silence, and silence has exactly one
 * meaning: the modem has not yet received the byte count it was promised, so
 * it is still waiting. What it cannot tell us is WHY — twenty bytes short
 * because the firmware did not append the LF it is supposed to append, or
 * short by an arbitrary amount because the link dropped some.
 *
 * This settles it in about two seconds. Three PEM lines are sent under a
 * throwaway name, declaring the size they occupy ON THE WIRE — a count the
 * modem reaches whether or not anything is added on the way, so it always
 * answers. The checksum in that answer says which content actually arrived:
 *
 *   checksum(wire)             the firmware forwards the bare CR untouched
 *   checksum(canonical[0..n])  the firmware appends LF, as it is documented to
 *   neither                    bytes were lost, and this is a link problem
 *
 * `cacert.pem` is never touched by any of it.
 */
const PROBE_NAME = 'wpprobe.txt';

function concatBytes(chunks) {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

async function probeByteAccounting(io, target) {
    /*
     * ONE line, and nothing sent afterwards until it answers.
     *
     * The three-line probe did answer on 2026-08-05 — `+QFUPL: 158,7a65` —
     * which settles that raw data reaches the modem and that an upload over
     * BLE can complete. Two things about that answer make it useless as a
     * measurement, and both are fixed here.
     *
     * It arrived about ten seconds after the last part, by which time four
     * more commands had been sent; anything still owed to the upload would
     * have been taken from them, so the stored content cannot be attributed.
     * And `7a65` matches nothing — not the wire bytes, not the canonical
     * bytes, no window of the certificate, no subset of its lines, and no
     * combination with the commands that followed.
     *
     * Guessing the content from outside has been tried and did not converge.
     * One line, its exact wire count declared, silence afterwards, and a
     * window long enough for a late answer makes the result attributable to
     * exactly one transmission — which is what bisecting needs.
     */
    const parts = target.parts.slice(0, 1);
    const wire = concatBytes(parts);
    const canonical = concatBytes(
        parts.map(p => concatBytes([p, new Uint8Array([0x0A])])));
    const declared = wire.length;

    io.log(`byte-accounting probe: ${parts.length} line(s), declaring the wire ` +
           `count ${declared}`, 'note');

    await at(io, `AT+QFDEL="${PROBE_NAME}"`, 2000);
    const opened = await at(io, `AT+QFUPL="${PROBE_NAME}",${declared},10`, 3000);
    if (!opened.some(l => l.includes('CONNECT'))) {
        io.log('  probe could not open an upload — inconclusive', 'fail');
        return;
    }

    let collected = [];
    for (let i = 0; i < parts.length; i++) {
        const final = i === parts.length - 1;
        io.log(`[probe line ${i + 1}/${parts.length}]`, 'tx');
        /* Nothing is sent after the last part until the modem answers or the
         * ceiling expires. On 2026-08-05 the eight-second version gave up nine
         * seconds early, and the commands sent in that gap went into the open
         * upload as file content — which is why its checksum matched nothing. */
        const replies = final ? reply(io, QFUPL_RE, 40000) : io.listen(60);
        await io.sendRaw(parts[i]);
        collected = collected.concat(await replies);
        if (!final) await pause(io, partDelayMs(parts[i].length, io.floorMs));
    }

    const got = parseQfupl(collected);
    if (!got) {
        io.log('  VERDICT: even three lines did not arrive complete — the link ' +
               'is losing bytes, not the byte accounting', 'fail');
    } else if (got.checksum === qfuplChecksum(wire)) {
        io.log('  VERDICT: the firmware forwards the bare CR untouched — every ' +
               'declared size is one byte per line too large', 'fail');
    } else if (got.checksum === qfuplChecksum(canonical.slice(0, declared))) {
        io.log('  VERDICT: the firmware appends LF as documented — the byte ' +
               'accounting is right and the loss is elsewhere', 'ok');
    } else {
        io.log(`  VERDICT: arrived complete but as neither candidate ` +
               `(+QFUPL: ${got.size},${hex4(got.checksum)}) — content is being ` +
               `altered in transit`, 'fail');
    }

    await at(io, `AT+QFDEL="${PROBE_NAME}"`, 2000);
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
        /* The modem answers the moment it has the byte count it was promised,
         * so the last part waits for that answer rather than for a fixed
         * fifteen seconds. Every successful file used to spend those seconds
         * after it had already succeeded — the cost of the second and third
         * file being written in a window that had already been spent. */
        const replies = final
            ? reply(io, QFUPL_RE, 40000)
            : io.listen(60);
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
         * waiting for the rest of the file. The reference uses 100 s, which
         * over USB is never reached; over BLE a short transfer leaves the
         * modem consuming everything sent afterwards — on 2026-08-04 the two
         * retries never saw `CONNECT` because their commands were being eaten
         * as file content. 20 s is comfortably past a complete transfer and
         * gives the rest of the window back when one is not.
         */
        const opened = await at(
            io, `AT+QFUPL="${target.bg95Name}",${want.size},20`, 3000);

        if (!opened.some(l => l.includes('CONNECT'))) {
            io.log('  QFUPL did not return CONNECT', 'fail');
        } else {
            const got = await streamParts(io, target);
            if (got && got.size === want.size && got.checksum === want.checksum) {
                io.log(`  VERIFIED +QFUPL: ${got.size},${hex4(got.checksum)}`, 'ok');
                return true;
            }
            if (!got) {
                io.log('  no +QFUPL result received', 'fail');
                await explainSilence(io, target, want);
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
 * `onProgress(done, total)` fires after each verified file.
 */
export async function writeCerts(io, bundle, onProgress = () => {}) {
    const targets = buildTargets(bundle);
    let exited = false;
    await enterCertmod(io);
    try {
        /* Opt-in, because it spends window on a question rather than on the
         * write. Reach for it when a file comes back silent — `?probe=1`. */
        if (io.probe) await probeByteAccounting(io, targets[0]);
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
