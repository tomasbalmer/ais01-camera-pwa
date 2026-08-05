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

/*
 * The terminator rule, as this unit actually behaves.
 *
 * The reference writer sends a lone CR because the app it talks to truncates
 * each console line at its first CR/LF and appends CRLF itself. Measured here
 * on 2026-08-05 with a one-line probe declaring its exact wire count, this
 * unit does no such thing: `+QFUPL: 28,6c53` is the checksum of
 * `-----BEGIN CERTIFICATE-----` followed by a bare CR, so the terminator
 * arrived untouched and nothing was appended.
 *
 * Under that firmware a bare CR made every declared size one byte per line too
 * large — 20 for this certificate — and the modem sat waiting for bytes that
 * were never coming. Sending CRLF puts the canonical content back on the
 * modem, which is why the two forms below must now be byte-identical.
 */
check('every part ends in CRLF',
      parts.every(p => p[p.length - 2] === 13 && p[p.length - 1] === 10), true);
check('no part carries a terminator before its own',
      parts.some(p => [...p.slice(0, -2)].some(b => b === 13 || b === 10)), false);

/* What is sent IS what is stored, so the size declared to QFUPL and the
 * checksum gated on cannot drift apart from the bytes that left. */
const wire = parts.reduce((n, p) => n + p.length, 0);
check('the wire form is the canonical form', wire, canonical.length);

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
