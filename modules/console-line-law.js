/*
 * The console line law — what the Dragino app forwards to the BG95.
 *
 * Port of AIS01-CB-LTE `cli/ais01_cli/core/console_line_law.py`, which was read
 * off the app firmware itself. That file is the authority; this one exists so
 * the phone can refuse a bad part BEFORE it spends a window on it, and it must
 * be kept in step with the Python whenever the Python changes.
 *
 * The three instruction ranges everything below follows from (v1.3,
 * `AIS01-CB-1.3.bin`, app base 0x08007800):
 *
 *     RX byte handler   0x0800b952
 *         buf[idx++] = byte              <- no bounds check on this branch
 *         if byte in (CR, LF): line_ready = 1
 *         buffer = 0x200001d8, 300 bytes
 *
 *     main loop         0x08010fe4
 *         if line_ready: at_dispatch(buf)
 *         ... then idx = 0 and memset(buf, 0, 300)
 *
 *     at_dispatch       0x08008edc
 *         normalize(buf)                 0x0801a450 — NUL over the first CR/LF
 *         "AT" / "AT?" answered locally, never forwarded
 *         58-entry table @0x0801b4d4 matched with strstr() — SUBSTRING
 *         no match -> return 1
 *
 *     return 1 path     0x08011078
 *         buf[strlen(buf)] = '\r'        0x0801108a
 *         buf[strlen(buf)] = '\n'        0x08011096
 *         uart_send(BG95, buf, strlen(buf))
 *
 * The consequence that cost this project fifteen device windows is the one
 * about terminators, so it is stated here in full:
 *
 *   `line_ready` is raised by CR **or** LF, and the main loop zeroes the buffer
 *   after every dispatch. Send `line\r\n` and the LF is a SECOND terminator. If
 *   the main loop happens to run between the CR and the LF — a race, decided by
 *   where the loop is at that instant — the LF lands in a freshly zeroed buffer
 *   and dispatches on its own: an empty line, forwarded to the modem as a stray
 *   `\r\n`, and one more dispatch turn during which the next part arrives into a
 *   buffer that is not ready and is discarded outright.
 *
 *   A bare CR cannot do this. One terminator, one line_ready, one dispatch.
 */

export const CR = 0x0D;
export const LF = 0x0A;

/* Size of the console line buffer at 0x200001d8 (memset length @0x080110ce). */
export const CONSOLE_LINE_BUFFER_BYTES = 300;

/* Bytes a single part may occupy, terminator included. Well under the hard 300
 * so a slow main loop coalescing two parts still cannot overflow into the
 * camera response area that follows it. */
export const SAFE_PART_BYTES = 128;

/* The 58 commands in the app table at 0x0801b4d4. A part containing any of
 * these as a SUBSTRING is intercepted by the app and never reaches the BG95. */
export const APP_AT_COMMANDS = [
    'AT+5VT', 'AT+APN', 'AT+BKDNS', 'AT+CDP', 'AT+CERTMOD', 'AT+CFG',
    'AT+CFGMOD', 'AT+CLIENT', 'AT+CLOCKLOG', 'AT+CSQTIME', 'AT+DEUI',
    'AT+DNSCFG', 'AT+DOWNTE', 'AT+EXT', 'AT+FDR', 'AT+FDR1', 'AT+GDNS',
    'AT+GETLOG', 'AT+GETSENSORVALUE', 'AT+GNSST', 'AT+GPS', 'AT+GTDC',
    'AT+IMAGE', 'AT+INTMOD', 'AT+IOTMOD', 'AT+IPTYPE', 'AT+LDATA', 'AT+MODEL',
    'AT+MQOS', 'AT+NTP', 'AT+OTACLT', 'AT+OTAPWD', 'AT+OTASER', 'AT+OTATITLE',
    'AT+OTAUNAME', 'AT+OTAVER', 'AT+PRO', 'AT+PUBTOPIC', 'AT+PWD', 'AT+PWORD',
    'AT+QBAND', 'AT+QCOPS', 'AT+QSW', 'AT+RXDL', 'AT+SERVADDR', 'AT+SLEEP',
    'AT+SNI', 'AT+SUBTOPIC', 'AT+TDC', 'AT+TLSMOD', 'AT+UNAME', 'AT+UPGRADE',
    'AT+URI1', 'AT+URI2', 'AT+URI3', 'AT+URI4', 'AT+URI5', 'ATZ',
];

/* Answered by the app itself before the table is consulted (0x08008ee6/ef2). */
export const LOCALLY_ANSWERED = ['AT', 'AT?'];

/* Model `normalize()` @0x0801a450: truncate at the first CR or LF. */
export function normalize(part) {
    for (let i = 0; i < part.length; i++) {
        if (part[i] === CR || part[i] === LF) return part.slice(0, i);
    }
    return part.slice(0);
}

/* The exact bytes the BG95 receives for one console part. Only valid when the
 * part is actually forwarded — see `checkPart` for what the app swallows. */
export function forwardedBytes(part) {
    const body = normalize(part);
    const out = new Uint8Array(body.length + 2);
    out.set(body, 0);
    out[body.length] = CR;
    out[body.length + 1] = LF;
    return out;
}

/*
 * What the modem ends up STORING for a whole sequence of parts.
 *
 * This — not the sum of the wire bytes — is the value `AT+QFUPL="<name>",<size>`
 * must declare and the input to the checksum gate. With a bare-CR terminator
 * the two differ by one byte per line, and declaring the wire count instead is
 * a modem left waiting for bytes that are never coming.
 */
export function wireImage(parts) {
    const forwarded = parts.map(forwardedBytes);
    const total = forwarded.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of forwarded) { out.set(p, at); at += p.length; }
    return out;
}

const decodeLatin1 = bytes => String.fromCharCode(...bytes);

/*
 * Return the reasons this part would not land verbatim on the modem. An empty
 * list means the app forwards it and the modem stores exactly
 * `normalize(part) + CRLF`.
 */
export function checkPart(part, index = 0) {
    const issues = [];
    const where = `part[${index}]`;

    if (part[part.length - 1] !== CR) {
        issues.push(`${where}: must end with a bare CR; the terminator is ` +
                    `stripped and CRLF re-appended (0x0801108a)`);
    }
    const body = normalize(part);

    if (part.length !== body.length + 1 || part[body.length] !== CR) {
        issues.push(`${where}: contains a CR/LF before its terminator; ` +
                    `everything after the first one is discarded, and a ` +
                    `trailing LF can dispatch again as an empty line`);
    }
    if (!body.length) {
        issues.push(`${where}: empty after normalize() — forwards a bare CRLF`);
    }
    if (part.length > CONSOLE_LINE_BUFFER_BYTES) {
        issues.push(`${where}: ${part.length}B exceeds the ` +
                    `${CONSOLE_LINE_BUFFER_BYTES}B console buffer — overflows ` +
                    `into the camera area`);
    } else if (part.length > SAFE_PART_BYTES) {
        issues.push(`${where}: ${part.length}B exceeds the ${SAFE_PART_BYTES}B ` +
                    `safe margin for two coalescing parts`);
    }

    const text = decodeLatin1(body);
    if (LOCALLY_ANSWERED.includes(text)) {
        issues.push(`${where}: "${text}" is answered by the app, never forwarded`);
    }
    for (const name of APP_AT_COMMANDS) {
        if (text.includes(name)) {
            issues.push(`${where}: contains app command "${name}" as a ` +
                        `substring (strstr @0x08008f04) — intercepted, not ` +
                        `forwarded`);
        }
    }
    return issues;
}

export function checkParts(parts) {
    return parts.flatMap((p, i) => checkPart(p, i));
}
