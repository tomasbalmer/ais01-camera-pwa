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
    BODY_CHARS_PER_LINE, PEM_CONVENTION_WIDTH,
} from './certmod.js';
import { checkPart, checkParts, wireImage } from './console-line-law.js';

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

/*
 * The pair the modem itself produced — at the 64-character wrapping that run
 * used. It stays pinned to that width on purpose: it is the one assertion in
 * this file backed by hardware, and re-deriving it from whatever width the
 * bench is currently on would turn it into a tautology.
 */
const conventional = canonicalBytes(AMAZON_ROOT_CA1, PEM_CONVENTION_WIDTH);
check('CA canonical size is what QFUPL must be told', conventional.length, 1208);
check('CA checksum is what the modem must echo',
      hex4(qfuplChecksum(conventional)), '5769');

/*
 * The bench wrapping is a different file, and the only claims that hold for
 * any width are the internal ones: the declaration matches the wire image the
 * console will produce, and no part exceeds the two BLE slices that are the
 * shape of the only part ever observed to arrive.
 */
check('declared size matches the wire image at the bench width',
      canonical.length, wireImage(parts).length);
check('every part fits in two BLE slices',
      parts.filter(p => p.length > 40).length, 0);

/*
 * The terminator rule, decided by the firmware rather than by a probe.
 *
 * This file previously asserted CRLF, on the strength of a one-line probe that
 * declared 28 and answered `+QFUPL: 28,6c53`. That measurement cannot support
 * the claim: the modem truncates to the size it was told, and the truncation
 * drops exactly the byte in dispute, so `line+CR` forwarded untouched and
 * `line+CRLF` forwarded as `line+CRLF` present identical first-28 bytes.
 *
 * `console-line-law.js`, disassembled from the app, settles it — the forward
 * path appends CR and LF itself (0x0801108a / 0x08011096). So a trailing LF is
 * a SECOND terminator into a handler that raises `line_ready` on either byte,
 * and whenever the main loop runs in the gap between them it dispatches the LF
 * alone: a stray CRLF into the upload and a wasted turn that eats the next
 * part. Bare CR is the reference writer's recipe and the one that produced
 * `+QFUPL: 1208,5769` over USB.
 */
check('every part ends in a bare CR',
      parts.every(p => p[p.length - 1] === 13), true);
check('no part carries any LF at all',
      parts.some(p => [...p].some(b => b === 10)), false);
check('no part carries a terminator before its own',
      parts.some(p => [...p.slice(0, -1)].some(b => b === 13 || b === 10)), false);

/*
 * What is SENT is one byte per line shorter than what is STORED, because the
 * app supplies the LF. Declaring the wire count is the failure this asserts
 * against: 1188 promised, 1208 needed, and a modem waiting forever for twenty
 * bytes that were never going to be sent.
 */
const wire = parts.reduce((n, p) => n + p.length, 0);
check('the wire form is one byte per line shorter than the stored form',
      canonical.length - wire, parts.length);
check('what the app forwards rebuilds the canonical bytes exactly',
      [...wireImage(parts)], [...canonical]);

/*
 * The law's own gate, run against the real parts. Base64 has no lowercase-only
 * alphabet and the table is matched with strstr(), so "does a PEM line happen
 * to contain an app command" is a real question and not a theoretical one.
 */
check('every CA part satisfies the console line law', checkParts(parts), []);

/* And it must actually refuse the form we just came from. */
check('the law rejects a CRLF-terminated part',
      checkPart(new TextEncoder().encode('hello\r\n')).length > 0, true);
check('the law rejects a part carrying an app command as a substring',
      checkPart(new TextEncoder().encode('somethingATZsomething\r'))
          .some(i => i.includes('ATZ')), true);

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
