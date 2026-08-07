/*
 * BT24 transport — text-only, no DOM, no calibration.
 *
 * `ble.js` already talks to this hardware, but it is not a transport module:
 * it imports the calibration page's DOM helpers, drives SETUP_STEPS, and parses
 * JPEG frames out of the stream. Importing it from another page would move
 * elements that do not exist and hunt for images in a console log.
 *
 * So this is a second, deliberately small implementation of the same link,
 * written beside it rather than extracted out of it — the calibration flow
 * works today and is not touched by this feature. What it keeps is the part
 * that was expensive to learn:
 *
 *   Service FFE0, characteristic FFE1 — the same char both notifies and
 *   writes. FFE2 accepts writes and silently does NOT relay them to the UART.
 *   Pick the characteristic by its `notify` property, never by index.
 *
 *   Writes go out via writeValueWithoutResponse, one payload per call. The
 *   with-response variant hangs Chrome's BLE reconnect on this module — it is
 *   not a fallback, it is a defect. Do not add it here.
 *
 * The device console is plain text, so this module's whole output contract is
 * "here is another line".
 */

const SERVICE_UUID = 0xFFE0;

/* BT24 advertises under the unit's IMEI; the rest are older/paired names. */
const NAME_PREFIXES = ['8683', '8691', 'BT24', 'Dragino', 'AIS01'];

let device = null;
let char = null;
let rxBuffer = '';

let onLine = () => {};
let onChunk = () => {};
let onStatus = () => {};
/* Transport-level accounting, surfaced as a normal log line. What left this
 * phone had been inferred from what came back, and that inference was wrong
 * twice today. */
let onDiag = () => {};

export function hasBluetooth() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export function isConnected() {
    return !!(device && device.gatt && device.gatt.connected);
}

/* The advertised name, which for this hardware is the IMEI. Null before
 * connecting. Used to catch a bundle loaded for a different unit. */
export function deviceName() {
    return device ? device.name || null : null;
}

function handleNotification(event) {
    const bytes = new Uint8Array(event.target.value.buffer);
    const text = new TextDecoder().decode(bytes);

    /*
     * Two outputs, and the order matters.
     *
     * `onChunk` gets the bytes exactly as they arrived — before line assembly,
     * before anything is dropped or joined. It is the raw log, and the harness
     * this replaces keeps one for a reason: every claim about what a device did
     * is settled by reading it. A view that silently discards blank lines or
     * holds a partial tail is a view, not evidence.
     *
     * `onLine` gets complete lines, for code that has to match on them. A
     * notification boundary is not a line boundary — the device's own newlines
     * are — so a partial tail waits here, and only here.
     */
    onChunk(text);

    /*
     * A bare CR ends a line here too.
     *
     * Splitting on LF alone was right for everything the firmware prints and
     * wrong for everything that comes back during a cert write: the modem
     * returns our upload lines terminated the way we sent them, with a bare
     * CR and no LF. Those never split. They accumulated until some later LF
     * arrived and then left as one blob, which is why the log showed `ATE0\r`
     * as a single line and PEM tails with their beginnings missing.
     *
     * It also quietly broke matching. The echo probe asks whether `AT` comes
     * back and got `AT\rOK` as one line, which is neither and reads as an echo
     * that is off while it is on.
     */
    rxBuffer += text;
    const parts = rxBuffer.split(/\r\n|\r|\n/);
    rxBuffer = parts.pop();
    for (const line of parts) {
        if (line.length) onLine(line);
    }
}

async function attach() {
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const chars = await service.getCharacteristics();

    const notifyChar = chars.find(c => c.properties.notify);
    if (!notifyChar) throw new Error('BT24 exposed no notify characteristic');

    char = notifyChar;
    await char.startNotifications();
    char.addEventListener('characteristicvaluechanged', handleNotification);
}

/*
 * Scan, pair, attach. `handlers.onLine(text)` receives every complete line the
 * device emits; `handlers.onStatus(state, detail)` reports link changes, where
 * state is 'connected' | 'reconnecting' | 'disconnected'.
 *
 * Resolves to the device name, or null when the user dismisses the picker —
 * which is a choice, not an error, and is not thrown.
 */
export async function connect(handlers = {}) {
    if (!hasBluetooth()) throw new Error('This browser has no Web Bluetooth');

    onLine = handlers.onLine || onLine;
    onChunk = handlers.onChunk || onChunk;
    onStatus = handlers.onStatus || onStatus;
    onDiag = handlers.onDiag || onDiag;

    try {
        device = await navigator.bluetooth.requestDevice({
            filters: [
                ...NAME_PREFIXES.map(namePrefix => ({ namePrefix })),
                { services: [SERVICE_UUID] },
            ],
            optionalServices: [SERVICE_UUID],
        });
    } catch (err) {
        /* NotFoundError is the user closing the chooser. */
        if (err && err.name === 'NotFoundError') return null;
        throw err;
    }

    watchDrops(device);

    /* From here the link is ours to keep. Only an explicit disconnect gives it
     * up — everything else is the unit sleeping, and it comes back. */
    wantLink = true;
    try {
        await attach();
    } catch {
        /* Chosen but asleep: hunt, exactly as after a drop. Same reason as in
         * `adopt` — a unit that is not answering yet is not an error. */
        keepConnected();
        return device.name || '(unnamed)';
    }
    onStatus('connected', device.name || '');
    return device.name || '(unnamed)';
}

/* One listener per device object, however many times we adopt it. */
const watched = new WeakSet();

function watchDrops(d) {
    if (watched.has(d)) return;
    watched.add(d);
    d.addEventListener('gattserverdisconnected', () => {
        if (d !== device) return;   /* a device we let go of; not our link */
        char = null;
        rxBuffer = '';
        /* Expected, not a failure: the BT24 drops the link after ~60 s idle and
         * comes back around the next duty cycle. Callers must not read this as
         * the unit being gone. */
        onStatus('disconnected', 'BT24 idle timeout or device asleep');
        keepConnected();
    });
}

/*
 * Re-attach to a unit this browser already has permission for, with no chooser.
 *
 * Reloading the page is not a rare event here — it is how you pick up a new
 * build, and every cert-write iteration ends in one. The permission survives
 * the reload; only the `device` object does not, so the link came back through
 * the native picker: a dialog, a list, a tap, per iteration, for a unit already
 * chosen once.
 *
 * `getDevices()` returns the granted ones. It needs no gesture and cannot
 * surprise anyone — nothing appears that was not already permitted.
 *
 * `prefer` is the IMEI from the loaded bundle, and it is a guard rather than a
 * convenience: on a bench with several granted units, adopting "the first one"
 * would silently point the app at the wrong unit. Without it, adoption only
 * happens when the choice is unambiguous — one known unit, no decision to get
 * wrong.
 *
 * Returns the device name on success and null when there is nothing to adopt
 * (no API, no known unit, no unambiguous pick) — every one of which means "use
 * the picker". A unit that is known but does not answer throws, because that is
 * a unit that is asleep, and the picker will not find it either.
 */
export async function adopt(handlers = {}, prefer = null) {
    if (!hasBluetooth() || !navigator.bluetooth.getDevices) return null;

    let known;
    try {
        known = (await navigator.bluetooth.getDevices()).filter(d => d.name);
    } catch {
        return null;   /* older permissions backend — the picker still works */
    }

    const pick = prefer
        ? known.find(d => d.name.includes(prefer))
        : (known.length === 1 ? known[0] : null);
    if (!pick) return null;

    onLine = handlers.onLine || onLine;
    onChunk = handlers.onChunk || onChunk;
    onStatus = handlers.onStatus || onStatus;
    onDiag = handlers.onDiag || onDiag;

    device = pick;
    watchDrops(device);
    wantLink = true;
    onStatus('reconnecting', `adopting ${device.name}`);
    try {
        await attach();
    } catch {
        /*
         * A granted unit that does not answer is a unit that is asleep, and it
         * will advertise again at the end of its duty cycle. That is not a
         * failure to report back to the caller — it is the normal state of a
         * bench, and the reason the CLI has no connect button at all: its
         * daemon simply keeps trying.
         *
         * So the hunt starts here rather than an error being thrown, and the
         * caller hears about it as a link status like any other.
         */
        keepConnected();
        return device.name || '(unnamed)';
    }
    onStatus('connected', device.name || '');
    return device.name || '(unnamed)';
}

/* Re-attach after an idle drop. Same device — no picker, no user gesture. */
export async function reconnect() {
    if (!device) throw new Error('Nothing to reconnect to');
    onStatus('reconnecting', '');
    await attach();
    onStatus('connected', device.name || '');
}

/*
 * Keep re-attaching until the unit comes back, or until someone asks us to
 * stop.
 *
 * The link drops constantly and by design: the BT24 gives up after about sixty
 * seconds idle, and the unit itself goes away at the end of every duty cycle.
 * Re-pairing needs a user gesture; re-attaching to a device already chosen does
 * not, so the only reason this was manual is that nobody had written the loop.
 * Every reset was costing a click, and a click at the wrong moment costs the
 * whole AT window.
 *
 * It retries while the device is asleep — that is most of the wait, and every
 * attempt fails until the unit advertises again — so the interval stays short
 * enough to catch the window opening and backs off enough not to spin.
 */
let wantLink = false;
let reattaching = false;

async function keepConnected() {
    if (reattaching || !wantLink || !device) return;
    reattaching = true;
    for (let attempt = 1; wantLink; attempt++) {
        if (device.gatt && device.gatt.connected) break;
        /* A line per attempt at 1.2 s is a wall between two real facts, and the
         * status dot already says it is trying. Say it once, then occasionally,
         * so a hunt that has been running for minutes still shows its age. */
        onStatus('reconnecting',
                 attempt === 1 ? `looking for ${device.name || 'the unit'}`
                 : attempt % 25 === 0 ? `still looking (attempt ${attempt})` : '');
        try {
            await attach();
            onStatus('connected', device.name || '');
            break;
        } catch {
            /* Asleep, or still shutting down. Neither is an error to report —
             * the status line already says `reconnecting`.
             *
             * The interval is short and stays short, for the reason the CLI
             * daemon gives at the same retry (`broker._run_owner_ble`): the
             * BT24 advertises for eight to fifteen seconds after a reset, and
             * that window is the whole opportunity. Backing off past it turns
             * a reconnect into a coin toss. */
            await wait(1200);
        }
    }
    reattaching = false;
}

/* Is the loop above running — i.e. is the app hunting for a unit that is not
 * answering yet? The caller needs it to offer a way out of the hunt. */
export function isHunting() {
    return reattaching;
}

/*
 * Give up on purpose.
 *
 * The hunt is unbounded, so the operator needs one action that ends it — the
 * same action that started it, which is why the button is a toggle. Without
 * this the only way to stop a phone quietly waking its radio every 1.2 s would
 * be to close the tab.
 */
export function stopHunting() {
    wantLink = false;
}

/*
 * Always slice, and give the bridge room to breathe between slices.
 *
 * The BT24 takes bytes off the air instantly and pushes them to the STM32 over
 * a 9600-baud UART: a 20-byte slice needs ~21 ms to drain. Anything that
 * arrives before that has nowhere to go, and `writeValueWithoutResponse` — the
 * only write this bridge tolerates — has no flow control to say so. The bytes
 * are simply gone.
 *
 * That is not a theory. On 2026-08-05 a certificate upload was caught in the
 * act, echoed back by the device mid-transfer:
 *
 *     -----BEGIN CERTIFICATE-----      <- line 1, intact
 *                                      <- line 2, gone entirely
 *     ADA5MQ...BBBmF6b24gUm9vdCBDQ...MFowOTELM
 *     |___ line 3 ___||___ line 4 ___||_ line 5
 *
 * Whole bytes disappear mid-stream, and when the byte that disappears is a CR
 * two console lines merge. The firmware then never sees `line_ready`, keeps
 * filling its single 300-byte buffer past the end, and the modem never receives
 * the lines it was promised. That is the silence this path chased for weeks.
 *
 * 100 ms, not the ~21 ms the drain alone needs. The margin is affordable —
 * about two seconds across a certificate — and buying margin on a link with no
 * flow control is the only thing that can be bought here.
 *
 * It is not, however, what made the write land. The console's own acceptance
 * period is measured in seconds and lives in `io.floorMs` (provision.js); this
 * value only keeps one write from treading on the next.
 */
const CHUNK_DRAIN_MS = 100;

const wait = ms => new Promise(r => setTimeout(r, ms));

/*
 * Count what actually left, because so far nothing has.
 *
 * The byte-accounting probe came back on 2026-08-05 with the answer that ends
 * every theory built on volume: THREE lines, 158 bytes, paced at 600 ms, did
 * not arrive complete. Not scale, not cadence, not the CRLF arithmetic. And
 * the bridge echoed the 28-byte first line while neither 65-byte line came
 * back at all, which points at the writes themselves rather than at anything
 * downstream of them.
 *
 * `writeValueWithoutResponse` resolving is not evidence that a write left —
 * it can reject for an oversized value, and a rejection swallowed inside a
 * paced loop looks exactly like a device that lost bytes. So every payload now
 * reports what it managed, and a failed slice says so in the terminal instead
 * of disappearing into the next 600 ms of silence.
 *
 * The whole-payload attempt is gone with it. It was speculative, the failure
 * predates it, and while it is unproven it is one more thing that can differ
 * between a line that arrives and a line that does not.
 */
/*
 * One line, one write.
 *
 * `cli/ais01_cli/core/ble_transport.py` writes at `mtu - 3`, and
 * CoreBluetooth negotiates an ATT MTU of 185 here, so every PEM line left the
 * reference writer as a single write. This module was hard-coding 20 bytes and
 * sending the same line as two or four writes a tenth of a second apart, which
 * is a difference with no reason behind it.
 *
 * Chrome rejects a write larger than the negotiated MTU rather than splitting
 * it, and Web Bluetooth does not expose the MTU. A part is one PEM line — 66
 * bytes at most — so it fits with room to spare on any link this app has seen,
 * and a rejection here is worth failing loudly on rather than degrading
 * quietly into a slicing path that no hardware run has exercised.
 */
async function writeChunks(bytes, kind) {
    if (!char) throw new Error('BLE not connected');
    onChunk(new TextDecoder().decode(bytes), kind);

    try {
        await char.writeValueWithoutResponse(bytes);
    } catch (err) {
        onDiag(`TX FAILED (${bytes.length}B): ${err.message}`);
        throw err;
    }
    /* The gap is unconditional, as `INTER_CHUNK_GAP_S` is in the reference
     * writer: it pays for the UART drain on the far side of the bridge. */
    await wait(CHUNK_DRAIN_MS);
    if (kind === 'tx-raw') onDiag(`tx ${bytes.length}B`);
}

/*
 * One AT command, terminated by a BARE CR — the same law the PEM parts obey.
 *
 * `console_line_law.py`: the RX handler raises `line_ready` on CR *or* LF, and
 * the main loop dispatches and only then zeroes the buffer. A `\r\n` therefore
 * raises it twice, and the second one can catch the buffer before the memset —
 * so the command is dispatched again. It is visible in the log: `ATE0` echoed
 * back twice from a single send. Every command was being executed twice.
 *
 * The terminator is destroyed and CRLF re-appended before forwarding either
 * way, so a lone CR loses nothing and stops the double dispatch.
 */
export async function sendLine(text) {
    await writeChunks(new TextEncoder().encode(text + '\r'), 'tx-line');
}

/* Payload bytes with no terminator — the body of an AT+QFUPL upload, where
 * appending CRLF would corrupt the file and fail the checksum. */
export async function sendRaw(bytes) {
    await writeChunks(bytes, 'tx-raw');
}

export async function disconnect() {
    /* Before the drop, so the disconnect event does not start reattaching to
     * the device this is letting go of. */
    wantLink = false;
    if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
    device = null;
    char = null;
    rxBuffer = '';
}
