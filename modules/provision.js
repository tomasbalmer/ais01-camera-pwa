/*
 * Provisioning mode — Dragino v1.3 over BLE, timed by the technician.
 *
 * Spec: specs/004-ble-provisioning-mode.md. Read it before changing behaviour
 * here; the omissions are decisions, not gaps.
 *
 * The rule that shapes this whole file: **the app never infers device phase.**
 * It shows the stream, and the technician decides when to act. Buttons report
 * what the command *they* sent came back with — that is confirmation — but no
 * button is ever disabled because the code believes the AT window is shut.
 *
 * Separately from the device, the app does enforce one thing: the loaded bundle
 * must belong to the unit on the other end of the link. That check is not about
 * timing, it is about writing unit A's identity into unit B — silent, and only
 * visible weeks later in the field.
 */

import {
    hasBluetooth, connect, adopt, reconnect, isConnected, deviceName,
    sendLine, sendRaw, disconnect,
} from './ble-transport.js';
import { writeCerts } from './certmod.js';
import { VERSION, VERSION_NOTE } from './version.js';

/*
 * Every device call goes through this one object so `?mock` can replace the
 * device without the stages knowing. The stages are the thing worth testing;
 * they must not contain a branch for being tested.
 */
const link = {
    connect, adopt, reconnect, isConnected, deviceName, sendLine, sendRaw,
    disconnect,
};

/* Everything below is app state. None of it describes the device. */
const state = {
    bundle: null,
    /* One pin per pane. They are both on screen now, so scrolling back through
     * the raw stream to check a line must not stop the annotated one from
     * following the device. */
    pinned: { annotated: true, raw: true },
    pendingDeltas: null, /* config deltas awaiting a confirming second tap */
    redacting: false,  /* key material may be on the wire — see redact() */
    busy: false,       /* a stage's own loop is running */
    verifying: null,   /* ④ is watching the stream — {stop} while armed */
    mock: false,       /* ?mock — simulated device, no radio */
};

/*
 * Defence in depth for the one screen that shows everything.
 *
 * `ATE0` is the real protection and certmod.js refuses to stream without it,
 * but this terminal is on a phone — photographed, mirrored, looked over. A
 * long unbroken base64 run is PEM body and cannot be a Dragino message, so
 * while key material is in flight those lines are replaced rather than shown.
 * Everything else still comes through: this must never hide an error.
 */
function isPemBody(line) {
    const body = line.trim();
    return body.length >= 60 && /^[A-Za-z0-9+/=]+$/.test(body);
}

function redact(line) {
    if (!state.redacting) return line;
    return isPemBody(line) ? '[redacted PEM body]' : line;
}

const el = id => document.getElementById(id);

/* ── The raw log ─────────────────────────────────────────────────────────
 *
 * The CLI harness this replaces keeps a raw.log, and every claim about what a
 * device did is settled by reading it — never by reading a rendered view. The
 * annotated terminal below adds timestamps, prefixes and a redaction filter,
 * drops blank lines and holds partial fragments until a newline arrives. All of
 * that is useful and none of it is evidence.
 *
 * So the bytes are kept separately, exactly as they arrived, and shown beside
 * the annotated view rather than instead of it — the split the CLI dashboard
 * uses, for the same reason: the reading is what you act on, the raw stream is
 * what settles an argument about it, and you should not have to choose.
 *
 * One asymmetry, on purpose: RX is verbatim, TX is not. What we sent we already
 * know, and reproducing the PEM bytes would put a private key on the screen and
 * into the clipboard of a log meant to be shared. Evidence is what the device
 * said back.
 *
 * That asymmetry had a hole in it, and it was the whole point of keeping TX out.
 * The console echoes our lines back, so the key we refused to write as TX
 * arrived a second later as RX and was written verbatim — into the one buffer
 * `copyRawLog` hands to the share sheet. `ATE0` does not close it: that silences
 * the BG95, while the echo comes from the STM32 console in front of it, which is
 * the same echo the N/19 counter reads to tell whether the pacing is right.
 *
 * So while key material is in flight the RX stream is filtered too, by the one
 * rule that cannot match a Dragino message: a long unbroken base64 run is PEM
 * body. Commands, `+QFUPL` verdicts and errors are none of those things and go
 * through untouched — the log must still be able to explain a failure.
 */
const RAW_CAP = 1_000_000;   /* characters; a bench session is long */
let rawLog = '';

/*
 * The redaction filter is per line, and a notification boundary is not a line
 * boundary, so an unterminated tail waits here until its terminator arrives. It
 * only ever holds part of one line, and only while `state.redacting` is on.
 */
let rawCarry = '';

/*
 * Split after every CR or LF, keeping the terminator on the line it ends.
 *
 * Bare CR counts, for the reason `ble-transport.js` gives: the console returns
 * our upload parts terminated the way we sent them, CR and no LF. Splitting on
 * LF alone would leave a whole certificate sitting in one unterminated line —
 * never filtered, and eventually flushed.
 *
 * Written as a scan rather than a lookbehind regex, which iOS WebKit only
 * learned recently and this app has to run there.
 */
function splitTerminated(s) {
    const lines = [];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\n' || s[i] === '\r') {
            lines.push(s.slice(start, i + 1));
            start = i + 1;
        }
    }
    return [lines, s.slice(start)];
}

/* Filter the RX stream without disturbing its shape: same line count, same
 * terminators, only PEM bodies swapped for a label. */
function redactRaw(text) {
    rawCarry += text;
    const [lines, tail] = splitTerminated(rawCarry);
    /* A tail with no terminator in sight is not a line waiting to be completed,
     * it is a stream that has stopped giving us one. Filter it and let it go
     * rather than holding key material in a buffer indefinitely. */
    if (tail.length > 4096) {
        lines.push(tail);
        rawCarry = '';
    } else {
        rawCarry = tail;
    }
    return lines.map(line => {
        const end = line.length - line.replace(/[\r\n]+$/, '').length;
        const body = end ? line.slice(0, -end) : line;
        return isPemBody(body)
            ? '[redacted PEM body]' + line.slice(body.length)
            : line;
    }).join('');
}

/* Give back whatever the filter is still holding, before redaction is lifted —
 * afterwards it would go out verbatim, which is the bug this closes. */
function flushRaw() {
    if (!rawCarry) return;
    const held = rawCarry;
    rawCarry = '';
    rawAppend(isPemBody(held) ? '[redacted PEM body]' : held);
}

function rawAppend(text, dir) {
    /* Only the payload is a secret. Redacting the commands too hid `AT+CERTMOD`
     * behind "[PEM part redacted]" in the one artefact meant to explain a
     * failure — the raw log stopped being able to answer what we had sent. */
    if (dir === 'tx-raw') {
        text = '\n[tx: PEM part redacted]\n';
    } else if (dir === 'tx-line') {
        text = `\n>>> ${text}`;
    } else if (state.redacting) {
        text = redactRaw(text);
        if (!text) return;   /* all of it is still an incomplete line */
    }
    rawLog += text;
    if (rawLog.length > RAW_CAP) rawLog = rawLog.slice(-RAW_CAP);
    renderRaw();
}

/*
 * The raw pane is on screen at all times now, so it is painted at all times —
 * and painting it is assigning up to a megabyte of text to one element.
 *
 * A boot delivers that in a burst of small chunks, so the work is coalesced to
 * one paint per frame: the buffer is already complete in memory when the frame
 * runs, and nobody can read faster than the screen refreshes anyway. Without
 * this the cost is per chunk, which is per BLE notification.
 */
let rawPaint = 0;
function renderRaw() {
    if (rawPaint) return;
    rawPaint = requestAnimationFrame(() => {
        rawPaint = 0;
        const out = el('terminal-raw');
        out.textContent = rawLog || '(nothing received yet)';
        if (state.pinned.raw) tail(out);
    });
}

function tail(out) { out.scrollTop = out.scrollHeight; }

/*
 * Restart the unit from here instead of from the board.
 *
 * `ATZ` is one of the commands the app answers itself rather than forwarding
 * to the modem, so it reboots the STM32 — the same thing the button does, and
 * the same thing this app already sends after a successful certificate write.
 *
 * It is not a convenience. Every attempt at a cert write costs a fresh AT
 * window, the window opens 16 s after a boot, and until now every one of those
 * boots needed a hand on the hardware. With the link re-attaching by itself,
 * this closes the loop: reset, wait, log in, write — none of it requiring the
 * unit to be within reach.
 */
async function doReset() {
    if (!link.isConnected()) { fail('not connected'); return; }
    write('ATZ', 'tx');
    await link.sendLine('ATZ');
    note('restarting — the link will drop and come back on its own');
    note('the AT window opens about 16 s after the boot banner');
}

/*
 * One command, typed.
 *
 * The four stages are canned sequences, which is what provisioning wants and
 * exactly wrong the moment a unit needs a command nobody scripted. On
 * 2026-08-06 that command was `AT+CSQTIME=1` — the search window that decides
 * how long the firmware hunts for a network before it powers the modem down,
 * and therefore how long a bench session waits for the idle state a
 * certificate write requires. Without this row the only way to change it was
 * the USB cable and the CLI: unplug the transport under test to alter a
 * setting on it.
 *
 * It goes out through the same `sendLine` as every other command, so the
 * console line law (bare CR, no LF) is obeyed here for free, and the reply
 * arrives in the same terminal as everything else rather than in a private
 * result box. Whatever is typed is sent as typed — this is a console, not a
 * form, and guessing at what the operator meant is how a console stops being
 * one.
 */
async function sendManual() {
    const input = el('at-input');
    const text = input.value.trim();
    if (!text) return;
    if (!link.isConnected()) { fail('not connected'); return; }

    write(text, 'tx');
    /* Registered before the send: a fast device can answer inside the same
     * batch, and a collector that starts afterwards is a collector that has
     * already missed it. */
    const replies = listen(3000);
    try {
        await link.sendLine(text);
    } catch (err) {
        fail(`send failed: ${err.message}`);
        return;
    }
    const seen = await replies;
    if (!seen.length) {
        note('no answer — the console is locked until the password lands, ' +
             'and the window is closed once the modem powers off');
    }
    input.select();
}

async function copyRawLog() {
    const text = rawLog || '(empty)';
    try {
        if (navigator.share) {
            await navigator.share({ title: 'AIS01 provisioning log', text });
        } else {
            await navigator.clipboard.writeText(text);
            note(`raw log copied (${text.length} chars)`);
        }
    } catch (err) {
        if (err && err.name === 'AbortError') return;   /* share sheet dismissed */
        fail(`could not copy: ${err.message}`);
    }
}

/* ── Terminal ────────────────────────────────────────────────────────── */

function stamp() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map(n => String(n).padStart(2, '0')).join(':');
}

/*
 * One stream for both directions. Two panes would force the operator to
 * correlate what they sent with what came back by timestamp, which is exactly
 * the work this design moved off them.
 */
function write(text, kind = 'rx') {
    const out = el('terminal');
    const line = document.createElement('div');
    line.className = `line line-${kind}`;
    line.textContent = `${stamp()} ${kind === 'tx' ? '> ' : ''}${text}`;
    out.appendChild(line);

    /* Bounded: a bench session runs for hours across many boots. */
    while (out.childElementCount > 2000) out.removeChild(out.firstChild);

    if (state.pinned.annotated) tail(out);
}

function note(text) { write(text, 'note'); }
function fail(text) { write(text, 'fail'); }
function ok(text) { write(text, 'ok'); }

/* ── Confirmation ────────────────────────────────────────────────────────
 *
 * Reading the reply to a command this app just sent is confirmation, and it is
 * the one thing the code must keep doing — it is not the phase inference the
 * spec rules out. The difference is the question being asked: "what did my
 * command come back with" versus "what do I think the device is doing now".
 */

const collectors = new Set();

function feed(line) {
    for (const c of collectors) {
        c.lines.push(line);
        /* A collector that reports as it goes rather than at the end. Nothing
         * else about a collector changes: it still ends on `test`, or on its
         * own timeout, or never. */
        if (c.each) c.each(line);
        /* An expected marker ends the wait immediately. A fixed window has to be
         * long enough for the slowest case and is then that long for every case
         * — which is how a two-second budget met a marker that arrived in four. */
        if (c.test && c.test.test(line)) {
            collectors.delete(c);
            c.done(c.lines);
        }
    }
}

/* Collect everything the device says for `ms`, then resolve with the lines. */
function listen(ms) {
    const c = { lines: [] };
    collectors.add(c);
    return new Promise(resolve => setTimeout(() => {
        collectors.delete(c);
        resolve(c.lines);
    }, ms));
}

/* Same, but resolve as soon as `pattern` appears. `ms` becomes a ceiling rather
 * than a duration, so a generous budget costs nothing when the device is
 * prompt. */
function until(pattern, ms) {
    return new Promise(resolve => {
        const c = { lines: [], test: pattern, done: resolve };
        collectors.add(c);
        setTimeout(() => { collectors.delete(c); resolve(c.lines); }, ms);
    });
}

/*
 * The per-stage mark. Its wording is deliberately uneven across stages: only
 * ② and ④ carry evidence strong enough to be called proof — a checksum the
 * modem computed over what it stored, and a CONNACK from AWS IoT, which is only
 * issued to a certificate that is registered, active, attached to a policy and
 * matched by its key. ① and ③ get an amber mark that says what was observed and
 * nothing more, because a green tick on "OK was returned" would be a claim this
 * app cannot support.
 */
function setMark(stage, text, kind = 'weak') {
    const mark = el(`mark-${stage}`);
    mark.textContent = text;
    mark.className = `mark mark-${kind}`;
}

/* The bar says the link with a colour, the way the calibration bar does. The
 * words for it are in the log, where the reason lives too. */
function setLink(status, detail) {
    const dot = el('link-state');
    dot.className = `dot link-${status}`;
    dot.title = `BLE ${status}`;
    if (detail) note(`link ${status}${detail ? ' — ' + detail : ''}`);
}

/* ── Bundle ──────────────────────────────────────────────────────────── */

const REQUIRED = ['imei', 'thing_name', 'password', 'certificate', 'private_key'];

function parseBundle(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        throw new Error(`not valid JSON — ${err.message}`);
    }
    const missing = REQUIRED.filter(k => !data[k]);
    if (missing.length) throw new Error(`missing field(s): ${missing.join(', ')}`);
    return data;
}

/*
 * The one guard worth having. The BT24 advertises under the unit's IMEI, so a
 * bundle for another unit is detectable before a single byte is written.
 * Returns an explanation when they disagree, null when they match or when the
 * link is not up yet (nothing to compare against).
 */
function imeiMismatch(bundle) {
    const advertised = link.deviceName();
    if (!advertised || !bundle) return null;

    /* No IMEI in the selection means the browser handed over loose files rather
     * than a folder. There is nothing to compare, so there is no mismatch —
     * claiming one would refuse a correct unit, which is the exact opposite of
     * this guard's job. The absence is already reported once, at load. */
    if (!bundle.imei) return null;

    if (advertised.includes(bundle.imei)) return null;
    return `bundle is for ${bundle.imei}, connected unit advertises "${advertised}"`;
}

/*
 * What AWS hands you when you create a thing is a folder, so that is what this
 * reads. Nothing is prepared, converted or transferred first: the technician
 * picks the folder and the app does the grouping.
 *
 * Files are identified by the names AWS gives them, not by order or position:
 *
 *   *-certificate.pem.crt   the client certificate
 *   *-private.pem.key       the private key
 *   password.txt            the device PIN (added by us, not by AWS)
 *   AmazonRootCA*.pem       ignored — public, identical everywhere, in the app
 *   *-public.pem.key        ignored — the modem never sees it
 *
 * The IMEI comes from the folder name, which is the only place it exists: a
 * PEM carries no identity. When the browser gives a folder (webkitRelativePath),
 * that check is available; when it can only give loose files, it is not, and
 * the app says so rather than pretending.
 */
const FILE_ROLES = [
    ['certificate', /-certificate\.pem\.crt$/i],
    ['private_key', /-private\.pem\.key$/i],
    ['password',    /^password\.txt$/i],
];

async function loadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    /*
     * The prepared bundle, and on a phone the only sensible choice.
     *
     * The picker cannot ask Drive for a folder — cloud providers expose files
     * — so the directory name that carries the IMEI never arrives, and with it
     * goes the check that this material belongs to this unit. One
     * `AIS01-CB-<IMEI>.json` from `ais01 certs bundle` puts the IMEI back
     * INSIDE the artefact, where a file pick cannot lose it.
     */
    const json = files.find(f => /\.json$/i.test(f.name));
    if (json && files.length === 1) return loadBundleJson(json);

    const found = {};
    for (const [role, pattern] of FILE_ROLES) {
        const hit = files.find(f => pattern.test(f.name));
        if (hit) found[role] = hit;
    }

    const missing = FILE_ROLES.map(([r]) => r).filter(r => !found[r]);
    if (missing.length) {
        state.bundle = null;
        el('imei').textContent = '—';
        fail(`missing from the selection: ${missing.join(', ')}`);
        note(`picked ${files.length} file(s): ${files.map(f => f.name).join(', ')}`);
        note('Pick AIS01-CB-<IMEI>.json, or all three files including');
        note('password.txt.');
        return;
    }

    /* A folder pick preserves the directory name and a file pick does not, so
     * this path has an IMEI only on a desktop browser that still offers one.
     * The warning below is not boilerplate: it is the difference between a
     * checked write and an unchecked one. */
    const relative = found.certificate.webkitRelativePath || '';
    const imei = (relative.match(/(\d{15})/) || [])[1] || null;

    const bundle = {
        imei,
        thing_name: imei ? `AIS01-CB-${imei}` : null,
        password: (await found.password.text()).split(/\r?\n/)[0].trim(),
        certificate: await found.certificate.text(),
        private_key: await found.private_key.text(),
        mqtt: {},
    };

    if (!bundle.password) { fail('password.txt is empty'); return; }

    state.bundle = bundle;
    rememberBundle(bundle, relative ? relative.split('/')[0] : 'loose files');
    el('imei').textContent = imei || '(unknown)';
    ok(`loaded ${relative ? relative.split('/')[0] : files.length + ' files'}`);
    note(`  certificate ${bundle.certificate.length}B · key ${bundle.private_key.length}B`);

    if (!imei) {
        note('No IMEI in the selection — pick the folder, not the files, to');
        note('enable the wrong-unit check. Writing is still allowed.');
    } else {
        const problem = imeiMismatch(bundle);
        if (problem) fail(`WRONG UNIT — ${problem}`);
    }
}

/* ── Remembering the unit's material ─────────────────────────────────────
 *
 * A bench session is one unit and many attempts, and each attempt has been
 * costing a trip through the file picker for the same folder. So the last
 * bundle is kept and restored on load.
 *
 * It is kept HERE, in this browser, and not in the app's source. The bundle
 * carries the unit's private key and console password, and this app is served
 * from a public repository — anything committed to it is published. Storage on
 * the machine doing the provisioning is a different risk from storage on the
 * open internet, and only one of them is acceptable.
 *
 * `FORGET` is on the load control for when the bench moves to another unit,
 * because material that outlives its purpose is the other half of the same
 * problem.
 */
const REMEMBERED = 'ais01.provision.bundle';

function rememberBundle(bundle, label) {
    try {
        localStorage.setItem(REMEMBERED, JSON.stringify({ bundle, label }));
    } catch {
        note('could not remember this bundle — it will need reloading');
    }
}

function forgetBundle() {
    try { localStorage.removeItem(REMEMBERED); } catch { /* nothing to undo */ }
    state.bundle = null;
    el('imei').textContent = '—';
    note('bundle forgotten — load the next unit\'s material');
}

function restoreBundle() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(REMEMBERED) || 'null'); }
    catch { return; }
    if (!saved || !saved.bundle) return;

    state.bundle = saved.bundle;
    el('imei').textContent = saved.bundle.imei || '(unknown)';
    ok(`remembered ${saved.label} — stored in this browser, not in the app`);
    note('  tap FORGET before provisioning a different unit');
}

async function loadBundleJson(file) {
    try {
        const bundle = parseBundle(await file.text());
        state.bundle = bundle;
        rememberBundle(bundle, file.name);
        el('imei').textContent = bundle.imei;
        ok(`bundle loaded: ${file.name}`);
        const problem = imeiMismatch(bundle);
        if (problem) fail(`WRONG UNIT — ${problem}`);
    } catch (err) {
        state.bundle = null;
        el('imei').textContent = '—';
        fail(`bundle rejected: ${err.message}`);
    }
}

/* Refuse to write anything without a bundle that matches this unit. */
function bundleReady() {
    if (!state.bundle) { fail('no bundle loaded'); return false; }
    if (!link.isConnected()) { fail('not connected'); return false; }
    const problem = imeiMismatch(state.bundle);
    if (problem) { fail(`refusing to write — ${problem}`); return false; }
    return true;
}

/* ── Actions ─────────────────────────────────────────────────────────── */

async function doConnect() {
    if (!state.mock && !hasBluetooth()) {
        fail('This browser has no Web Bluetooth. On iOS use Bluefy.');
        return;
    }
    if (link.isConnected()) { await link.disconnect(); setLink('disconnected'); return; }

    try {
        /* Redact for the screen only — the collectors that decide whether a
         * write landed must still see the real bytes. */
        const onLine = line => { write(redact(line)); feed(line); };
        const onChunk = (text, dir) => rawAppend(text, dir);
        const onDiag = text => note(text);
        const handlers = { onLine, onChunk, onDiag, onStatus: setLink };

        /* A unit already granted to this origin needs no picker, and after a
         * reload that is every unit we have been talking to. The bundle's IMEI
         * decides which one, so a bench with several cannot adopt the wrong
         * one; with no bundle it only adopts when there is a single choice. */
        let name = null;
        try {
            name = await link.adopt(
                handlers, state.bundle ? state.bundle.imei : null);
            if (name) note(`re-adopted ${name} — no picker`);
        } catch (err) {
            /* Every failure here falls through to the picker, which is what
             * this button did before adoption existed. A shortcut that can turn
             * into a dead end is worse than no shortcut: this one can only save
             * a tap or cost nothing. */
            note(`adoption failed (${err.message}) — falling back to the picker`);
        }
        if (!name) name = await link.connect(handlers);

        if (name === null) { note('scan dismissed'); return; }
        note(`paired with ${name}`);
        if (state.bundle) {
            const problem = imeiMismatch(state.bundle);
            if (problem) fail(`WRONG UNIT — ${problem}`);
        }
    } catch (err) {
        fail(`connect failed: ${err.message}`);
    }
}

async function doLogin() {
    if (!state.bundle) { fail('no bundle loaded — the password is in it'); return; }
    if (!link.isConnected()) {
        /* An idle drop is normal on BT24; try the same device before giving up. */
        try { await link.reconnect(); } catch (err) {
            fail(`not connected: ${err.message}`); return;
        }
    }
    write('••••••  (password)', 'tx');
    setMark('login', 'sending', 'run');
    const replies = listen(3000);
    await link.sendLine(state.bundle.password);

    const lines = await replies;
    return judgeLogin(lines);
}

/*
 * The device does answer positively: `Password Correct`. The reference writer
 * treats anything else as a refusal to send certificates at all
 * (certs.py `_login`), and so does this — a cert stream into an unauthenticated
 * console writes nowhere while looking like it worked.
 *
 * Returns true only on the confirmed positive.
 */
function judgeLogin(lines) {
    const joined = lines.join('\n');

    if (/password\s+correct/i.test(joined)) {
        setMark('login', 'correct', 'ok');
        ok('Password Correct — logged in.');
        return true;
    }
    if (/password\s+incorrect/i.test(joined)) {
        setMark('login', 'refused', 'fail');
        fail('Password Incorrect.');
        note('Sent before the window opens, this means too soon rather than');
        note('wrong. After "NBIOT has responded." it means the password.');
        return false;
    }
    if (/password\s+timeout/i.test(joined)) {
        setMark('login', 'expired', 'fail');
        fail('Password timeout — the session expired (~50 s idle). Log in again.');
        return false;
    }
    /* Silence is not consent. It usually means the console never received the
     * line at all, which is a transport answer, not a credential one. */
    setMark('login', 'no answer', 'fail');
    fail('No reply to the password — the console did not answer.');
    note('Nothing was authenticated, so nothing else should be sent yet.');
    return false;
}

/*
 * ② does NOT log in, and does not check whether ① did.
 *
 * A stage that requires a session would also have to know whether that session
 * is still valid — it expires after ~50 s idle and after any reboot, neither of
 * which this app can observe without inferring device state. That is the thing
 * this design refuses to do.
 *
 * It costs nothing to leave out, because the confirmation already covers it:
 * without a session `AT+CERTMOD` never returns BG95 RDY, and the write stops
 * there with an error that names exactly that. The technician owns the order;
 * the code owns whether each thing landed.
 */

/*
 * `AT+CFG` returns the whole property dump in one command, which is why this
 * never queries settings one at a time. The reply arrives asynchronously and is
 * shown in the terminal — the operator reads it, exactly like everything else.
 */
async function doReadConfig() {
    if (!link.isConnected()) { fail('not connected'); return; }
    write('AT+CFG', 'tx');
    await link.sendLine('AT+CFG');
    note('read the dump above, then tap ③ again to stage the deltas');
}

/*
 * Settings this unit must end up with. Two of them are law: SNI=1 breaks the
 * MQTT CONNECT silently, and MQOS must be 0. They are sent even when the dump
 * already shows them correct — a silent-failure setting is not worth a
 * conditional.
 */
function desiredSettings(bundle) {
    const mqtt = bundle.mqtt || {};
    if (!mqtt.endpoint) throw new Error('bundle has no mqtt.endpoint');
    return [
        ['AT+PRO', '3,5'],
        ['AT+SERVADDR', `${mqtt.endpoint},8883`],
        ['AT+PUBTOPIC', `waterplan/meters/${bundle.imei}/uplink`],
        ['AT+SUBTOPIC', `waterplan/meters/${bundle.imei}/downlink`],
        ['AT+CLIENT', bundle.thing_name],
        ['AT+TLSMOD', '1,2'],
        ['AT+MQOS', '0'],
        ['AT+SNI', '0'],
        ...(mqtt.tdc ? [['AT+TDC', String(mqtt.tdc)]] : []),
        ...(mqtt.endpoint_ip
            ? [['AT+BKDNS', `1,0,${mqtt.endpoint_ip},8883`]] : []),
    ];
}

async function doStageConfig() {
    if (!bundleReady()) return;
    let wanted;
    try { wanted = desiredSettings(state.bundle); } catch (err) {
        fail(err.message); return;
    }
    state.pendingDeltas = wanted.map(([k, v]) => `${k}=${v}`);
    note(`staged ${state.pendingDeltas.length} settings:`);
    state.pendingDeltas.forEach(line => note(`  ${line}`));
    el('btn-config').querySelector('.label').textContent =
        `③ APPLY ${state.pendingDeltas.length}`;
    el('btn-config').classList.add('armed');
    setMark('config', 'staged', 'run');
}

async function doApplyConfig() {
    if (!bundleReady()) return;
    const deltas = state.pendingDeltas || [];
    let accepted = 0;
    setMark('config', `0/${deltas.length}`, 'run');

    for (const [i, cmd] of deltas.entries()) {
        write(cmd, 'tx');
        const replies = listen(350);
        await link.sendLine(cmd);
        /* Paced, not timed: the console is a 9600-baud bridge and swallows a
         * burst. This is not a wait-for-the-window heuristic. */
        const lines = await replies;
        if (lines.some(l => /\bOK\b/.test(l))) accepted++;
        else if (lines.some(l => /ERROR/i.test(l))) fail(`  ${cmd} → ERROR`);
        setMark('config', `${i + 1}/${deltas.length}`, 'run');
    }

    /*
     * Amber even at 9/9. `OK` means the command parsed, not that the setting
     * survives a reboot — the only proof is re-reading AT+CFG after a reset,
     * and this app does not get to claim it on the device's behalf.
     */
    setMark('config', `${accepted}/${deltas.length} OK`,
            accepted === deltas.length ? 'weak' : 'fail');
    note(`${accepted}/${deltas.length} settings returned OK`);
    note('OK is not persisted: verify with AT+CFG after a reset');
    state.pendingDeltas = null;
    el('btn-config').querySelector('.label').textContent = '③ CONFIG';
    el('btn-config').classList.remove('armed');
}

/*
 * The stage that decides whether a phone can replace the laptop at all. One
 * tap runs the whole sequence — enter passthrough, three checksum-gated
 * uploads, exit — and the operator does nothing but watch.
 *
 * Acceptance is not "it finished": it is the CA echoing `+QFUPL: 1208,5769`,
 * the same pair the USB path produced on 2026-07-13. A different checksum
 * means the link lost bytes, not that the certificate is wrong.
 */
async function doCerts() {
    if (!bundleReady()) return;
    if (state.busy) { note('a stage is already running'); return; }

    const io = {
        send: link.sendLine,
        sendRaw: link.sendRaw,
        listen,
        until,
        /*
         * The upload now races something, so it must be short.
         *
         * The firmware never stops talking to the BG95. Every `Signal Strength`
         * line in the log is an `AT+CSQ` it sent itself — visible verbatim on
         * 2026-08-05 at 23:02:46 — and one issued while the modem sits in QFUPL
         * data mode lands INSIDE the file. `AT+QFLST` named the damage exactly:
         *
         *     +QFLST: "cacert.pem",557        <- 29 + 8x66, to the byte
         *
         * Nine whole lines, a clean boundary, and then nothing. That is not
         * lost bytes; it is the transfer being interrupted, about eight seconds
         * in, which is the firmware's polling interval.
         *
         * That reading was wrong, and the next run said so with a number. The
         * delivered count tracks the TIME the stream is given, not its distance
         * from a poll:
         *
         *     600 ms/part, ~17 s of stream   ->  557 B   (29 + 8x66, clean)
         *       0 ms/part,  ~8 s of stream   ->  407 B   (29 + 5x66 + 48, mid-line)
         *
         * Slower delivered more, and the faster run stopped in the middle of a
         * line rather than between two. That is a drain limit somewhere below
         * the wire rate — the firmware's console loop, not a race with AT+CSQ —
         * and the 600 ms pause this replaced was doing real work.
         *
         * Neither reading survived. 1.5 s a line delivered 203 B, the worst of
         * the three, and the log finally showed why the numbers wander: the
         * modem RESTARTS mid-upload, leaving the file truncated wherever the
         * reset caught it. This unit has no antenna, so every transmit is into
         * an open load — see `radioOff` in certmod.js, which is the actual
         * countermeasure.
         *
         * 2500, and this one IS measured rather than matched.
         *
         * With the echo gate removed the whole stream finally ran, three times,
         * and answered identically each time: `+QFUPL: 389,041E`, seven lines
         * echoed out of nineteen. The echoes were not scattered. They were
         * parts 1, 4, 7, 10, 13, 16, 19 — one in three, no exceptions — and the
         * stored size confirms nothing else arrived at all:
         *
         *     line 1   27 + CRLF  =  29
         *     lines 4,7,10,13,16   64 + CRLF, five of them  = 330
         *     line 19  28 + CRLF  =  30
         *                            ---
         *                            389   exactly what the modem reported
         *
         * So the console is not corrupting or truncating: it accepts one line
         * and discards the next two outright, and it does so on a clock. At
         * ~700 ms a line that puts its acceptance period at about 2.1 s, which
         * is the number this replaces 600 with — rounded up, because landing
         * one line short of the period costs the whole run.
         *
         * That also retires the last comparison to the 2026-07-12 success. Its
         * 600 ms is not reproducible here and matching it was the wrong goal:
         * a value copied from one recorded run is a guess with a citation,
         * while this one comes from counting which lines survived.
         *
         * The cost is arithmetic: nineteen lines at 2.5 s is about 48 s a file,
         * roughly two and a half minutes for all three. The idle window after
         * `NB module power-off successful` runs some nine minutes, so it fits
         * with room to spare.
         */
        floorMs: 2500,
        log: (text, kind) => write(text, kind === 'ok' ? 'ok'
            : kind === 'fail' ? 'fail' : kind === 'tx' ? 'tx' : 'note'),
    };

    state.busy = true;
    state.redacting = true;
    setMark('certs', '0/3', 'run');
    try {
        await writeCerts(io, state.bundle,
            done => setMark('certs', `${done}/3`, done === 3 ? 'ok' : 'run'));
        setMark('certs', '3/3 ✓', 'ok');
        ok('All three certificates verified by the modem.');
    } catch (err) {
        setMark('certs', 'failed', 'fail');
        fail(`② CERTS: ${err.message}`);
        note('Nothing half-written survives — every attempt starts with QFDEL.');
        note('Press RESET, wait for the window, and tap ② again.');
    } finally {
        /* Order matters: the filter is holding a partial line, and once the
         * flag is down it would be appended verbatim. */
        flushRaw();
        state.redacting = false;
        state.busy = false;
    }
}

/* ── ④ VERIFY ─────────────────────────────────────────────────────────────
 *
 * What the device says about its own cycle, over the link that is already open.
 *
 * The check this stage wanted was the platform's: ask a backend whether an
 * uplink arrived for this IMEI. There is no backend, and a phone cannot hold
 * AWS credentials to ask directly — so this asks the only witness present.
 *
 * That witness is better than it sounds, because of ONE line. `Successfully
 * connected to the server` is printed after AWS IoT returns CONNACK, and AWS
 * IoT only returns CONNACK to a client whose certificate is registered, ACTIVE,
 * attached to a policy, and whose private key matched the TLS handshake. Every
 * failure mode of a certificate write ends before that line. Nothing else the
 * device prints carries that weight.
 *
 * `Upload data successfully` does NOT: `MQOS=0` means QoS 0, so there is no
 * PUBACK to wait for and the line means "the modem sent it". The distinction is
 * kept in the wording rather than smoothed over — this stage exists to stop a
 * unit being called provisioned on the strength of an OK.
 *
 * This stage sends nothing. It watches. The RESET button is next to it.
 */
const PUBLISH_EVIDENCE = [
    [/\*+Upload start/i,                             'cycle started'],
    [/Configure the path of CA certificate/i,        'read the CA it stored'],
    [/Configure the path of client certificate/i,    'read the client cert it stored'],
    [/Configure the path of client private key/i,    'read the private key it stored'],
    [/Opened the MQTT client network successfully/i, 'reached the broker (TCP)'],
    [/Successfully connected to the server/i,        'AWS IoT ACCEPTED THIS CERTIFICATE'],
    [/Upload data successfully/i,                    'data sent (QoS 0 — the broker does not ack it)'],
    [/\*+End of upload\*+/i,                         'cycle closed'],
];

const CONNECTED = 5;   /* index of the line that proves the certificate */
const SENT = 6;

/* The ceiling is one duty cycle plus slack, because a technician who does not
 * press RESET is waiting for the natural one. */
function verifyBudgetMs() {
    const tdc = state.bundle && state.bundle.mqtt && state.bundle.mqtt.tdc;
    return ((Number(tdc) || 1200) + 180) * 1000;
}

function doVerify() {
    /* Armed twice is a second watcher on the same stream. The second tap stops
     * the first instead. */
    if (state.verifying) {
        state.verifying.stop();
        return;
    }

    const seen = new Set();
    const collector = { lines: [], each: line => {
        PUBLISH_EVIDENCE.forEach(([pattern, meaning], i) => {
            if (seen.has(i) || !pattern.test(line)) return;
            seen.add(i);
            write(`④ ${meaning}`, i === CONNECTED ? 'ok' : 'note');
            setMark('verify', `${seen.size}/${PUBLISH_EVIDENCE.length}`, 'run');
            /* Stop at the verdict, or when the cycle closes without one —
             * a failed cycle is diagnosable now, not in twenty minutes. */
            if ((seen.has(CONNECTED) && seen.has(SENT))
                || i === PUBLISH_EVIDENCE.length - 1) finish();
        });
    } };

    const finish = () => {
        if (!state.verifying) return;
        clearTimeout(timer);
        collectors.delete(collector);
        state.verifying = null;

        if (seen.has(CONNECTED) && seen.has(SENT)) {
            setMark('verify', 'published ✓', 'ok');
            ok('④ AWS IoT accepted this unit\'s certificate and the reading left ' +
               'the modem.');
            note('QoS 0 has no delivery receipt: confirm the uplink landed in ' +
                 `AWS IoT for ${state.bundle ? state.bundle.imei : 'this IMEI'}.`);
        } else if (seen.has(0)) {
            setMark('verify', 'no MQTT', 'fail');
            fail('④ The cycle ran and never connected to the server.');
            note(seen.has(4)
                ? 'It reached the broker and was refused: the certificate is ' +
                  'not registered/active/attached, or the key does not match it.'
                : 'It never reached the broker: network, APN or SERVADDR — not ' +
                  'the certificates.');
            note('SNI=0 and MQOS=0 are the two settings that fail silently here.');
        } else {
            setMark('verify', 'nothing seen', 'weak');
            fail('④ No cycle was observed before the budget ran out.');
            note('The link only carries lines while the unit is awake, so a ' +
                 'cycle that ran while BLE was re-attaching can be missed.');
        }
    };

    const timer = setTimeout(finish, verifyBudgetMs());
    state.verifying = { stop: finish };
    collectors.add(collector);

    setMark('verify', 'watching', 'run');
    note(`④ Watching for a publish, up to ${Math.round(verifyBudgetMs() / 60000)} ` +
         'min. Press RESET to start a cycle now, or wait for the next one.');
    note('Tap ④ again to stop watching and report what was seen.');
}

/* ── Wiring ──────────────────────────────────────────────────────────── */

/*
 * `?mock` — drive the real page against the simulated device.
 *
 * Same convention as modules/mock.js: dynamically imported, never on a
 * production path. This exists because the one thing a hardware session cannot
 * rehearse is its own failures, and because the BLE chooser is native browser
 * UI that nothing can drive on your behalf. What it proves is the wiring —
 * buttons, marks, redaction, the terminal — against a modem that computes its
 * checksum independently.
 *
 *   ?mock            happy path
 *   ?mock=nordy      passthrough half-engaged — must refuse
 *   ?mock=noecho     ATE0 refused — must refuse to stream
 *   ?mock=drop       a lost part — must fail the gate, then recover on retry
 */
async function installMock(kind) {
    const { makeFakeDevice } = await import('./fake-device.js');
    const faults = kind === 'nordy' ? { noRdy: true }
        : kind === 'noecho' ? { refuseAte0: true }
        : kind === 'drop' ? { dropPart: 5, healAfter: 1 }
        : {};

    const fake = makeFakeDevice(faults, line => {
        rawAppend(line + '\r\n');
        write(redact(line));
        feed(line);
    });
    let up = false;
    state.mock = true;

    link.connect = async () => { up = true; setLink('connected', 'simulated'); return 'MOCK-869181072714122'; };
    /* Nothing to adopt without a radio — the mock always takes the connect path. */
    link.adopt = async () => null;
    link.reconnect = async () => { up = true; };
    link.isConnected = () => up;
    link.deviceName = () => 'MOCK-869181072714122';
    link.sendLine = fake.io.send;
    link.sendRaw = fake.io.sendRaw;
    link.disconnect = async () => { up = false; };

    fail(`MOCK MODE (${kind || 'happy path'}) — no radio, no device.`);
    note('Everything below is simulated. Nothing here proves the link works.');
}

export function initProvision() {
    /* First line of every session, so it lands in any screenshot sent back
     * from a bench. A log without a version is a log you cannot place. */
    el('app-version').textContent = `v${VERSION}`;
    note(`AIS01 End node configuration v${VERSION} — ${VERSION_NOTE}`);

    el('btn-connect').addEventListener('click', doConnect);
    el('btn-login').addEventListener('click', doLogin);
    el('btn-certs').addEventListener('click', doCerts);
    el('btn-verify').addEventListener('click', doVerify);

    el('btn-config').addEventListener('click', () => {
        if (state.pendingDeltas) return doApplyConfig();
        if (!state.bundle) return doReadConfig();
        return doStageConfig();
    });

    el('copy-log').addEventListener('click', copyRawLog);
    el('btn-reset').addEventListener('click', doReset);
    el('btn-forget').addEventListener('click', forgetBundle);
    restoreBundle();

    el('bundle-input').addEventListener('change', e => loadFiles(e.target.files));

    el('at-send').addEventListener('click', sendManual);
    el('at-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') sendManual();
    });

    /* Scrolling away from the tail unpins that pane; the marker is how the
     * operator knows they are no longer looking at the present. It reports the
     * annotated pane, which is the one the stages talk through — the raw pane
     * unpins quietly, since going back through it is the normal way to read it. */
    for (const [id, pane] of [['terminal', 'annotated'], ['terminal-raw', 'raw']]) {
        const out = el(id);
        out.addEventListener('scroll', () => {
            const atBottom =
                out.scrollHeight - out.scrollTop - out.clientHeight < 24;
            state.pinned[pane] = atBottom;
            if (pane === 'annotated') {
                el('live').style.visibility = atBottom ? 'visible' : 'hidden';
            }
        });
    }

    const kind = new URLSearchParams(location.search).get('mock');
    if (kind !== null || location.search.includes('mock')) {
        installMock(kind || '');
        return;
    }

    if (!hasBluetooth()) {
        fail('No Web Bluetooth in this browser. On iOS use Bluefy.');
    }
    note('Load the unit bundle, then connect.');
}
