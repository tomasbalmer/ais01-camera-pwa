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
    hasBluetooth, connect, reconnect, isConnected, deviceName,
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
    connect, reconnect, isConnected, deviceName, sendLine, sendRaw, disconnect,
};

/* Everything below is app state. None of it describes the device. */
const state = {
    bundle: null,
    pinned: true,      /* terminal follows the tail */
    pendingDeltas: null, /* config deltas awaiting a confirming second tap */
    redacting: false,  /* key material may be on the wire — see redact() */
    rawView: false,    /* terminal shows the verbatim stream instead */
    busy: false,       /* a stage's own loop is running */
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
function redact(line) {
    if (!state.redacting) return line;
    if (line.length >= 60 && /^[A-Za-z0-9+/=]+$/.test(line.trim())) {
        return '[redacted PEM body]';
    }
    return line;
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
 * So the bytes are kept separately, exactly as they arrived, and the terminal
 * is one of two ways to look at them.
 *
 * One asymmetry, on purpose: RX is verbatim, TX is not. What we sent we already
 * know, and reproducing the PEM bytes would put a private key on the screen and
 * into the clipboard of a log meant to be shared. Evidence is what the device
 * said back.
 */
const RAW_CAP = 1_000_000;   /* characters; a bench session is long */
let rawLog = '';

function rawAppend(text, dir) {
    /* Only the payload is a secret. Redacting the commands too hid `AT+CERTMOD`
     * behind "[PEM part redacted]" in the one artefact meant to explain a
     * failure — the raw log stopped being able to answer what we had sent. */
    if (dir === 'tx-raw') {
        text = '\n[tx: PEM part redacted]\n';
    } else if (dir === 'tx-line') {
        text = `\n>>> ${text}`;
    }
    rawLog += text;
    if (rawLog.length > RAW_CAP) rawLog = rawLog.slice(-RAW_CAP);
    if (state.rawView) renderRaw();
}

function renderRaw() {
    const out = el('terminal-raw');
    out.textContent = rawLog || '(nothing received yet)';
    if (state.pinned) tail(out);
}

/*
 * The two views are two elements, and switching only changes which one is
 * hidden. Nothing is cleared and nothing is replayed, because both panes are
 * written to at all times — including while they are hidden.
 *
 * This used to be one element rendered two ways, which meant every toggle
 * destroyed the view it was leaving: RAW overwrote the annotated lines, and
 * coming back started from an empty screen. On a bench that is the log of the
 * boot you are in the middle of, gone for having looked at it.
 */
function setRawView(on) {
    state.rawView = on;
    el('raw-toggle').textContent = on ? 'ANNOTATED' : 'RAW';
    el('terminal').hidden = on;
    el('terminal-raw').hidden = !on;

    /* A hidden element has no scroll height, so neither pane can be tailed
     * while it is off screen — the one coming back is re-pinned here. The raw
     * pane is also re-rendered here rather than on every chunk, since printing
     * a megabyte buffer nobody is looking at is work for nothing. */
    if (on) renderRaw();
    else if (state.pinned) tail(el('terminal'));
}

function tail(out) { out.scrollTop = out.scrollHeight; }

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

    /* Writing continues while this pane is hidden — only the scroll does not,
     * because a hidden element has no height to scroll. setRawView re-pins. */
    if (state.pinned && !out.hidden) tail(out);
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
 * modem computed over what it stored, and the platform seeing an uplink. ① and
 * ③ get an amber mark that says what was observed and nothing more, because a
 * green tick on "OK was returned" would be a claim this app cannot support.
 */
function setMark(stage, text, kind = 'weak') {
    const mark = el(`mark-${stage}`);
    mark.textContent = text;
    mark.className = `mark mark-${kind}`;
}

function setLink(status, detail) {
    const dot = el('link-state');
    dot.textContent = status === 'connected' ? '● BLE'
        : status === 'reconnecting' ? '◐ BLE' : '○ BLE';
    dot.className = `link link-${status}`;
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

    /* A prepared bundle still works — it is what a Drive-based flow hands out
     * and there is no reason to break it. */
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
        note('Select the whole device folder, including password.txt.');
        return;
    }

    /* Folder pick preserves the directory name; a loose multi-select does not. */
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

async function loadBundleJson(file) {
    try {
        const bundle = parseBundle(await file.text());
        state.bundle = bundle;
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
        const name = await link.connect(
            { onLine, onChunk, onDiag, onStatus: setLink });
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
        /* The proven writer's `--part-delay` default, and for the reason given
         * in `partDelayMs`: the firmware's single line buffer, not the wire. */
        floorMs: 600,
        /*
         * `?probe=N` uploads the first N lines of the CA under a throwaway
         * name before writing anything, and gates them on the checksum of
         * exactly those N lines.
         *
         * It is a bisector. One line lands; twenty do not, with all 1208 bytes
         * proven to have left the phone and fourteen seconds of modem left to
         * answer in. Somewhere between the two the console starts dropping
         * lines, and the count that first fails is worth more than any theory
         * about why — it turns "raise the pacing and see" into a number.
         */
        probe: Number(new URLSearchParams(location.search).get('probe')) || 0,
        /* `?from=M` starts the probe at line M+1. Line 1 is 29 bytes of ASCII
         * and every other line is 66 of base64, so a probe that always starts
         * at the beginning can never say whether a second line or a longer one
         * is what breaks. */
        probeFrom: Number(new URLSearchParams(location.search).get('from')) || 0,
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
        state.redacting = false;
        state.busy = false;
    }
}

function doVerify() {
    setMark('verify', 'no backend', 'fail');
    fail('④ RESET & VERIFY needs the backend check that does not exist yet.');
    note('Interim: reset the unit, wait one cycle, and confirm in AWS IoT that');
    note(`${state.bundle ? state.bundle.imei : 'this IMEI'} published.`);
    note('Do NOT call a unit provisioned because the writes returned OK.');
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
    note(`AIS01 Provision v${VERSION} — ${VERSION_NOTE}`);

    el('btn-connect').addEventListener('click', doConnect);
    el('btn-login').addEventListener('click', doLogin);
    el('btn-certs').addEventListener('click', doCerts);
    el('btn-verify').addEventListener('click', doVerify);

    el('btn-config').addEventListener('click', () => {
        if (state.pendingDeltas) return doApplyConfig();
        if (!state.bundle) return doReadConfig();
        return doStageConfig();
    });

    el('raw-toggle').addEventListener('click', () => setRawView(!state.rawView));
    el('copy-log').addEventListener('click', copyRawLog);

    el('bundle-input').addEventListener('change', e => loadFiles(e.target.files));

    /* Scrolling away from the tail unpins; the marker is how the operator
     * knows they are no longer looking at the present. */
    for (const id of ['terminal', 'terminal-raw']) {
        const out = el(id);
        out.addEventListener('scroll', () => {
            const atBottom =
                out.scrollHeight - out.scrollTop - out.clientHeight < 24;
            state.pinned = atBottom;
            el('live').style.visibility = atBottom ? 'visible' : 'hidden';
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
