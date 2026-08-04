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
    rxBuffer += new TextDecoder().decode(bytes);

    /* Emit whole lines only. A notification boundary is not a line boundary —
     * the device's own newlines are, so a partial tail waits for the rest. */
    const parts = rxBuffer.split(/\r?\n/);
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

async function writeChunks(bytes) {
    if (!char) throw new Error('BLE not connected');
    for (let i = 0; i < bytes.length; i += CHUNK) {
        await char.writeValueWithoutResponse(bytes.slice(i, i + CHUNK));
    }
}

/* One AT command. The device's line terminator is CRLF. */
export async function sendLine(text) {
    await writeChunks(new TextEncoder().encode(text + '\r\n'));
}

/* Payload bytes with no terminator — the body of an AT+QFUPL upload, where
 * appending CRLF would corrupt the file and fail the checksum. */
export async function sendRaw(bytes) {
    await writeChunks(bytes);
}

export async function disconnect() {
    if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
    device = null;
    char = null;
    rxBuffer = '';
}
