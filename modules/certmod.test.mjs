/*
 * certmod.js checked against the real modem vector.  Run:  node modules/certmod.test.mjs
 *
 * No framework and no dependencies on purpose — this repo has no build step and
 * should not grow one for four assertions.
 *
 * These are the only claims in the whole provisioning path that can be proven
 * without a device, and they are the ones that fail silently. A wrong size or
 * checksum does not throw: the upload completes, the modem stores something,
 * and the unit fails weeks later in the field. The values below come from an
 * actual BG95 — the CA write on 2026-07-13 over USB echoed
 * `+QFUPL: 1208,5769` — so this is a comparison against hardware, not against
 * our own arithmetic.
 */

import {
    AMAZON_ROOT_CA1, canonicalBytes, wireParts, qfuplChecksum,
    parseQfupl, hex4, partDelayMs,
} from './certmod.js';

let failed = 0;
const check = (name, actual, expected) => {
    const okay = JSON.stringify(actual) === JSON.stringify(expected);
    if (!okay) failed++;
    console.log(`${okay ? 'ok  ' : 'FAIL'} ${name}` +
        (okay ? '' : `\n       expected ${JSON.stringify(expected)}` +
                     `\n       got      ${JSON.stringify(actual)}`));
};

const canonical = canonicalBytes(AMAZON_ROOT_CA1);
const parts = wireParts(AMAZON_ROOT_CA1);

/* The pair the modem itself produced. */
check('CA canonical size is what QFUPL must be told', canonical.length, 1208);
check('CA checksum is what the modem must echo', hex4(qfuplChecksum(canonical)), '5769');

/* The terminator rule: a lone CR. A trailing LF can drain as a second, empty
 * line and add a stray CRLF, which changes the stored bytes. */
check('every part ends in a bare CR', parts.every(p => p[p.length - 1] === 13), true);
check('no part carries an LF', parts.some(p => p.includes(10)), false);

/* Stored is not sent: the passthrough turns each bare CR into CRLF, so the
 * canonical form is exactly one byte per line longer than the wire form. */
const wire = parts.reduce((n, p) => n + p.length, 0);
check('canonical exceeds wire by one byte per line',
      canonical.length - wire, parts.length);

/* The last result wins — an earlier attempt must not be read as this verdict. */
check('parseQfupl takes the last result',
      parseQfupl(['+QFUPL: 1,1', 'noise', '+QFUPL: 1208,5769']),
      { size: 1208, checksum: 0x5769 });
check('parseQfupl reports absence rather than guessing',
      parseQfupl(['OK', 'CONNECT']), null);

/* Pacing must never fall below a part's own drain time at 9600 baud. */
check('pacing floor holds for a long part', partDelayMs(300, 0) >= 300 * 10 / 9600 * 1000, true);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
