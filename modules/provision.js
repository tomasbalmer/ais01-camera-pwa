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

    if (state.pinned) out.scrollTop = out.scrollHeight;
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
    for (const c of collectors) c.lines.push(line);
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
    if (advertised.includes(bundle.imei)) return null;
    return `bundle is for ${bundle.imei}, connected unit advertises "${advertised}"`;
}

async function loadBundleFile(file) {
    try {
        const bundle = parseBundle(await file.text());
        state.bundle = bundle;
        el('imei').textContent = bundle.imei;
        note(`bundle loaded: ${file.name}`);
        note(`  thing ${bundle.thing_name}`);

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
        const name = await link.connect({ onLine, onStatus: setLink });
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

    /*
     * There is no "login OK" to wait for — only the one reply that means no.
     * `Password Incorrect` at this point almost always means the password was
     * sent before the window opened, not that it is wrong, so the mark says
     * exactly that instead of asserting a cause.
     */
    const lines = await replies;
    if (lines.some(l => /password\s+incorrect/i.test(l))) {
        setMark('login', 'refused', 'fail');
        fail('Password Incorrect — almost always too soon, not wrong.');
        note('Press RESET, wait for "NBIOT has responded.", tap ① again.');
        return;
    }
    if (lines.some(l => /password\s+timeout/i.test(l))) {
        setMark('login', 'expired', 'fail');
        fail('Password timeout — the session expired. Log in again.');
        return;
    }
    /* Amber, not green: silence is consistent with a good login and does not
     * prove one. The next command is what proves it. */
    setMark('login', 'no refusal', 'weak');
}

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
        floorMs: 150,
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

    const fake = makeFakeDevice(faults, line => { write(redact(line)); feed(line); });
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
    el('btn-connect').addEventListener('click', doConnect);
    el('btn-login').addEventListener('click', doLogin);
    el('btn-certs').addEventListener('click', doCerts);
    el('btn-verify').addEventListener('click', doVerify);

    el('btn-config').addEventListener('click', () => {
        if (state.pendingDeltas) return doApplyConfig();
        if (!state.bundle) return doReadConfig();
        return doStageConfig();
    });

    el('bundle-input').addEventListener('change', e => {
        const file = e.target.files && e.target.files[0];
        if (file) loadBundleFile(file);
    });

    /* Scrolling away from the tail unpins; the marker is how the operator
     * knows they are no longer looking at the present. */
    const out = el('terminal');
    out.addEventListener('scroll', () => {
        const atBottom =
            out.scrollHeight - out.scrollTop - out.clientHeight < 24;
        state.pinned = atBottom;
        el('live').style.visibility = atBottom ? 'visible' : 'hidden';
    });

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
