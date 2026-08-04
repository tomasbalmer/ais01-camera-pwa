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
 *   Writes go out in 20-byte chunks via writeValueWithoutResponse. The
 *   with-response variant hangs Chrome's BLE reconnect on this module — it is
 *   not a fallback, it is a defect. Do not add it here.
 *
 * The device console is plain text, so this module's whole output contract is
 * "here is another line".
 */

const SERVICE_UUID = 0xFFE0;
const CHUNK = 20;

/* BT24 advertises under the unit's IMEI; the rest are older/paired names. */
const NAME_PREFIXES = ['8683', '8691', 'BT24', 'Dragino', 'AIS01'];

let device = null;
let char = null;
let rxBuffer = '';

let onLine = () => {};
let onChunk = () => {};
let onStatus = () => {};

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

    device.addEventListener('gattserverdisconnected', () => {
        char = null;
        rxBuffer = '';
        /* Expected, not a failure: the BT24 drops the link after ~60 s idle and
         * comes back around the next duty cycle. Callers must not read this as
         * the unit being gone. */
        onStatus('disconnected', 'BT24 idle timeout or device asleep');
    });

    await attach();
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
 * Send a payload WHOLE when the link allows it, and only fall back to slices.
 *
 * This is the one structural difference between the USB path that works and
 * the BLE path that does not. Over USB a 65-byte PEM line enters the console
 * UART as one continuous stream. Over BLE the same line left here as four
 * 20-byte writes, and BLE delivers each in its own connection event — so the
 * firmware, which assembles a console line up to its first CR before
 * forwarding it, was being handed a line in pieces with gaps between them.
 *
 * On 2026-08-04 `AT+QFLST` was finally asked what the silence meant and
 * answered plainly: no such file. The modem never completed the transfer, so
 * the bytes were lost on the way IN — and not for want of bandwidth. The
 * stream averaged about 238 B/s against the bridge's 960, four times under
 * capacity, which rules out rate and leaves delivery shape.
 *
 * `writeValueWithoutResponse` accepts up to the negotiated ATT MTU minus three,
 * which is 20 bytes only when nothing better was negotiated. Chrome routinely
 * gets far more, and a whole line then crosses in one event, arriving as the
 * uninterrupted run the firmware is expecting. The fallback keeps the old
 * behaviour for links that really are stuck at the minimum.
 */
const CHUNK_DRAIN_MS = Math.ceil(CHUNK * 10 / 9600) + 10;

const wait = ms => new Promise(r => setTimeout(r, ms));

/* Set on the first oversized write that the link refuses, so it is attempted
 * once per connection rather than once per line. */
let mustSlice = false;

async function writeChunks(bytes, kind) {
    if (!char) throw new Error('BLE not connected');
    onChunk(new TextDecoder().decode(bytes), kind);

    if (!mustSlice && bytes.length > CHUNK) {
        try {
            await char.writeValueWithoutResponse(bytes);
            return;
        } catch {
            /* Only the MTU can refuse this, and it refuses every line equally
             * — so ask once and remember the answer. */
            mustSlice = true;
        }
    }

    for (let i = 0; i < bytes.length; i += CHUNK) {
        await char.writeValueWithoutResponse(bytes.slice(i, i + CHUNK));
        /* The last chunk of a payload needs no gap after it — the caller's own
         * pacing, or its wait for a reply, covers that. */
        if (i + CHUNK < bytes.length) await wait(CHUNK_DRAIN_MS);
    }
}

/* One AT command. The device's line terminator is CRLF. */
export async function sendLine(text) {
    await writeChunks(new TextEncoder().encode(text + '\r\n'), 'tx-line');
}

/* Payload bytes with no terminator — the body of an AT+QFUPL upload, where
 * appending CRLF would corrupt the file and fail the checksum. */
export async function sendRaw(bytes) {
    await writeChunks(bytes, 'tx-raw');
}

export async function disconnect() {
    if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
    device = null;
    char = null;
    rxBuffer = '';
}
