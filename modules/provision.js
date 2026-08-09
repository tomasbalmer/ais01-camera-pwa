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
    isHunting, stopHunting, sendLine, sendRaw, disconnect,
} from './ble-transport.js';
import { writeCerts } from './certmod.js';
import { catalogueGroups, describe, DANGEROUS } from './at-catalogue.js';
import { checkFolder, identityOf, FOLDER_SHAPE } from './folder-check.js';
import { saveHandle, loadHandle, clearHandle } from './handle-store.js';
import {
    STAGES, LOG_FILE, CONFIG_FILE, logEntry, appendLog, saveIntendedConfig,
    readLog, lastFor, parseLog,
} from './device-record.js';
import { VERSION, VERSION_NOTE } from './version.js';

/*
 * Every device call goes through this one object so `?mock` can replace the
 * device without the stages knowing. The stages are the thing worth testing;
 * they must not contain a branch for being tested.
 */
const link = {
    connect, adopt, reconnect, isConnected, deviceName, isHunting, stopHunting,
    sendLine, sendRaw, disconnect,
};

/* Everything below is app state. None of it describes the device. */
const state = {
    /* The unit's material, in memory only, for as long as this page lives.
     * Re-read from disk every session — see `handle-store.js`. */
    bundle: null,
    /* The folder itself, as a reference to a place on this machine. Survives a
     * reload; its permission usually does not. */
    handle: null,
    /* What we know about the unit before its material is back: the IMEI and the
     * environment, both read out of the folder's NAME. Enough to say which unit
     * ⓪ is waiting for, and to stop the app adopting a different one. */
    remembered: null,
    /* One pin per pane. They are both on screen now, so scrolling back through
     * the raw stream to check a line must not stop the annotated one from
     * following the device. */
    pinned: { annotated: true, raw: true },
    /* Per stage, because ③ and ④ are two independent two-tap sequences and one
     * shared slot would let arming either one disarm the other. */
    pending: { network: null, mqtt: null },
    redacting: false,  /* key material may be on the wire — see redact() */
    busy: false,       /* a stage's own loop is running */
    verifying: null,   /* ⑤ is watching the stream — {stop} while armed */
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
        /* The foot measures the stream: a count that stops moving is the first
         * sign of a link that is up and carrying nothing. */
        el('raw-count').textContent = rawLog ? rawLog.split('\n').length : 0;
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
    if (!needLink()) return;
    write('ATZ', 'tx');
    await link.sendLine('ATZ');
    /* The one boot we cause, so it is the one we can draw without being told.
     * It retires the login mark on its way past — see `divider`. */
    divider('reset', 'RESET SENT');
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
/*
 * Fill the field from the menu — and only fill it.
 *
 * Sending stays the separate press it always was. A menu that fired on
 * selection would put `ATZ` one stray tap away from restarting a unit in the
 * middle of a certificate write, which is the one thing this screen cannot
 * afford to make easy.
 *
 * The unit's own settings are rebuilt each time the folder changes, because
 * they only exist once there is a folder: they come from `desiredSettings`,
 * the same list ③ stages, so picking one sends exactly what ③ would have sent
 * for that line and nothing else.
 */
/*
 * The unit's own settings come first when there is a folder, because they are
 * the only entries carrying real values rather than templates — they are the
 * same lists ③ and ④ stage, from the same functions, so sending one line alone
 * sends exactly what the stage would have sent for it.
 *
 * `networkSettings` throws when the folder names no region. That is the right
 * behaviour for a stage about to write and the wrong one for a menu, so here it
 * simply contributes nothing and the rest of the list still builds.
 */
/*
 * This unit's own settings, split the way the stages are split.
 *
 * They were one group of thirteen called `This unit · <IMEI>`, which is a list
 * of everything with no shape: the four that decide whether the modem attaches
 * sat next to the ten that decide where it publishes, and the only way to tell
 * them apart was to already know. They are answerable to different things —
 * one comes from the SIM the unit will sit beside, the other from the folder's
 * name — and that is the split the buttons already make.
 *
 * The hint is what the SETTING means, not which button sends it. The group
 * heading says which button; repeating it on every row spends the one column
 * that could be explaining `SNI=0` on something already read.
 */
function unitGroups(bundle) {
    const groups = [];
    for (const spec of Object.values(CONFIG_STAGES)) {
        let settings;
        /* `networkSettings` throws when the folder names no region. Right for
         * a stage about to write, wrong for a menu — here it contributes
         * nothing and the rest of the list still builds. */
        try { settings = spec.settings(bundle); } catch { continue; }
        if (!settings.length) continue;
        groups.push([`This unit · ${spec.menuGroup}`,
            settings.map(([name, value]) =>
                [`${name}=${value}`, describe(`${name}=${value}`)])]);
    }
    return groups;
}

/*
 * The other countries' network profiles, straight out of `REGIONS`.
 *
 * The loaded one is left out because it is already at the top, under `This
 * unit`, with the same four values. What is left is the answer to the question
 * this menu could not answer before: a unit turns up whose `region.txt` was
 * wrong, and the four commands that fix it are now readable instead of being
 * reconstructed from `golden-config.md`.
 *
 * One group per country rather than one group with the country repeated on
 * every row — four rows saying `Brazil · Vivo` is a column spent on a heading.
 */
function countryGroups() {
    const loaded = state.bundle && state.bundle.region;
    return Object.entries(REGIONS)
        .filter(([code]) => code !== loaded)
        .map(([code, profile]) => [
            `${profile.country} · ${profile.carrier}`,
            profile.settings.map(([name, value]) =>
                [`${name}=${value}`, describe(`${name}=${value}`)]),
        ]);
}

function atGroups() {
    const shelf = catalogueGroups();
    return [
        ...(state.bundle ? unitGroups(state.bundle) : []),
        shelf.common,
        ...shelf.presets,
        ...countryGroups(),
        shelf.bg95,
        shelf.all,
    ];
}

function buildAtMenu(filter = '') {
    const list = el('at-list');
    list.textContent = '';
    const needle = filter.trim().toLowerCase();
    let shown = 0;

    for (const [label, entries] of atGroups()) {
        const matching = needle
            ? entries.filter(([command, why]) =>
                `${command} ${why}`.toLowerCase().includes(needle))
            : entries;
        if (!matching.length) continue;

        const head = document.createElement('div');
        head.className = 'at-group';
        head.textContent = label;
        list.appendChild(head);

        for (const [command, why] of matching) {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'at-opt' +
                (DANGEROUS.has(command.replace(/=.*$/, '')) ? ' is-danger' : '');
            option.setAttribute('role', 'option');
            option.dataset.command = command;

            /* Built as elements with textContent, never markup: these carry
             * endpoints and topics assembled from a folder name. */
            const cmd = document.createElement('span');
            cmd.className = 'cmd';
            cmd.textContent = command;
            const note_ = document.createElement('span');
            note_.className = 'why';
            note_.textContent = why;
            /* Both halves, for a row narrow enough to have wrapped. */
            option.title = why ? `${command}\n${why}` : command;
            option.append(cmd, note_);
            list.appendChild(option);
            shown++;
        }
    }

    if (!shown) {
        const empty = document.createElement('div');
        empty.className = 'at-empty';
        empty.textContent = `Nothing matches "${filter}". The field beside the ` +
            'menu still sends anything, as typed.';
        list.appendChild(empty);
    }
}

function atPanelOpen() { return !el('at-panel').hidden; }

function openAtPanel(open) {
    el('at-panel').hidden = !open;
    el('at-menu').setAttribute('aria-expanded', String(open));
    if (!open) return;
    buildAtMenu('');
    const filter = el('at-filter');
    filter.value = '';
    /* A physical keyboard filters 58 entries faster than a thumb scrolls them;
     * a touch keyboard would cover the list it is filtering. */
    if (matchMedia('(pointer: fine)').matches) filter.focus();
}

/*
 * Picking fills the field and closes. Nothing is sent — the technician owns
 * when a command goes out, which is the same principle the stage buttons
 * follow, and a list that sent on tap would put `ATZ` one stray touch away
 * from restarting a unit mid-write.
 */
function takeCommand(command) {
    openAtPanel(false);
    const input = el('at-input');
    input.value = command;
    input.focus();
    /* Everything after the `=` is what usually needs changing, so selecting it
     * means the next keystroke replaces it rather than appending. */
    const at = command.indexOf('=');
    if (at >= 0) input.setSelectionRange(at + 1, command.length);
    else input.setSelectionRange(command.length, command.length);
}

function wireAtPicker() {
    el('at-menu').addEventListener('click', () => openAtPanel(!atPanelOpen()));

    el('at-list').addEventListener('click', event => {
        const option = event.target.closest('.at-opt');
        if (option) takeCommand(option.dataset.command);
    });

    el('at-filter').addEventListener('input', e => buildAtMenu(e.target.value));
    el('at-filter').addEventListener('keydown', e => {
        if (e.key === 'Escape') { openAtPanel(false); el('at-menu').focus(); return; }
        if (e.key !== 'Enter') return;
        const first = el('at-list').querySelector('.at-opt');
        if (first) takeCommand(first.dataset.command);
    });

    /* Anywhere else closes it. The panel covers the terminal, which is the
     * instrument — it must never be something you have to dismiss twice. */
    document.addEventListener('click', event => {
        if (!atPanelOpen()) return;
        if (!event.target.closest('.at-picker')) openAtPanel(false);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && atPanelOpen()) openAtPanel(false);
    });
}

async function sendManual() {
    const input = el('at-input');
    const text = input.value.trim();
    if (!text) return;
    if (!needLink()) return;

    /* `ATZ` keeps the treatment its dedicated button gave it — the boot divider
     * and the line about when the window opens are worth more than the button
     * was, and they are about the restart rather than about where it was
     * pressed from. */
    if (/^ATZ$/i.test(text)) { await doReset(); input.select(); return; }

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
/*
 * Every row says who is speaking, the way the dashboard's History does.
 *
 * Colour is status and the badge is source, and they are independent on
 * purpose: a green line can be the device reporting success or this app
 * concluding it, and those are not the same claim. `OK` from a modem is a
 * receipt; "3/3 verified" is a deduction we made from three checksums. Reading
 * a log to find out why a unit failed means telling those apart, and until now
 * they were the same shade of green.
 */
const VOICE = { rx: 'DEV', tx: 'CMD', ok: 'SYS', fail: 'SYS', note: 'SYS', you: 'YOU' };

/*
 * `field` turns a row into a labelled one: a column of its own for the name of
 * the thing, and the value beside it.
 *
 * It used to be spaces. `⓪`'s checklist padded its labels to twelve characters
 * inside the message span, which lines up only while the font is monospaced
 * and the label is short, and which makes the label and its value one string —
 * so neither can be styled without styling the other. A column is a column.
 */
function write(text, kind = 'rx', field = null) {
    const out = el('terminal');
    const voice = VOICE[kind] || 'SYS';
    const line = document.createElement('div');
    line.className = `line line-${kind} voice-${voice.toLowerCase()}`;

    /* Built as elements with textContent, never markup: every one of these
     * strings can be a line the device sent. */
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = stamp();
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = voice;
    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = text;

    if (field) {
        const k = document.createElement('span');
        k.className = 'k';
        k.textContent = field;
        line.append(t, v, k, m);
    } else {
        line.append(t, v, m);
    }
    out.appendChild(line);

    /* A failure anywhere inside a stage is the stage's verdict, immediately and
     * permanently — the header cannot go back to amber once something broke. */
    if (kind === 'fail') failPhase();

    /* Bounded: a bench session runs for hours across many boots. */
    while (out.childElementCount > 2000) out.removeChild(out.firstChild);

    if (state.pinned.annotated) tail(out);
}

function note(text) { write(text, 'note'); }
function fail(text) { write(text, 'fail'); }
function ok(text) { write(text, 'ok'); }
/* Something for the person to do with their hands: press RESET, plug it in,
 * pick a bundle. It is the one voice the app cannot act on itself. */
function you(text) { write(text, 'you'); }

/*
 * The seven steps, each by the name it wears on its own button.
 *
 * ONE name per step, used for the section it opens in the log AND for every
 * sentence that asks somebody to press it. There were three vocabularies for
 * the same seven things: the chip said `Select provisioning folder`, the log
 * section said `⓪ FOLDER`, and the prose said `pick one with ⓪` — and the last
 * two named something that is not on the screen at all. The numbers left the
 * chips when the status circles took over (provision.html: "the order it was
 * carrying is already given by the position"), and nothing else followed them
 * out. Every `⓪`, `②` and `⑤` printed since has been an instruction to press a
 * control the operator cannot find.
 *
 * So a message that wants somebody to press something quotes what is written
 * on it, verbatim. That is the only version of this that cannot drift: rename
 * a chip without touching this table and the mismatch shows up in the first
 * screenshot instead of in a support call.
 *
 * Sentence case here and uppercase on screen — `.phase` applies the transform,
 * so `AWS IoT` stays spelled properly in the one place it is written down.
 *
 * The numbers survive in this file's COMMENTS, where they are shorthand
 * between developers and point at `firmware-factory/stages.json`. They are not
 * shown to anybody holding the phone.
 */
const STEP = {
    folder:  'Select provisioning folder',
    ble:     'Connect via Bluetooth',
    login:   'Log in to device console',
    certs:   'Write certificates into modem',
    network: 'Apply cellular network settings',
    mqtt:    'Apply MQTT broker settings',
    verify:  'Verify publish to AWS IoT',
};

/* A control named inside a sentence. The quotes are load-bearing: a
 * three-word name dissolves into the words around it without them. */
const press = step => `"${step}"`;

/* ── Phases ──────────────────────────────────────────────────────────────
 *
 * A stage opens a section whose header carries the section's verdict: amber
 * while it runs, green when it closes with nothing broken, red from the first
 * failure inside it. The rows keep the detail; the header is what you scan.
 */
/*
 * Sections can overlap, so each one is a handle its opener holds rather than a
 * single "current phase" variable. ⑤ arms a watcher and stays open for up to a
 * duty cycle; tapping ② during that is normal, and with one shared variable
 * the second section would take the first's place and leave ⑤ amber for good.
 *
 * A failure belongs to the innermost section running when it happened — the
 * one that was doing something — not to a watcher that happens to be open.
 */
const openPhases = [];

function startPhase(label) {
    const out = el('terminal');
    const node = document.createElement('div');
    node.className = 'phase';
    node.textContent = label;
    out.appendChild(node);
    if (state.pinned.annotated) tail(out);
    const handle = { node, failed: false };
    openPhases.push(handle);
    return handle;
}

function failPhase() {
    const handle = openPhases[openPhases.length - 1];
    if (!handle) return;
    handle.failed = true;
    handle.node.classList.remove('is-ok');
    handle.node.classList.add('is-fail');
}

function endPhase(handle) {
    if (!handle) return;
    const i = openPhases.indexOf(handle);
    if (i >= 0) openPhases.splice(i, 1);

    /*
     * A section that said nothing is removed rather than drawn.
     *
     * Every stage a person taps reports something, so this changes none of
     * them. What it makes possible is opening a section around work that MIGHT
     * be silent — the BLE attempt runs by itself on every load and on every
     * return to the screen, and finding nothing to adopt is its normal, wordless
     * outcome. A heading over nothing is worse than no heading: it claims an
     * event, and a log full of empty claims is one nobody scans.
     */
    if (!handle.node.nextSibling) {
        handle.node.remove();
        return;
    }
    if (!handle.failed) handle.node.classList.add('is-ok');
}

/* ── Boot dividers ───────────────────────────────────────────────────────
 *
 * Where the cycle starts and ends, drawn where the raw log draws it, so a line
 * can be placed in the boot it belongs to. Two come from the device and one
 * from us, because a reset is the one boot we cause.
 */
/*
 * `ASLEEP` was wrong, and wrong about the state this whole screen waits for.
 *
 * `NB module power-off successful` is the firmware switching the BG95 off at
 * the end of a cycle. The STM32 does not sleep with it: the console keeps
 * answering, the BLE link stays up, and commands still land — which is not a
 * detail, it is the entire premise of ②. `certmod.js` requires the write to
 * happen exactly here, AFTER this line, and a screen calling that unit asleep
 * was telling the operator to avoid the one moment it is waiting for.
 *
 * The label now says what the line says: the modem went off. What did not
 * happen was any kind of sleep.
 */
const BOOT_MARKS = [
    [/Echo mode turned off successfully/i, 'wake', 'DEVICE AWAKE'],
    [/NB module power-off successful/i,    'end',  'MODEM POWERED OFF'],
];
let lastDivider = '';

/*
 * Which boundaries end a console session, and which only look like they should.
 *
 * The login dies with the STM32, not with the radio. `reset` is our own `ATZ`
 * and `wake` is the firmware coming up again — both are the console restarting,
 * and a password does not survive either.
 *
 * `end` is NOT one, and having it here was a live bug: an operator who had just
 * logged in watched ① go blank the moment the modem powered down, while their
 * session was still perfectly good. Reported from the bench 2026-08-09. The
 * modem going quiet has nothing to do with the console that was authenticated.
 */
const ENDS_SESSION = new Set(['reset', 'wake']);

function watchBoot(line) {
    for (const [pattern, kind, label] of BOOT_MARKS) {
        if (pattern.test(line)) { divider(kind, label); return; }
    }
}

function divider(kind, label) {
    if (kind === lastDivider) return;   /* the same boundary said twice */
    lastDivider = kind;
    const out = el('terminal');
    const d = document.createElement('div');
    d.className = `divider ${kind}`;
    d.textContent = `${label} · ${stamp()}`;
    out.appendChild(d);
    if (state.pinned.annotated) tail(out);

    /*
     * A boundary that restarted the console retires the login mark — see
     * `ENDS_SESSION` for why the modem powering off is not one of them.
     */
    if (ENDS_SESSION.has(kind)) sessionEnded();
}

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
 * ② and ⑤ carry evidence strong enough to be called proof — a checksum the
 * modem computed over what it stored, and a CONNACK from AWS IoT, which is only
 * issued to a certificate that is registered, active, attached to a policy and
 * matched by its key. ① and ③ get an amber mark that says what was observed and
 * nothing more, because a green tick on "OK was returned" would be a claim this
 * app cannot support.
 */
/*
 * The mark's `kind` was already the stage's whole state, so the chip's circle
 * and the cards read it rather than being told separately. One call site, one
 * truth — a second setter is a second thing to forget.
 *
 * The mapping is the dashboard's status→style table (DESIGN-SYSTEM.md §2),
 * with this app's four kinds standing in for its seven statuses:
 *
 *     ok    → done      the stage closed on evidence it can defend
 *     run   → current   its own loop is going
 *     weak  → partial   it finished, and what it saw is not proof
 *     fail  → fail
 */
const MARK_STATE = { ok: 'done', run: 'current', weak: 'partial', fail: 'fail' };
/*
 * The glyph per state. `pending` has none — an untouched stage has nothing to
 * report, and the ring alone says so. That is the dashboard's own rule
 * (`color: transparent` on the atom); the stage's order comes from where it
 * sits in the row, not from a character inside a circle.
 */
const STATE_GLYPH = { done: '✓', current: '●', partial: '●', fail: '✗', pending: '' };

/* Blank, before a stage has ever run. Not a state a mark can produce, which is
 * why it lives here and not in the table above. */
const stageState = {};

function setMark(stage, text, kind = 'weak') {
    const mark = el(`mark-${stage}`);
    mark.textContent = text;
    /* The chip clips a long mark to keep seven of them the same width, so the
     * whole value has to survive somewhere — see `.mark` in provision.html. */
    mark.title = text || '';
    mark.className = `mark mark-${kind}`;

    /* An empty mark is a stage put back to untouched — ⓪ does it on FORGET. */
    const state_ = text ? (MARK_STATE[kind] || 'partial') : 'pending';
    stageState[stage] = state_;

    const dot = el(`dot-${stage}`);
    if (dot) {
        dot.className = `status-circle is-${state_}`;
        dot.textContent = STATE_GLYPH[state_];
    }
    const chip = dot && dot.parentElement;
    if (chip) {
        chip.classList.remove('is-done', 'is-current', 'is-partial', 'is-fail');
        if (state_ !== 'pending') chip.classList.add(`is-${state_}`);
    }
}

/* The bar says the link with a colour, the way the calibration bar does. The
 * words for it are in the log, where the reason lives too. */
function setLink(status, detail) {
    const dot = el('link-state');
    dot.className = `dot link-${status}`;
    dot.title = `BLE ${status}`;

    const foot = el('raw-live');
    const up = status === 'connected';
    foot.className = up ? 'live' : 'live off';
    foot.lastChild.textContent = up ? 'live' : status;

    /*
     * Always on screen, and coloured by the link rather than hidden by it.
     *
     * It used to vanish once a unit was adopted, on the reasoning that pairing
     * is a one-time act. True, and beside the point: the bar was then left with
     * nothing where the link had been, so the state you most want confirmed at
     * a bench — it IS paired — was the one state with no words on it. Green
     * says it, and the button stays where the eye already learned to look.
     */
    const pair = el('btn-connect');
    pair.className = `link-${status}`;
    el('pair-label').textContent =
        up ? 'PAIRED VIA BLE'
        : status === 'reconnecting' ? 'PAIRING…'
        : 'PAIR DEVICE VIA BLE';

    /*
     * The same fact, in the sequence row, from the one call that already knows
     * it. A second setter for the pairing chip would be a second thing to
     * forget — the rule the marks already follow.
     *
     * The mark is the name the unit advertises rather than a word for the
     * state, because the state is already the ring's job and the name is the
     * thing ⓪ 's IMEI has to be compared against. What it deliberately does NOT
     * do is go red on a mismatch: the link is fine, the folder is the one that
     * is wrong, and two numbers side by side with one of them red says which.
     *
     * Blank when no unit has ever been chosen — an empty ring for a step not
     * taken, which is what `setMark` gives an empty string.
     */
    const paired = link.deviceName();
    setMark('ble',
        up ? (paired || 'connected')
        : status === 'reconnecting' ? 'pairing…'
        : paired ? 'link down' : '',
        up ? 'ok' : status === 'reconnecting' ? 'run' : 'weak');

    /* The folder is usually chosen before the link comes up, so the comparison
     * it enables only becomes possible here. Re-marking on every connect is
     * what turns a green number red when the unit answering is not the one the
     * folder is for. */
    if (up) markUnit();

    if (detail) note(`link ${status}${detail ? ' — ' + detail : ''}`);
}

/* ── The unit's material ─────────────────────────────────────────────────
 *
 * One input, one shape: the folder the technician downloaded from Drive, saved
 * on their machine, and picks whole. Nothing is prepared, converted or packed
 * first, because every step between the server and the unit is a step where
 * material can be paired with the wrong identity.
 *
 * The prepared `AIS01-CB-<IMEI>.json` this replaces existed for one reason —
 * a phone picker cannot ask a cloud provider for a folder — and that reason
 * belongs to a flow that no longer runs from the phone's own storage.
 */

/*
 * Account-level, identical for every unit in an environment, and therefore not
 * something a technician should be typing or a folder should be carrying.
 * Source: firmware-factory/docs/golden-config.md and SETUP-GUIDE.md.
 */
const ENVIRONMENTS = {
    production: {
        endpoint: 'a1igqe74p78h8k-ats.iot.us-east-1.amazonaws.com',
        /* A resolved address for AT+BKDNS, the fallback the firmware uses when
         * DNS does not answer — the transient that cost the 122 its first
         * attempt on every boot. Production only: it is the one we have
         * verified. */
        endpoint_ip: '54.158.94.62',
        tdc: 1200,
    },
    staging: {
        endpoint: 'a8jij4el5zhvl-ats.iot.us-east-1.amazonaws.com',
        tdc: 1200,
    },
};

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
    return `material is for ${bundle.imei}, connected unit advertises "${advertised}"`;
}

/*
 * What a folder must contain, and what it must not be ambiguous about, lives
 * in `folder-check.js` — it is a set of rules about a folder rather than about
 * this screen, and every one of them can be checked with no device attached.
 */

/*
 * Say where we are standing, in the three places it matters.
 *
 * A browser never hands over an absolute path — `webkitRelativePath` is the
 * folder's own name and nothing above it — so "which folder is loaded" can
 * only ever be answered with that name. It is enough, because the name is the
 * identity: it carries the IMEI and the environment, which is the whole reason
 * the convention exists.
 *
 * The bar takes the unit, which is the one standing fact. The mark under ⓪
 * answers the only question the button itself has — is a folder chosen — and
 * says nothing else, because the bar has already said which one. The hover
 * takes the detail: the folder, the endpoint it resolved to, and which file was
 * matched to which role, the question you actually have when a write goes wrong.
 */
/*
 * The country on the bar, or nothing at all.
 *
 * `region.txt` decides `AT+APN` and `AT+IOTMOD`, which decide whether the
 * modem attaches — and the only place it appeared was one row of ⓪'s report,
 * which scrolls away. A bench running Argentine and Brazilian units differs in
 * exactly this, so it belongs where the IMEI is: the two facts you check
 * before sending anything.
 *
 * Blank rather than a guess when there is no folder. There is no country
 * before there is a unit, and a bar that keeps showing the last one is how the
 * next unit gets provisioned as the previous one's.
 */
function showRegion(code) {
    const slot = el('unit-region');
    slot.textContent = '';
    slot.hidden = !code;
    if (!code) { slot.title = ''; return; }

    /* Elements with textContent, never markup: this comes out of a file on a
     * disk somebody else wrote. */
    const abbr = document.createElement('span');
    abbr.textContent = code;
    const name = document.createElement('span');
    name.className = 'country';
    name.textContent = REGIONS[code] ? REGIONS[code].country : '';
    slot.append(abbr, name);

    slot.title = `${regionLabel(code)} — read from region.txt. It sets ` +
                 `AT+APN and AT+IOTMOD, which decide whether the modem ` +
                 `attaches at all.`;
}

function showLoaded(bundle) {
    el('imei').textContent = bundle.imei;
    showRegion(bundle.region);
    markUnit();

    el('btn-bundle').title = [
        bundle.folder,
        `environment: ${bundle.environment} → ${bundle.mqtt.endpoint}`,
        `certificate: ${bundle.files.certificate}`,
        `private key: ${bundle.files.private_key}`,
        `password:    ${bundle.files.password}`,
        '',
        'The browser never reveals where this folder is on disk — only its name.',
    ].join('\n');
}

/*
 * The mark under ⓪ is the unit, in figures.
 *
 * It said "chosen ✓" for one version, and a tick is content-free: picking
 * 869181072714163 when you meant 869181072714122 looks exactly the same under
 * it. The number is the only thing that distinguishes the folder you meant from
 * the one next to it in the download list, and it is there to be compared —
 * against the label on the board, and against the IMEI in the bar.
 *
 * Its colour is the comparison the app can make for you: green while nothing
 * contradicts it, red the moment the connected unit advertises a different
 * IMEI.
 *
 * Amber is the third state, and it is not a hedge between the two — it means
 * the material is NOT loaded. A folder remembered across a reload comes back as
 * a name and a permission to re-request, never as its contents, so between the
 * reload and the tap that re-opens it the app knows which unit it is waiting
 * for and holds nothing it could write. Saying that in amber is the honest
 * reading; leaving it green would be the app claiming a key it does not have.
 */
function markUnit() {
    const bundle = state.bundle;
    if (bundle) {
        setMark('bundle', bundle.imei, imeiMismatch(bundle) ? 'fail' : 'ok');
        return;
    }
    if (state.remembered) { setMark('bundle', state.remembered.imei, 'weak'); return; }
    setMark('bundle', '', 'weak');
}

/* Which unit the app should be talking to, material or not. Used to keep BLE
 * adoption pointed at the right unit on a bench with several granted ones —
 * a guard that used to disappear with every reload. */
function expectedImei() {
    if (state.bundle) return state.bundle.imei;
    return state.remembered ? state.remembered.imei : null;
}

/*
 * `reason` is the verdict and `action` is the one thing to do about it. The
 * reassurance is not a parameter: it is true of every rejection here — this
 * stage reads files and talks to nobody — and it is the first question anyone
 * asks when a screen goes red next to a device worth a truck roll.
 */
function rejectFolder(reason, action) {
    state.bundle = null;
    /* The folder that was pointed at is not usable, so the app stops claiming
     * to know which unit it is on. Keeping the identity would put an amber IMEI
     * under a rejection, which reads as "waiting for this unit" when what
     * happened is "this folder is wrong". */
    state.remembered = null;
    el('imei').textContent = '—';
    showRegion(null);
    el('btn-bundle').title = '';
    setMark('bundle', 'rejected', 'fail');
    fail(reason);
    if (action) you(action);
    note('Nothing has been sent to the unit.');
}

/*
 * Turn a folder — its name and the files in it — into this session's material.
 *
 * Both ways of choosing a folder end here: the directory handle, which is the
 * real path on a desktop browser, and the `webkitdirectory` input that stands
 * in where the File System Access API is absent. They differ in what they can
 * remember afterwards, not in what a folder means.
 *
 * The name is read before the files are, because it decides what the files
 * MEAN. Without it there is material and no identity: three correct files that
 * could belong to any unit on the bench, and writing them is how unit A's
 * identity ends up inside unit B — silent, and visible weeks later in the
 * field. So this refuses rather than warning.
 *
 * Returns true when the material is loaded.
 */
/*
 * Print the verdict line by line, in the voices the log already has: a failure
 * is the app refusing, a note is the app hedging, and the rest is what it saw.
 * The whole list is printed either way — a folder that failed on its key is
 * still a folder whose name and certificate were fine, and knowing which line
 * broke is the difference between re-downloading one file and re-downloading
 * everything.
 */
/* A hairline, for a finding that changes the subject. The rows above ask what
 * the folder CONTAINS; the one below asks whether two of those things agree,
 * which is a different question and reads as one. */
function rule() {
    const out = el('terminal');
    const line = document.createElement('div');
    line.className = 'line-rule';
    out.appendChild(line);
    if (state.pinned.annotated) tail(out);
}

function reportFolder(report) {
    for (const { level, label, detail, rule: breaks } of report.findings) {
        if (breaks) rule();
        const kind = level === 'fail' ? 'fail' : level === 'ok' ? 'ok' : 'note';
        /* `private_key` is a role key, not a word. The column is the only
         * place these are read by a person. */
        write(detail, kind, label.replace(/_/g, ' '));
    }
}

async function loadFromFolder(folder, files) {
    /*
     * ⓪ opens a section like every other stage.
     *
     * Its rows were landing loose in the History between whatever came before
     * and whatever came after, so the eye had to work out where the folder
     * report started and stopped. The app already had the answer — a stage
     * opens a section whose header carries its verdict — and ⓪ is a stage; it
     * simply was not wrapped, because it is the one that runs without touching
     * the device.
     *
     * The header goes red on its own: `write(…, 'fail')` calls `failPhase`.
     */
    const phase = startPhase(STEP.folder);
    try {
        return await readFolder(folder, files);
    } finally {
        endPhase(phase);
    }
}

/*
 * The last two lines, and they are the ones that get read.
 *
 * Both cases were closing with "N things to fix above" and "fix them in the
 * folder", which says the same thing about a folder that is WRONG and a folder
 * that is RIGHT and short one file. Those are different situations and they
 * have different next actions: rename a directory, or create a file in it.
 *
 * So the close is built from what actually failed. A name that parsed is said
 * out loud, because "I picked the right folder" is exactly the thing the
 * operator cannot tell from a screen with red on it.
 */
const list = items => items.length < 2
    ? items[0]
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

function closeFolder(folder, report) {
    const failed = report.findings.filter(f => f.level === 'fail');
    const named = failed.filter(f => f.label === 'imei' || f.label === 'environment');
    const inside = failed.filter(f => !named.includes(f));
    const missing = inside.filter(f => f.expected).map(f => f.expected);
    const wrong = inside.length - missing.length;

    /* The name is the folder's identity, so it is the first thing to be right
     * and the first thing to report on. */
    if (named.length) {
        rejectFolder(
            `${folder} is not a unit folder` +
            (inside.length ? `, and ${inside.length} of its files need attention`
                           : ''),
            `Rename it to ${FOLDER_SHAPE}` +
            (inside.length ? ', fix the rows above,' : '') +
            ` and pick it again with ${press(STEP.folder)}.`);
        return;
    }

    const counts = [];
    if (missing.length) counts.push(`${missing.length} file` +
                                    `${missing.length === 1 ? ' is' : 's are'} missing`);
    if (wrong) counts.push(`${wrong} needs fixing`);

    rejectFolder(
        `${folder} is the right folder — ${counts.join(', and ')}`,
        missing.length
            ? `Create ${list(missing)} inside it, then pick it again with ` +
              `${press(STEP.folder)}.`
            : `Fix the rows marked above, then pick it again with ` +
              `${press(STEP.folder)}.`);
}

async function readFolder(folder, files) {
    /* The profiles are here, so the list of countries we can provision is here
     * too — `folder-check.js` checks that region.txt holds two letters and asks
     * us whether they are two letters we know. */
    const report = await checkFolder(folder, files,
                                     { knownRegions: Object.keys(REGIONS) });
    reportFolder(report);

    if (!report.ok) {
        closeFolder(folder, report);
        return false;
    }

    const who = report.identity;
    const found = report.chosen;
    const bundle = {
        imei: who.imei,
        thing_name: `AIS01-CB-${who.imei}`,
        password: report.password,
        certificate: await found.certificate.text(),
        private_key: await found.private_key.text(),
        environment: who.environment,
        /* A two-letter country code read out of region.txt. ⓪ refuses a
         * folder whose code has no profile, so by here it is always a key of
         * `REGIONS`. */
        region: report.region,
        folder,
        /* Which files, by name, ended up being the ones used. Kept so the
         * screen can answer "where am I standing" without the technician
         * re-opening the folder to check. */
        files: {
            certificate: found.certificate.name,
            private_key: found.private_key.name,
            password: found.password.name,
        },
        /* Not in the folder and not per unit: where this environment's broker
         * is. The folder says which environment; the app knows the rest. */
        mqtt: { ...ENVIRONMENTS[who.environment] },
    };

    state.bundle = bundle;
    state.remembered = who;
    showLoaded(bundle);
    /* The checklist above already said the environment, the file names and
     * their sizes. This line only has to say the folder passed. */
    ok(`  ready — ${bundle.environment} → ${bundle.mqtt.endpoint}`);

    clearStageMarks();
    await reportPriorCerts(files);

    const problem = imeiMismatch(bundle);
    if (problem) fail(`WRONG UNIT — ${problem}`);
    return true;
}

/*
 * A new folder is a new unit, so nothing the last one earned may stay on screen.
 *
 * The marks describe the unit the folder points at. Carrying unit A's green ②
 * into unit B is the same class of mistake as writing A's material into B, only
 * cheaper to make — it takes one tap of the picker, and the chip that is wrong
 * is the one nobody re-reads because it is already green.
 *
 * ⓪ is not in the list: it is the folder itself, and `readFolder` has just set
 * it to this unit's IMEI.
 */
function clearStageMarks() {
    for (const stage of ['login', 'certs', 'network', 'config', 'verify']) {
        setMark(stage, '', 'weak');
    }
}

/*
 * What the folder already knows about this unit's certificates.
 *
 * `provisioning-log.jsonl` records every write with the modem's own `+QFUPL`
 * verdicts, and until now the app wrote it and never looked. So a unit written
 * yesterday — or written by the CLI over USB — came up with ② blank, and the
 * only way to find out was to spend an AT window discovering it was already
 * done.
 *
 * This reads the log the folder came with, so it works through the directory
 * handle and through the `webkitdirectory` fallback alike: the file is in
 * `files` either way, and no second permission is asked for.
 *
 * The mark is green because what backs it is evidence — checksums the MODEM
 * computed over what it stored — rather than anybody's say-so. `already
 * written` and not `3/3 ✓` all the same: this session verified nothing, and the
 * two states are worth telling apart on a screen where green is a promise.
 *
 * Only a `done` entry speaks. A failed or partial one leaves the mark blank,
 * which is honest — an attempt that did not finish tells you nothing about what
 * is in the modem, and ② is one tap away either way.
 */
async function reportPriorCerts(files) {
    const found = files.find(f => f.name === LOG_FILE);
    if (!found) return;

    let history;
    try {
        history = parseLog(await found.text());
    } catch (err) {
        note(`  could not read ${LOG_FILE} (${err.message})`);
        return;
    }

    const written = lastFor(history, CERTS_SUBSTEP);
    if (!written || written.status !== 'done') return;

    setMark('certs', 'already written', 'ok');
    write(`already written ${String(written.at).replace('T', ' ').slice(0, 16)}` +
          `, per ${LOG_FILE}`, 'ok', 'certificates');
    /* The modem's own verdicts, so the claim above can be checked rather than
     * believed. A date says somebody pressed a button. */
    for (const proof of written.evidence_refs || []) note(`    ${proof}`);
}

/*
 * The fallback picker, for a browser without `showDirectoryPicker`. It hands
 * over the files and nothing else — there is no handle to keep, so this path
 * cannot survive a reload and does not pretend to.
 */
async function loadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const folder = (files[0].webkitRelativePath || '').split('/')[0];
    if (!folder) {
        rejectFolder('that was a file, not a folder',
                     'Pick the FOLDER that came from Drive — its name carries ' +
                     'the IMEI, and no file inside it does.');
        return;
    }
    await loadFromFolder(folder, files);
}

/* ── Remembering the folder, never what is in it ─────────────────────────
 *
 * A bench session is one unit and many attempts, and each attempt was costing a
 * trip through the file picker for the same folder — twice, on 2026-08-04, at
 * the exact moment an AT window was open. That cost is real and this still pays
 * it off; what changed is WHAT gets kept to pay it.
 *
 * The first answer was the bundle itself, in `localStorage`, and it was chosen
 * against the only alternative then on the table: committing the material into
 * an app served from a public repository. Between those two it was the right
 * call. Two things were outside that frame:
 *
 *   · `localStorage` is scoped to an ORIGIN, not to an app. Every GitHub Pages
 *     project under the same account is the same origin, so the key was not
 *     kept "in this app" — it was readable by anything else published there.
 *   · `CreateKeysAndCertificate` returns a private key ONCE. The copy in that
 *     folder is not a cache that can be repopulated; it is the only copy.
 *
 * The third option did not exist yet, because it needs a folder on this
 * machine's own disk rather than a phone reaching into Drive: keep a REFERENCE
 * to the folder and re-read it. `FileSystemDirectoryHandle` is exactly that,
 * and it is storable in IndexedDB — see `handle-store.js` for why not
 * `localStorage`.
 *
 *     kept       the folder, and permission to open it again
 *     not kept   the certificate, the private key, the password
 *
 * So the picker trip is still avoided, and the material's lifetime is now the
 * page's. `FORGET` drops the reference as well, for when the bench moves on.
 */

/* The key the material used to live under. It is not merely unused now — it is
 * removed on sight, because a browser that ran an older version is still
 * holding a production unit's private key in it. */
const STORED_MATERIAL = 'ais01.provision.bundle';

/*
 * Delete it, and salvage the one part of it that was never a secret.
 *
 * The folder's name is not material — it is the IMEI and the environment, both
 * of which are printed on the unit. Keeping that much means a browser upgrading
 * into this version still knows which unit it was on, and asks for the folder
 * rather than for a decision.
 */
function purgeStoredMaterial() {
    let raw;
    try { raw = localStorage.getItem(STORED_MATERIAL); } catch { return null; }
    if (!raw) return null;

    try { localStorage.removeItem(STORED_MATERIAL); } catch { /* nothing to undo */ }
    fail('removed the certificate, private key and password this browser had ' +
         'stored from an earlier version');
    note('  material now lives only in this page, and only while it is open');

    let saved = null;
    try { saved = JSON.parse(raw); } catch { return null; }
    const folder = saved && saved.bundle && (saved.bundle.folder || saved.label);
    return folder ? identityOf(folder) : null;
}

function hasFolderApi() {
    return typeof window.showDirectoryPicker === 'function';
}

/*
 * A stored handle is not stored access.
 *
 * The browser tracks the permission separately and, on most reloads, drops it
 * back to `prompt`. Re-granting needs a user gesture, so this asks without one
 * first (`interactive: false`) and only escalates from the ⓪ tap — which is the
 * gesture, and which the operator was going to make anyway.
 *
 * `readwrite` rather than `read`, and not because anything is written yet: the
 * next thing this folder has to hold is what we configured on the unit, beside
 * the material it was configured from. Asking once for both is one prompt;
 * asking for read now and write later is two, and the second one lands in the
 * middle of a bench session.
 */
async function ensureAccess(handle, interactive) {
    const opts = { mode: 'readwrite' };
    if (!handle.queryPermission) return true;   /* older implementations */
    try {
        if (await handle.queryPermission(opts) === 'granted') return true;
        if (!interactive) return false;
        return await handle.requestPermission(opts) === 'granted';
    } catch {
        return false;
    }
}

/* Every file directly inside the folder. Subdirectories are not walked: the
 * material is flat, and `evidence/` is ours to write, not to read. */
async function filesIn(handle) {
    const files = [];
    for await (const entry of handle.values()) {
        if (entry.kind === 'file') files.push(await entry.getFile());
    }
    return files;
}

/*
 * Read the folder now, and keep the reference if the read was good. A folder
 * that fails to load is not remembered — the next reload should ask, not
 * re-present a mistake.
 */
async function openFolder(handle, remember) {
    let files;
    try {
        files = await filesIn(handle);
    } catch (err) {
        fail(`could not read ${handle.name}: ${err.message}`);
        you(`The folder may have been moved or renamed — choose it again with `
            + `${press(STEP.folder)}.`);
        await forgetFolder({ quiet: true });
        return false;
    }

    if (!await loadFromFolder(handle.name, files)) return false;

    state.handle = handle;
    if (remember) {
        try { await saveHandle(handle); } catch (err) {
            note(`could not remember this folder (${err.message}) — it will ` +
                 'need picking again after a reload');
        }
    }
    return true;
}

/*
 * ⓪. Three situations, one button.
 *
 * A folder that is remembered but locked needs its permission back, not a
 * second trip through the picker — that is the whole saving, and opening a
 * dialog to re-choose a folder the app already knows would give it away.
 */
async function chooseFolder() {
    if (!hasFolderApi()) { el('bundle-input').click(); return; }

    if (state.handle && !state.bundle) {
        if (await ensureAccess(state.handle, true)) {
            if (await openFolder(state.handle, false)) return;
        } else {
            note('permission was not granted — choosing the folder again');
        }
    }

    let handle;
    try {
        handle = await window.showDirectoryPicker(
            { id: 'ais01-device-folder', mode: 'readwrite' });
    } catch (err) {
        if (err && err.name === 'AbortError') return;   /* picker dismissed */
        fail(`could not open a folder: ${err.message}`);
        return;
    }
    await openFolder(handle, true);
}

/*
 * Ask before doing something whose effect cannot be seen.
 *
 * Resolves true only on the confirm button. Escape, the backdrop and Cancel
 * all close the dialog with a different `returnValue`, which is why there is
 * no per-button wiring here — the form does it.
 *
 * `lines` are plain strings, set with textContent: one of them is a folder
 * name somebody else chose.
 */
function askConfirm({ title, lines, subject = null, commands = null,
                      confirmLabel = 'Confirm' }) {
    const dialog = el('confirm-dialog');
    el('confirm-title').textContent = title;
    el('confirm-ok').textContent = confirmLabel;

    /* Description first, then the subject — the platform's FeedbackAlert puts
     * its `note` under the prose, and the order is the point: the sentence
     * says what is about to happen, the name says what it happens to. */
    const body = el('confirm-body');
    body.textContent = '';
    for (const line of lines) {
        const p = document.createElement('p');
        p.textContent = line;
        body.appendChild(p);
    }
    /*
     * The `customContent` slot, and the one thing that goes in it: the exact
     * lines that are about to leave.
     *
     * `textContent` per row, never a joined string into innerHTML — these are
     * built from a folder's own contents (the endpoint, the thing name, the
     * topics), and a dialog that renders them as markup is a folder name
     * deciding what this page executes.
     */
    if (commands && commands.length) {
        const list = document.createElement('ol');
        list.className = 'cmd-list';
        for (const cmd of commands) {
            const li = document.createElement('li');
            li.textContent = cmd;
            list.appendChild(li);
        }
        body.appendChild(list);
    }
    if (subject) {
        const it = document.createElement('p');
        it.className = 'subject';
        it.textContent = subject;
        body.appendChild(it);
    }

    return new Promise(resolve => {
        const onClose = () => {
            dialog.removeEventListener('close', onClose);
            resolve(dialog.returnValue === 'ok');
        };
        dialog.addEventListener('close', onClose);
        dialog.returnValue = '';
        dialog.showModal();
    });
}

/*
 * The confirmed half of CHANGE UNIT FOLDER.
 *
 * It was CHANGE UNIT, which is the moment it is used but not the thing it
 * does. On a bar whose other control says PAIR DEVICE VIA BLE, "unit" reads as
 * the one on the other end of the radio — and this touches none of that. It
 * lets go of a folder.
 *
 * Nothing here is destructive: the folder on disk is untouched, the device
 * hears nothing, the link stays up. That is exactly why it is worth asking
 * about — a control whose entire effect is invisible is the one pressed
 * without knowing what was pressed.
 */
async function changeUnit() {
    /* A folder can be held three ways: its material loaded, its identity
     * remembered from a previous session, or a handle whose permission has not
     * been granted back yet. Any of them is something to let go of. */
    const standing = state.bundle || state.remembered;
    const folder = (standing && standing.folder)
        || (state.handle && state.handle.name)
        || null;

    if (!folder) {
        /*
         * Nothing is held in this session — but "held" and "remembered" are
         * not the same thing, and this branch used to treat them as one.
         *
         * `rejectFolder` nulls all three of the above, so a folder that was
         * picked and refused lands here with ⓪ still marked `rejected` and
         * the name still on screen. Clearing that residue is right and needs
         * no question: it is what the technician just asked for.
         *
         * What it must not do silently is what `forgetFolder` ALSO does —
         * `clearHandle()`, which drops the folder this browser remembered
         * from an earlier session. That folder is not on screen, so its loss
         * is invisible, which is the whole reason this control asks before
         * acting. Refusing one folder is not a decision about the last good
         * one, and the next reload is where the difference shows up.
         */
        const remembered = await rememberedFolder();
        if (remembered) {
            const confirmed = await askConfirm({
                title: 'Forget the remembered folder?',
                subject: remembered,
                lines: [
                    'Nothing is open right now, but this browser can still ' +
                    're-open that folder without the picker. Select ' +
                    'provisioning folder would ask from scratch instead, ' +
                    'here and after every reload.',
                ],
                confirmLabel: 'Forget folder',
            });
            if (!confirmed) { note(`still remembering ${remembered}`); return; }
        }
        await forgetFolder({ quiet: true });
        note(`no folder is held — ${press(STEP.folder)} is ready for the next one`);
        return;
    }

    /*
     * One question and one sentence.
     *
     * This asked three paragraphs' worth: that the disk is untouched, that
     * nothing is sent, that the link stays up, that the log stays. All true,
     * and all of it reassurance about things the control never threatened —
     * which is what a wall of text in a confirm actually communicates: that
     * something here is worth being afraid of. Nothing is. The one fact worth
     * a reader's time is what STOPS being true, and that is a single line.
     *
     * The title said "change unit folder", which is what the button is called
     * and not what this does. Nothing here changes a unit or a folder; it
     * lets go of the one this screen is pointed at, and ⓪ is what points it
     * somewhere new. Naming the effect is the whole job of the question.
     */
    const confirmed = await askConfirm({
        title: 'Clear the selected folder?',
        subject: folder,
        lines: [
            'Select provisioning folder will ask for a new one. Nothing is ' +
            'sent to the unit and the folder on your disk is not touched.',
        ],
        confirmLabel: 'Clear folder',
    });
    if (!confirmed) { note(`still on ${folder}`); return; }
    await forgetFolder();
}

/*
 * The folder this browser remembers, by name, or null.
 *
 * Read rather than assumed: `state.handle` is only set once a folder has
 * LOADED, so between a refused pick and a reload the stored handle is a thing
 * the session knows nothing about — which is exactly when it must not be
 * thrown away without asking.
 */
async function rememberedFolder() {
    if (!hasFolderApi()) return null;
    try {
        const handle = await loadHandle();
        return (handle && handle.name) || null;
    } catch {
        return null;   /* no memory to lose */
    }
}

async function forgetFolder({ quiet = false } = {}) {
    try { await clearHandle(); } catch { /* nothing to undo */ }
    try { localStorage.removeItem(STORED_MATERIAL); } catch { /* idem */ }
    state.bundle = null;
    state.handle = null;
    state.remembered = null;
    el('imei').textContent = '—';
    showRegion(null);
    el('btn-bundle').title = '';
    setMark('bundle', '', 'weak');
    if (!quiet) note(`let go of that folder — open the next one with `
                     + `${press(STEP.folder)}`);
}

/*
 * On load: say which unit, ask for the folder.
 *
 * When the permission survived, the material is back with nothing pressed and
 * the screen looks exactly as it did before the reload. When it did not — the
 * usual case — the unit is named in amber and ⓪ is one tap away. What never
 * happens again is the screen showing a green IMEI over material that came out
 * of storage rather than off the disk.
 */
async function restoreFolder() {
    const salvaged = purgeStoredMaterial();

    let handle = null;
    if (hasFolderApi()) {
        try { handle = await loadHandle(); } catch { /* no memory, no harm */ }
    }

    if (!handle) {
        if (salvaged) {
            state.remembered = salvaged;
            markUnit();
            you(`this browser was last on ${salvaged.imei} — open its folder ` +
                `with ${press(STEP.folder)} (${salvaged.folder}).`);
        } else {
            you(`Tap ${press(STEP.folder)} and choose the unit's folder — the one `
                + `downloaded from Drive.`);
        }
        return;
    }

    state.handle = handle;
    state.remembered = identityOf(handle.name) || salvaged;
    markUnit();

    if (await ensureAccess(handle, false)) {
        await openFolder(handle, false);
        return;
    }
    you(`${handle.name} is remembered — tap ${press(STEP.folder)} to open it `
        + `again.`);
    note('  only the folder is remembered; the certificate, the key and the ' +
         'password are read from disk each session and kept nowhere else');
}

/* ── The record, back in the unit's folder ───────────────────────────────
 *
 * Best-effort, always. A stage is talking to a device on a window that costs
 * a reset to reopen; a folder that has gone read-only since it was picked is
 * a thing to mention, never a thing to fail a write over. Every call here
 * reports in the terminal and returns.
 */
function canRecord() {
    return !!(state.handle && state.bundle);
}

async function record(fields) {
    if (!canRecord()) return;
    const entry = logEntry({ imei: state.bundle.imei, version: VERSION, ...fields });
    try {
        await appendLog(state.handle, entry);
        note(`  recorded in ${LOG_FILE}`);
    } catch (err) {
        note(`  could not write ${LOG_FILE} (${err.message}) — the folder may ` +
             `need re-opening with ${press(STEP.folder)}; nothing about the ` +
             `device changed`);
    }
}

async function recordSettings(applied) {
    if (!canRecord() || !applied.length) return;
    try {
        await saveIntendedConfig(state.handle, applied);
        note(`  ${applied.length} setting(s) merged into ${CONFIG_FILE}`);
    } catch (err) {
        note(`  could not update ${CONFIG_FILE} (${err.message})`);
    }
}

/*
 * The link is missing. Say which of the two ways, and what to do about it.
 *
 * Four controls used to answer this with `not connected`, and ① with
 * `not connected: Nothing to reconnect to` — the transport's own words for its
 * own internal state, printed at a person holding a phone and a board. Accurate,
 * and it answers none of the three questions they actually have: what happened,
 * whether they broke it, and what to press.
 *
 * Two different situations were also sharing that one sentence, and their next
 * actions are opposites:
 *
 *     no unit has ever been paired    press something
 *     the link dropped, as it does    wait, it comes back on its own
 *
 * The second is not a fault at all. The BT24 gives up after about sixty seconds
 * idle and the unit goes away at the end of every duty cycle, so a dropped link
 * is the normal resting state of this screen — and telling somebody it is an
 * error is how they end up re-pairing a unit that was about to re-attach by
 * itself.
 *
 * The button is named in full, exactly as it reads on screen, because "pair the
 * device" and "PAIR DEVICE VIA BLE" cost a person one more look at the bar.
 */
function needLink() {
    if (link.isConnected()) return true;

    const name = link.deviceName();
    if (!name) {
        fail('Device not connected yet.');
        you('Tap PAIR DEVICE VIA BLE at the top to choose the unit, then try ' +
            'again.');
        /*
         * The one thing that looks like a broken unit and is not.
         *
         * The BT24 only advertises while the unit is awake, so a unit that has
         * finished its cycle is invisible to the chooser — an empty scan list
         * next to a board with a light on it. Without this line the reading is
         * "the Bluetooth is dead"; with it, it is one press of a button that is
         * already under their thumb.
         */
        note('  If the unit is not in the scan list, press its RESET — it only ' +
             'advertises over BLE while it is awake.');
        return false;
    }

    fail(`${name} is not connected right now.`);
    you(link.isHunting()
        ? 'The app is re-attaching on its own and the link comes back when the ' +
          'unit next wakes. Press the board\'s RESET to start a cycle now.'
        : 'Press the board\'s RESET to wake the unit, or tap PAIR DEVICE VIA BLE.');
    return false;
}

/* Refuse to write anything without material that matches this unit. */
function bundleReady() {
    if (!state.bundle) {
        fail(`No unit folder loaded — tap ${press(STEP.folder)} first.`);
        return false;
    }
    if (!needLink()) return false;
    const problem = imeiMismatch(state.bundle);
    if (problem) { fail(`refusing to write — ${problem}`); return false; }
    return true;
}

/* ── Actions ─────────────────────────────────────────────────────────── */

/*
 * Attach, and keep attaching.
 *
 * Called with no gesture when the page loads and there is a granted unit to
 * adopt, and from the pair button the one time there is not. There is nothing
 * to press afterwards: the link comes and goes with the duty cycle, which is
 * the device's business and not a decision anyone needs to confirm.
 *
 * A disconnect button was in the way of that. It offered to break the one thing
 * the app spends its effort keeping, and the only thing it was ever used for
 * was as a place to press when the link was already down.
 */
async function doConnect(fromTap = false) {
    if (!state.mock && !hasBluetooth()) {
        if (fromTap) fail('This browser has no Web Bluetooth. On iOS use Bluefy.');
        return;
    }
    if (link.isConnected() || link.isHunting()) return;

    /*
     * Pairing opens a section like every stage that reports something.
     *
     * Its lines — `re-adopted …`, `paired with …`, `link connected` — were
     * landing loose in the History between whatever came before and whatever
     * came after, which is the same complaint that got ⓪ its own section: the
     * eye has to work out where the attempt started and stopped.
     *
     * It carries no number. The numbered sections are the things this app does
     * TO a unit, in the order `firmware-factory/stages.json` puts them, and
     * pairing is not one of them — it is what makes a unit reachable at all.
     * Renumbering ①–⑤ to fit it in would move six labels, every glyph in this
     * file's comments, and the sequence the operator already has in their head,
     * to say something the section's position already says.
     *
     * `endPhase` drops it when nothing was logged, which is the normal outcome
     * of the automatic attempt on load.
     */
    const phase = startPhase(STEP.ble);
    try {
        /* Redact for the screen only — the collectors that decide whether a
         * write landed must still see the real bytes. */
        /* The boundary is drawn before the line that announced it. */
        const onLine = line => { watchBoot(line); write(redact(line)); feed(line); };
        const onChunk = (text, dir) => rawAppend(text, dir);
        const onDiag = text => note(text);
        const handlers = { onLine, onChunk, onDiag, onStatus: setLink };

        /* A unit already granted to this origin needs no picker, and after a
         * reload that is every unit we have been talking to. The bundle's IMEI
         * decides which one, so a bench with several cannot adopt the wrong
         * one; with no bundle it only adopts when there is a single choice. */
        let name = null;
        try {
            name = await link.adopt(handlers, expectedImei());
            if (name) note(`re-adopted ${name} — no picker`);
        } catch (err) {
            /* Every failure here falls through to the picker, which is what
             * this button did before adoption existed. A shortcut that can turn
             * into a dead end is worse than no shortcut: this one can only save
             * a tap or cost nothing. */
            note(`adoption failed (${err.message}) — falling back to the picker`);
        }

        /*
         * The picker is the one call the browser refuses outside a user
         * gesture, so the automatic path stops here rather than throwing a
         * SecurityError at a page that just loaded. Nothing to adopt means the
         * pair button, which is exactly the gesture it is asking for.
         */
        if (!name && !fromTap) return;
        if (!name) name = await link.connect(handlers);

        if (name === null) { note('scan dismissed'); return; }
        note(`paired with ${name}`);
        if (state.bundle) {
            const problem = imeiMismatch(state.bundle);
            if (problem) fail(`WRONG UNIT — ${problem}`);
        } else if (state.remembered && !name.includes(state.remembered.imei)) {
            /* No material to refuse yet, so this is a heads-up rather than a
             * guard: the folder about to be opened is the last one, and it is
             * not this unit's. */
            you(`this is not the unit this browser was last on ` +
                `(${state.remembered.imei}) — open ${name}'s own folder with ` +
                `${press(STEP.folder)}`);
        }
    } catch (err) {
        fail(`connect failed: ${err.message}`);
    } finally {
        /* `finally`, not the end of the try: the body returns early on both the
         * "nothing to adopt" and the "scan dismissed" paths, and a section left
         * open would take the next stage's failures as its own. */
        endPhase(phase);
    }
}

async function doLogin() {
    if (!state.bundle) {
        fail('No unit folder loaded — the password is in it.');
        you(`Tap ${press(STEP.folder)}, choose the unit's folder, then try again.`);
        return;
    }
    if (!link.isConnected()) {
        /* An idle drop is normal on BT24; try the same device before giving up. */
        try { await link.reconnect(); } catch (err) {
            needLink();
            /* The transport's own words, kept and put out of the way. They
             * describe a GATT failure nobody can act on, and they are only
             * worth printing at all when there WAS a device to re-attach to —
             * otherwise "Nothing to reconnect to" is just the line above
             * restated in a language the operator does not speak. */
            if (link.deviceName()) note(`  (re-attach failed: ${err.message})`);
            return;
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
 * The login mark dies with the session, because that is what a login IS here.
 *
 * The console asks for the password once per cycle. `ATZ` reboots the STM32, so
 * the moment this app sends one the session it had is gone — and ① went on
 * reading `correct` in green over a console that would now refuse every line.
 * That is the mark claiming something no longer true, which is worse than
 * claiming nothing: the operator's next tap is ② or ④, and the first symptom of
 * a dead session is a stage that does nothing for thirty seconds.
 *
 * Blank rather than red. Red is a failure and this is not one — a restart is
 * something we asked for. Blank says exactly what is the case: nobody has
 * logged into THIS session yet.
 *
 * ONLY ① is cleared. Certificates live in the modem's flash and a reset does
 * not touch them, and whether ③ and ④'s settings survive a reboot is precisely
 * the question a reset exists to answer — wiping those marks would erase the
 * before half of the comparison.
 *
 * Called from `divider` for the boundaries that restart the CONSOLE — our own
 * reset and the firmware's next boot — and from ② , whose closing `ATZ` draws
 * no divider of its own. See `ENDS_SESSION`: the modem powering off is not one
 * of them, and treating it as one cleared a login that was still good.
 *
 * That means a stage mark reacts to the device stream, which is worth naming
 * because spec 004 spends a section refusing to do it. What it refuses is
 * inferring device PHASE in order to GATE the buttons; nothing here is gated,
 * and the line this leans on is already parsed a few lines up to draw the
 * divider. The claim being made is the narrow one: a login does not survive a
 * restart of the thing that authenticated it. It retires a claim rather than
 * making one.
 *
 * Still not covered: the ~50 s idle timeout, which ends a session with no line
 * printed at all until the next command is refused. The mark can be stale
 * there, and it is stale in one direction only.
 */
function sessionEnded() {
    if (!stageState.login || stageState.login === 'pending') return;
    setMark('login', '', 'weak');
    note(`${press(STEP.login)} cleared — the console asks for the password `
         + `again after a restart`);
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
 * Reading the dump used to live on this button, on the branch where no folder
 * was loaded. It is `AT+CFG` in the command picker now, where it can be sent at
 * any point rather than only before a folder is chosen — which was the one time
 * it was least useful.
 */

/*
 * ── The two halves of the configuration ─────────────────────────────────
 *
 * `firmware-factory/scripts/` splits this in two and the app had merged them
 * back into one button labelled "network and MQTT". Reading the two scripts
 * says why that label was wrong rather than merely coarse:
 *
 *     configure-network.py (4A)      APN, CSQTIME, IOTMOD, QCOPS
 *     configure-mqtt.py    (4B)      PRO, SERVADDR, PUB/SUBTOPIC, CLIENT,
 *                                    TLSMOD, MQOS, SNI, TDC, BKDNS
 *
 * The app sent all ten of 4B and none of the four of 4A. It never configured
 * the network at all — a unit that attached did so on whatever its firmware
 * already had.
 *
 * The two are different in kind, not just in name. 4B is derived from facts the
 * folder carries: the IMEI makes the topics, the environment makes the broker.
 * 4A is derived from the SIM the unit will sit beside, which no file in the
 * folder knows about — hence the region in the folder's name.
 */

/*
 * Source: `firmware-factory/docs/golden-config.md`. The two values that differ
 * between profiles are the two that decide whether the modem attaches.
 *
 * This is the whole list of countries this app can provision, and it is short
 * because the document only records these two. ADDING ONE IS NOT A GUESS: a
 * new market needs its APN and its IOTMOD established against a real SIM and
 * written down there first, and then copied here. An APN invented for a country
 * produces a unit that never attaches and a failure that reads as broken
 * hardware — which is exactly the diagnosis this app is built to avoid handing
 * anyone.
 *
 * ⓪ refuses a region.txt naming a country that is not here, rather than loading
 * the folder and leaving ③ with nothing to send.
 */
const REGIONS = {
    AR: {
        /* Two fields rather than one string: the bar prints the country on its
         * own, and splitting a label back apart to get it is how a display
         * starts depending on a separator nobody promised. */
        country: 'Argentina',
        carrier: 'EMnify',
        settings: [
            ['AT+APN', 'em'],
            ['AT+CSQTIME', '1'],
            ['AT+IOTMOD', '0'],      /* eMTC */
            ['AT+QCOPS', 'NULL'],    /* let the multi-IMSI SIM choose */
        ],
    },
    BR: {
        country: 'Brazil',
        carrier: 'Vivo',
        settings: [
            ['AT+APN', 'NULL'],
            ['AT+CSQTIME', '1'],
            ['AT+IOTMOD', '2'],      /* eMTC + NB-IoT */
            ['AT+QCOPS', 'NULL'],
        ],
    },
};

/* The country and the network it sits on, in the one order they are said. */
const regionLabel = code => REGIONS[code]
    ? `${REGIONS[code].country} · ${REGIONS[code].carrier}` : code;

/* Refuses rather than defaulting. Picking a region on the operator's behalf is
 * how a BR unit gets an EMnify APN and never attaches — and the failure looks
 * like bad hardware, not like a guess this code made. */
function networkSettings(bundle) {
    const profile = REGIONS[bundle.region];
    if (!profile) {
        /* ⓪ refuses these, so reaching here means the profile table changed
         * under a folder that was already loaded. */
        const known = Object.entries(REGIONS)
            .map(([code]) => `${code} (${regionLabel(code)})`).join(', ');
        throw new Error(
            `no network profile for ${bundle.region} — this app can send ${known}`);
    }
    return profile.settings;
}

/*
 * Settings this unit must end up with. Two of them are law: SNI=1 breaks the
 * MQTT CONNECT silently, and MQOS must be 0. They are sent even when the dump
 * already shows them correct — a silent-failure setting is not worth a
 * conditional.
 */
function desiredSettings(bundle) {
    const mqtt = bundle.mqtt || {};
    if (!mqtt.endpoint) throw new Error('no endpoint — the folder name did not say which environment');
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

/*
 * How often this console will take a line — one number, three callers.
 *
 * The device has ONE 300-byte console line buffer and no queue
 * (`console-line-law.js`): the RX handler fills it, the main loop dispatches it,
 * then zeroes it, and anything that arrives in between is discarded outright.
 * So the rate a sender may use is set by how often that loop comes round, and
 * nothing else — not the baud rate, not the length of the line.
 *
 * The number is ② 's, measured rather than chosen: counting which upload parts
 * survived put the acceptance period at about 2.1 s, and the long note in
 * `doCerts` is the whole derivation.
 *
 * ③ and ④ sent at 350 ms and were losing lines to exactly this. On 2026-08-09
 * four network settings went out inside one second and the device answered
 * ONE `OK` — one line dispatched, three overwritten in a buffer that had not
 * been emptied yet. The stage then reported `0/4` and the operator was left
 * being told that settings had not persisted, when three of them had never
 * been executed at all.
 *
 * These commands are answered by the app rather than forwarded to the modem, so
 * their dispatch may well be cheaper than an upload part's — but that is a
 * guess, and the two errors are not symmetric. Sending early loses the line in
 * silence; sending late costs seconds.
 */
const CONSOLE_LINE_MS = 2500;

/*
 * The two config stages differ in two strings and one function. Everything
 * else — confirm, apply, count, record — is identical, and writing it twice
 * is how the second copy quietly stops matching the first.
 */
const CONFIG_STAGES = {
    network: {
        mark: 'network',
        /* What this half configures, for the command menu's heading. Short
         * because it follows `This unit · `, and a heading that repeats the
         * whole button name is a heading nobody finishes reading. */
        menuGroup: 'cellular network',
        substep: 'network_settings_set',
        settings: bundle => networkSettings(bundle),
    },
    mqtt: {
        mark: 'config',
        menuGroup: 'MQTT broker',
        substep: 'mqtt_settings_set',
        settings: bundle => desiredSettings(bundle),
    },
};

/*
 * Read them, then send them — in one press instead of two.
 *
 * The pause before these lines leave is not negotiable: they are the settings
 * the unit is judged by, and an APN or an endpoint that is wrong is a truck
 * roll. What was negotiable is where the pause happens.
 *
 * It used to be an ARMED BUTTON. The first tap printed the commands into the
 * History and relabelled the chip `Send 4 network settings` in amber; the
 * second tap sent them. Three things were wrong with it, and none of them is
 * the idea:
 *
 *   · Nothing on screen said a second tap was owed. A chip that changes its
 *     own label is the app answering a question the technician did not know
 *     they had asked, and "I press it and nothing goes out" is what that
 *     feels like from the other side.
 *   · The commands landed in the LOG, which is the record of what happened —
 *     so the log claimed a send that had not occurred, above the send that
 *     eventually did.
 *   · The staged state outlived the screen: arm ③, walk away, come back, and
 *     the next tap sends lines chosen for a folder that may since have been
 *     cleared.
 *
 * A dialog is the same pause with none of that. It says what will go out,
 * verbatim and in order, it cannot be dismissed by accident, and it holds no
 * state after it closes.
 */
async function runConfigStage(key) {
    if (!bundleReady()) return;
    const spec = CONFIG_STAGES[key];
    let wanted;
    try { wanted = spec.settings(state.bundle); } catch (err) {
        fail(err.message); setMark(spec.mark, 'no region', 'fail'); return;
    }

    const lines = wanted.map(([name, value]) => `${name}=${value}`);
    const seconds = Math.round(
        (lines.length * CONSOLE_LINE_MS + REPLY_DRAIN_MS) / 1000);

    const confirmed = await askConfirm({
        title: `Send ${lines.length} ${spec.menuGroup} settings?`,
        lines: [
            `They go to the modem one line at a time — about ${seconds} s. ` +
            `Nothing leaves this screen until you confirm.`,
        ],
        commands: lines,
        confirmLabel: 'Send settings',
    });
    if (!confirmed) { note(`nothing sent — the unit is as it was`); return; }

    /* Set here and read by `applyConfig`, which is the only reader. It is
     * assigned one line before it is used rather than held between taps: the
     * whole defect in the armed button was that this survived the moment it
     * was chosen for. */
    state.pending[key] = lines;
    await applyConfig(key);
}

/*
 * A bare `OK` on a line of its own — never `\bOK\b` anywhere in one.
 *
 * The word test was matching device chatter, and this stream is never quiet:
 * the firmware's own messages arrive in the middle of the exchange. Crediting a
 * setting because the word appeared inside one of them is the same class of
 * mistake as missing the answer entirely, in the direction nobody checks.
 */
const ANSWERED = /^\s*OK\s*$/;
const REFUSED = /ERROR/i;

/* After the last line, the stream is still carrying its answer. */
const REPLY_DRAIN_MS = 1200;

/*
 * Send them on a clock, and read the answers off the stream afterwards.
 *
 * Gating each send on the previous answer would be the stronger design — an
 * `OK` in hand proves the console buffer has been dispatched and zeroed, which
 * is the only thing this pacing is trying to establish. It is the wrong design
 * for THIS stream. These commands go out while the firmware is talking: boot
 * lines, `Signal Strength`, upload notices. A bare `OK` inside that traffic is
 * missed easily, and a sender that waits for a confirmation it failed to
 * recognise stalls the whole stage on a line that did in fact arrive.
 *
 * So the clock paces the sends, and the stream is sliced by that same clock:
 * every line is filed under whichever command was in flight when it arrived.
 * ONE collector spans the stage rather than one per command — sequential
 * collectors lose whatever lands between them, which is the bug that cost
 * 2026-08-04 and it is not worth reintroducing here.
 *
 * The residual is named rather than hidden: an answer that arrives more than a
 * slot late is credited to the following command. With `CONSOLE_LINE_MS` of
 * spacing that is unlikely, it cannot turn silence into a pass, and it is
 * exactly why nothing below treats a missing answer as a refusal.
 */
async function applyConfig(key) {
    if (!bundleReady()) return;
    /*
     * These stages used to be over in a couple of seconds and now hold the
     * console for ten to thirty, which is long enough for a second tap to be a
     * reasonable thing for a person to do. Two senders on one 300-byte buffer
     * lose each other's lines, so the second one waits — the same guard ②
     * already keeps, for the same reason and not because of anything the device
     * is doing.
     */
    if (state.busy) { note('a stage is already running'); return; }
    const spec = CONFIG_STAGES[key];
    const deltas = state.pending[key] || [];

    /* One bucket per command, filled while that command is the one in flight. */
    const heard = deltas.map(() => []);
    let inFlight = -1;
    const collector = { lines: [], each: line => {
        if (inFlight >= 0) heard[inFlight].push(line);
    } };
    collectors.add(collector);

    const seconds = Math.round(
        (deltas.length * CONSOLE_LINE_MS + REPLY_DRAIN_MS) / 1000);
    note(`sending ${deltas.length} lines, one every ${CONSOLE_LINE_MS / 1000} s ` +
         `— about ${seconds} s. The console takes one line at a time.`);
    setMark(spec.mark, `0/${deltas.length}`, 'run');

    state.busy = true;
    try {
        for (const [i, cmd] of deltas.entries()) {
            write(cmd, 'tx');
            /* Set before the send: a prompt answer belongs to this command's
             * bucket, not to the one that has just stopped being in flight. */
            inFlight = i;
            await link.sendLine(cmd);
            setMark(spec.mark, `${i + 1}/${deltas.length} sent`, 'run');
            await sleep(CONSOLE_LINE_MS);
        }
        /* The last command's slot ended with the loop, so its answer gets the
         * drain — the same gap `certmod.js` leaves after every exchange. */
        await sleep(REPLY_DRAIN_MS);
    } finally {
        collectors.delete(collector);
        /* Released before the record below, like ② does: writing a file is not
         * part of the device conversation and must not hold the console shut. */
        state.busy = false;
    }

    /*
     * Three verdicts, not two. `silent` is the one the old code did not have:
     * it counted anything that was not an `OK` as a failure, so a stage whose
     * answers it had simply not waited long enough to hear closed as `0/4` —
     * which reads as "the settings did not take" and is a claim nobody made.
     */
    const verdicts = deltas.map((_, i) =>
        heard[i].some(l => REFUSED.test(l)) ? 'refused'
        : heard[i].some(l => ANSWERED.test(l)) ? 'ok'
        : 'silent');

    for (const [i, cmd] of deltas.entries()) {
        if (verdicts[i] === 'refused') fail(`  ${cmd} → ERROR`);
        else if (verdicts[i] === 'silent') note(`  ${cmd} → no answer in its slot`);
    }

    const tally = what => verdicts.filter(v => v === what).length;
    const okN = tally('ok');
    const refusedN = tally('refused');
    const silentN = tally('silent');

    /*
     * Amber even at 4/4. An answer means the command parsed, not that the
     * setting survives a reboot — only re-reading `AT+CFG` after a reset proves
     * that, and this app does not get to claim it on the device's behalf.
     *
     * Red is kept for a device that actually said no. Silence is not a no.
     */
    setMark(spec.mark, `${okN}/${deltas.length} OK`, refusedN ? 'fail' : 'weak');
    note(`${okN} of ${deltas.length} answered OK` +
         (refusedN ? `, ${refusedN} returned ERROR` : '') +
         (silentN ? `, ${silentN} did not answer in their slot` : ''));
    note('An answer is the command parsing, not the setting surviving a reboot.');
    if (silentN) {
        note('No answer is not a refusal: the line may not have been dispatched, ' +
             'or its OK may have landed a slot late.');
    }
    you('Send AT+CFG after a reset to read back what the unit actually holds — ' +
        'it is in the command menu, and it is the only thing that settles this.');

    state.pending[key] = null;

    /*
     * Everything the device did not REFUSE goes into `intended-config.json`.
     *
     * It used to be only what answered `OK`, on the rule that a setting the
     * device rejected is not what the unit is meant to have. The rule is right;
     * the implementation lumped silence in with refusal, so a stage whose
     * answers were merely unheard wrote nothing at all. The file is named
     * `intended` — it is the standing answer to "what is this unit meant to
     * have". What was OBSERVED is the log entry below, verdict by verdict.
     */
    const applied = deltas
        .filter((_, i) => verdicts[i] !== 'refused')
        /* First `=` only: values carry their own, as in `SERVADDR=host,8883`. */
        .map(cmd => [cmd.slice(0, cmd.indexOf('=')),
                     cmd.slice(cmd.indexOf('=') + 1)]);

    await recordSettings(applied);
    await record({
        stage: STAGES.config,
        substep: spec.substep,
        status: refusedN ? 'failed' : okN === deltas.length ? 'done' : 'partial',
        summary: `${deltas.length} sent, ${okN} answered OK, ${refusedN} refused, ` +
                 `${silentN} unanswered. An answer is the command parsing, not ` +
                 'the setting surviving a reboot, and an unanswered line is not ' +
                 'a refusal — only re-reading AT+CFG after a reset proves either.',
        evidence: deltas.map((cmd, i) => `${cmd} → ${verdicts[i]}`),
    });
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
/* The one substep the log is asked about. It is the string `record()` writes,
 * so the question and the answer cannot drift apart. */
const CERTS_SUBSTEP = 'certificates_written';

/*
 * Has this unit's folder already recorded a successful certificate write?
 *
 * Read from disk at the moment ② is tapped rather than cached when the folder
 * was opened, because the folder is shared: the CLI writes this same file, and
 * so does the same folder opened on another machine. A cached answer is a
 * stale answer, and one small file read costs nothing against a stage that
 * runs for two and a half minutes.
 *
 * Every failure here answers "no". A log that cannot be read is not evidence
 * that the work was done, and the cost of being wrong in that direction is one
 * extra dialog — against writing over a good unit's certificates on the
 * strength of a file that would not open.
 */
async function priorCertWrite() {
    if (!state.handle) return null;
    try {
        const last = lastFor(await readLog(state.handle), CERTS_SUBSTEP);
        return last && last.status === 'done' ? last : null;
    } catch {
        return null;
    }
}

/*
 * Where the unit is in its cycle, as one sentence for the dialog.
 *
 * `lastDivider` is the last boundary this screen actually drew, which is read
 * off lines the device printed — so this reports an observation rather than a
 * belief. It is in a dialog and gates nothing: the operator can proceed from
 * any of these readings, and on a unit that has been quiet since the page
 * loaded there is no reading to give at all.
 */
function cycleReading() {
    if (lastDivider === 'end') {
        return 'The modem is powered off and the console is still answering. ' +
               'This is the moment.';
    }
    if (lastDivider === 'wake') {
        return 'The unit is AWAKE and its cycle is running. Wait for ' +
               '"NB module power-off successful."';
    }
    if (lastDivider === 'reset') {
        return 'A RESET was just sent. Wait for the cycle to run and the ' +
               'modem to power off.';
    }
    return 'No cycle boundary has gone past since this screen opened, so ' +
           'nothing here can say whether the unit is idle.';
}

/*
 * Ask before ②, and ask differently depending on what the folder already knows.
 *
 * Both cases exist for the same reason and it is not caution for its own sake.
 * This stage costs an AT window, and an AT window costs a boot and sixteen
 * seconds of waiting — so the expensive mistake is not a bad write, which the
 * checksum gate catches, it is starting at the wrong moment and finding out two
 * minutes later. The dialog is the one place that can say WHEN, and it is worth
 * a tap because the alternative is reading `certmod.js`.
 */
/*
 * It goes out through `askConfirm`, which is the platform's `FeedbackAlert`
 * rebuilt on this page — one icon, one question, a line of prose, two buttons.
 * That component sets the length: it has ONE description slot at 16px, and an
 * alert with five paragraphs in it has stopped being an alert and become a
 * page nobody reads before pressing the green button.
 *
 * So three short paragraphs at most, and the detail goes where detail belongs.
 * The recorded proof is printed into the log first — it is a list of checksums,
 * which is a thing to read rather than a thing to be asked about — and the
 * alert carries the question and the timing.
 */
async function confirmCerts(previous) {
    if (previous) {
        /* The modem's own `+QFUPL` verdicts from that run. The date says
         * somebody pressed the button; only these say what it stored. */
        note(`this folder already records a certificate write on ${previous.at}:`);
        for (const proof of previous.evidence_refs || []) note(`  ${proof}`);

        return askConfirm({
            title: 'Write them again?',
            subject: `${state.bundle.imei} — written ` +
                     `${String(previous.at).replace('T', ' ').slice(0, 16)}`,
            lines: [
                `${LOG_FILE} in this unit's folder already records a ` +
                'successful write. Its checksums are in the log behind this.',
                'Retrying is safe — every attempt deletes the modem\'s slot ' +
                'before it uploads — but it costs an AT window.',
                cycleReading(),
            ],
            confirmLabel: 'Write them again',
        });
    }

    return askConfirm({
        title: 'Write certificates now?',
        subject: state.bundle.imei,
        lines: [
            'Three files go into the modem, each accepted only when the modem ' +
            'echoes back a checksum over what it stored. It runs about two and ' +
            'a half minutes on its own.',
            'Start it while the unit is idle: writing during a cycle takes the ' +
            'modem away mid-upload, and that reads as a dead device rather ' +
            'than as bad timing.',
            cycleReading(),
        ],
        confirmLabel: 'Write certificates',
    });
}

async function doCerts() {
    if (!bundleReady()) return;
    if (state.busy) { note('a stage is already running'); return; }

    /* Before anything is sent, and before the material is even assembled: this
     * is the operator's decision to make and the device has no part in it. */
    if (!await confirmCerts(await priorCertWrite())) {
        note('not written — tap it again when the unit is idle');
        return;
    }

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
         *
         * The number has a name now, and ③ and ④ send at it too: it is a
         * property of the console's one line buffer, not of an upload, and the
         * settings stages were losing lines to the same clock this measured.
         */
        floorMs: CONSOLE_LINE_MS,
        log: (text, kind) => write(text, kind === 'ok' ? 'ok'
            : kind === 'fail' ? 'fail' : kind === 'tx' ? 'tx' : 'note'),
    };

    state.busy = true;
    state.redacting = true;
    setMark('certs', '0/3', 'run');

    /* The modem's own `+QFUPL` verdicts, kept as they arrive so a run that
     * fails on the third file still records what the first two proved. */
    const proofs = [];
    let failure = null;

    try {
        await writeCerts(io, state.bundle, (done, total, proof) => {
            setMark('certs', `${done}/${total}`, done === total ? 'ok' : 'run');
            if (proof) proofs.push(proof);
        });
        setMark('certs', '3/3 ✓', 'ok');
        ok('All three certificates verified by the modem.');
        /* `writeCerts` ends on its own `ATZ` — Dragino requires a restart after
         * a certificate change — so this session is over too, and ① must not
         * keep reading `correct` into the next cycle. It is only reached on
         * success: a run that threw before the restart may still have one. */
        sessionEnded();
    } catch (err) {
        failure = err;
        setMark('certs', 'failed', 'fail');
        fail(`${STEP.certs}: ${err.message}`);
        note('Nothing half-written survives — every attempt starts with QFDEL.');
        note(`Press RESET, wait for the window, and tap ${press(STEP.certs)} again.`);
    } finally {
        /* Order matters: the filter is holding a partial line, and once the
         * flag is down it would be appended verbatim. */
        flushRaw();
        state.redacting = false;
        state.busy = false;
    }

    /* After the redaction comes down and the stage is no longer busy: writing
     * a file is not part of the device conversation and must not sit inside
     * the window it holds open. */
    await record({
        stage: STAGES.certs,
        substep: CERTS_SUBSTEP,
        status: failure ? 'failed' : 'done',
        summary: failure
            ? `Stopped after ${proofs.length}/3 files — ${failure.message}`
            : 'Three files accepted, each gated on the checksum the modem ' +
              'computed over what it stored',
        evidence: proofs.map(p => `${p.name}: +QFUPL: ${p.size},${p.checksum}`),
    });
}

/* ── ⑤ VERIFY ─────────────────────────────────────────────────────────────
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

    const phase = startPhase(STEP.verify);
    const seen = new Set();
    const collector = { lines: [], each: line => {
        PUBLISH_EVIDENCE.forEach(([pattern, meaning], i) => {
            if (seen.has(i) || !pattern.test(line)) return;
            seen.add(i);
            write(meaning, i === CONNECTED ? 'ok' : 'note');
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

        const published = seen.has(CONNECTED) && seen.has(SENT);
        /* What the device actually said, in the order the cycle says it. This
         * is the whole verdict: the stage sends nothing, so its evidence is
         * only ever the lines it watched go past. */
        record({
            stage: STAGES.verify,
            substep: 'full_cycle_observed',
            status: published ? 'done' : 'failed',
            summary: published
                ? 'AWS IoT returned CONNACK for this unit\'s certificate and a ' +
                  'reading left the modem (QoS 0 — the broker does not ack it)'
                : seen.has(0)
                    ? 'A cycle ran and never connected to the server'
                    : 'No cycle was observed before the budget ran out',
            evidence: PUBLISH_EVIDENCE
                .filter((_, i) => seen.has(i)).map(([, meaning]) => meaning),
        });

        if (published) {
            setMark('verify', 'published ✓', 'ok');
            ok('AWS IoT accepted this unit\'s certificate and the reading left ' +
               'the modem.');
            note('QoS 0 has no delivery receipt: confirm the uplink landed in ' +
                 `AWS IoT for ${state.bundle ? state.bundle.imei : 'this IMEI'}.`);
        } else if (seen.has(0)) {
            setMark('verify', 'no MQTT', 'fail');
            fail('The cycle ran and never connected to the server.');
            note(seen.has(4)
                ? 'It reached the broker and was refused: the certificate is ' +
                  'not registered/active/attached, or the key does not match it.'
                : 'It never reached the broker: network, APN or SERVADDR — not ' +
                  'the certificates.');
            note('SNI=0 and MQOS=0 are the two settings that fail silently here.');
        } else {
            setMark('verify', 'nothing seen', 'weak');
            fail('No cycle was observed before the budget ran out.');
            note('The link only carries lines while the unit is awake, so a ' +
                 'cycle that ran while BLE was re-attaching can be missed.');
        }
        endPhase(phase);
    };

    const timer = setTimeout(finish, verifyBudgetMs());
    state.verifying = { stop: finish };
    collectors.add(collector);

    setMark('verify', 'watching', 'run');
    note(`Watching for a publish, up to ${Math.round(verifyBudgetMs() / 60000)} min.`);
    you(`Press RESET to start a cycle now, or wait for the next one. Tap `
        + `${press(STEP.verify)} again to stop watching and report what was `
        + `seen.`);
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
        watchBoot(line);
        write(redact(line));
        feed(line);
    });
    let up = false;
    state.mock = true;

    link.connect = async () => { up = true; setLink('connected', 'simulated'); return 'MOCK-869181072714122'; };
    /* Nothing to adopt and nothing to hunt without a radio — the mock always
     * takes the connect path and is up the moment it is asked. */
    link.adopt = async () => null;
    link.isHunting = () => false;
    link.stopHunting = () => {};
    link.reconnect = async () => { up = true; };
    link.isConnected = () => up;
    link.deviceName = () => 'MOCK-869181072714122';
    link.sendLine = fake.io.send;
    link.sendRaw = fake.io.sendRaw;
    link.disconnect = async () => { up = false; };

    fail(`MOCK MODE (${kind || 'happy path'}) — no radio, no device.`);
    note('Everything below is simulated. Nothing here proves the link works.');
}

/*
 * The shell can be older than the code inside it.
 *
 * Modules are fetched with `no-store` and are always the deployed ones;
 * `provision.html` can come from cache, and a phone launching from the home
 * screen does exactly that. The mismatch does not announce itself — the module
 * reaches for an element the old page never had, throws on the first line that
 * does it, and everything after that line is simply never wired. Nothing
 * connects, nothing responds, and the version badge cheerfully reads new,
 * because the badge comes from the module.
 *
 * That cost a bench session. So it is checked, before anything can throw, by
 * naming the elements this version needs and refusing to pretend when they are
 * absent.
 */
const SHELL_NEEDS = [
    'pair-row', 'btn-bundle', 'mark-bundle', 'raw-live', 'raw-count',
    'terminal', 'terminal-raw', 'link-state', 'app-version',
    'at-menu', 'at-panel', 'at-list', 'at-filter',
    'btn-network', 'mark-network',
    'btn-ble', 'mark-ble', 'unit-region',
];

function shellIsStale() {
    const missing = SHELL_NEEDS.filter(id => !el(id));
    if (!missing.length) return false;

    const banner = document.createElement('div');
    banner.style.cssText =
        'padding:14px 16px;background:#7f1d1d;color:#fee2e2;font:14px/1.4 ' +
        '-apple-system,sans-serif;';
    banner.textContent =
        `This page is cached from an older version (v${VERSION} code, ` +
        `missing: ${missing.join(', ')}). Pull down to refresh, or reload with ` +
        '?cb=1 — nothing here will work until you do.';
    document.body.prepend(banner);
    return true;
}

export function initProvision() {
    if (shellIsStale()) return;

    /* First line of every session, so it lands in any screenshot sent back
     * from a bench. A log without a version is a log you cannot place. */
    el('app-version').textContent = `v${VERSION}`;
    note(`AIS01 End node configuration v${VERSION} — ${VERSION_NOTE}`);

    /*
     * A stage's rows belong to that stage, so the section is opened and closed
     * around the whole run — here, at the seam, rather than inside four stage
     * bodies that are about the device and not about the log.
     *
     * ⑤ is not wrapped: it arms a watcher and returns, and its verdict arrives
     * minutes later. It opens and closes its own section around the watch.
     */
    const staged = (label, fn) => async (...args) => {
        const phase = startPhase(label);
        try { return await fn(...args); } finally { endPhase(phase); }
    };

    /* Two controls, one action. The bar answers "is the link up" from across a
     * bench; the chip answers "where am I in the sequence" — see the markup. */
    el('btn-connect').addEventListener('click', () => doConnect(true));
    el('btn-ble').addEventListener('click', () => doConnect(true));
    el('btn-bundle').addEventListener('click', chooseFolder);
    el('btn-login').addEventListener('click', staged(STEP.login, doLogin));
    el('btn-certs').addEventListener('click', staged(STEP.certs, doCerts));
    el('btn-verify').addEventListener('click', doVerify);

    el('btn-network').addEventListener('click',
        staged(STEP.network, () => runConfigStage('network')));
    el('btn-config').addEventListener('click',
        staged(STEP.mqtt, () => runConfigStage('mqtt')));

    el('copy-log').addEventListener('click', copyRawLog);
    el('btn-forget').addEventListener('click', changeUnit);

    el('bundle-input').addEventListener('change', e => loadFiles(e.target.files));

    wireAtPicker();
    el('at-send').addEventListener('click', sendManual);
    el('at-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') sendManual();
    });

    /*
     * Scrolling away from the tail unpins that pane, so reading back through
     * the log does not fight the device writing to it.
     *
     * Both panes now unpin quietly. The `▼ live` marker that used to announce
     * it for the annotated pane is gone — spec 004 asks for it, and in practice
     * it reported something the scrollbar already shows, on the one screen
     * where every pixel is the instrument. What is lost is the explicit signal
     * that you are looking at the past; what is kept is the foot of the raw
     * pane, which says whether the LINK is live, and that is the question the
     * marker was being read for anyway.
     */
    for (const [id, pane] of [['terminal', 'annotated'], ['terminal-raw', 'raw']]) {
        const out = el(id);
        out.addEventListener('scroll', () => {
            state.pinned[pane] =
                out.scrollHeight - out.scrollTop - out.clientHeight < 24;
        });
    }

    /* Before the radio, and in mock mode too: a simulated device still needs a
     * unit's material, and the folder is where it comes from either way. It
     * says its own piece in the log — which unit, and what is missing. */
    restoreFolder();
    if (!hasFolderApi()) {
        note('this browser has no directory picker, so the folder cannot be ' +
             'remembered between reloads — on Chrome for desktop it can');
    }

    const kind = new URLSearchParams(location.search).get('mock');
    if (kind !== null || location.search.includes('mock')) {
        installMock(kind || '');
        return;
    }

    if (!hasBluetooth()) {
        fail('No Web Bluetooth in this browser. On iOS use Bluefy.');
        return;
    }

    /*
     * Attach on load, with nobody pressing anything.
     *
     * `getDevices()` and a re-attach need no user gesture — only the chooser
     * does — so the whole reason a connect button existed applies exactly once
     * per browser. If there is nothing granted to adopt, `doConnect` finds
     * nothing, does not open a picker without being asked, and the pair row
     * stays up waiting for the tap that legitimately needs a person.
     *
     * The hunt runs while this screen is open, and only while it is: a phone
     * waking its radio every 1.2 s for a page nobody is looking at is a battery
     * complaint waiting to happen.
     */
    {
        doConnect();
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') doConnect();
            else link.stopHunting();
        });
    }

}
