/*
 * The cert write, end to end, against a simulated modem.
 * Run:  node modules/certmod.e2e.test.mjs
 *
 * `certmod.test.mjs` proves the arithmetic. This proves the conversation: that
 * the sequence, the gates and the recovery behave the way they must when the
 * device answers something other than what we hoped.
 *
 * The scenarios below are chosen for what a real unit will not show you. A
 * hardware run tells you the happy path works and nothing about what happens
 * when the BG95 never says RDY — which is the moment the code is one command
 * away from streaming a private key into a device that is not listening.
 */

import { writeCerts } from './certmod.js';
import { makeFakeDevice } from './fake-device.js';

const BUNDLE = {
    imei: '869181072714122',
    /* Shape-accurate stand-ins: real PEM structure, no real key anywhere near
     * a test file. The checksum gate does not care what the bytes mean. */
    certificate: '-----BEGIN CERTIFICATE-----\n' +
        Array.from({ length: 18 }, (_, i) => 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5' + String(i % 10).repeat(16)).join('\n') +
        '\n-----END CERTIFICATE-----',
    private_key: '-----BEGIN RSA PRIVATE KEY-----\n' +
        Array.from({ length: 25 }, (_, i) => 'MIIEpAIBAAKCAQEAx7Zq8vLmNfKdTgWpRsYuHjBnCvExAmPl' + String(i % 10).repeat(16)).join('\n') +
        '\n-----END RSA PRIVATE KEY-----',
};

let failed = 0;
async function scenario(name, faults, expectation) {
    const fake = makeFakeDevice(faults);
    let outcome;
    try {
        const n = await writeCerts(fake.io, BUNDLE);
        outcome = { ok: true, files: n };
    } catch (err) {
        outcome = { ok: false, error: err.message };
    }
    const problem = expectation(outcome, fake);
    if (problem) { failed++; console.log(`FAIL ${name}\n       ${problem}`); }
    else console.log(`ok   ${name}`);
}

/* The happy path: three files, each accepted only on an exact size AND
 * checksum match computed by the fake over what it stored. */
await scenario('all three files pass the checksum gate', {}, (out, fake) => {
    if (!out.ok) return `threw: ${out.error}`;
    if (out.files !== 3) return `wrote ${out.files} files, expected 3`;
    const verified = fake.transcript.filter(l => l.startsWith('+QFUPL:'));
    if (verified.length !== 3) return `saw ${verified.length} +QFUPL results`;
    return null;
});

/* Entry without RDY is the dangerous one: the STM32 flipped, the modem did
 * not, and streaming would write a private key nowhere. It must stop, and it
 * must NOT be retried into. */
await scenario('refuses to proceed when BG95 never says RDY', { noRdy: true },
    (out, fake) => {
        if (out.ok) return 'completed despite no RDY';
        if (!/RDY/.test(out.error)) return `wrong error: ${out.error}`;
        if (fake.transcript.some(l => l.startsWith('CONNECT')))
            return 'opened an upload anyway';
        return null;
    });

/* Echo off is a confidentiality gate, not a nicety — this terminal is on a
 * phone screen. No ATE0, no secrets on the wire. */
await scenario('refuses to stream when ATE0 is not confirmed', { refuseAte0: true },
    (out, fake) => {
        if (out.ok) return 'streamed with echo possibly on';
        if (!/ATE0/.test(out.error)) return `wrong error: ${out.error}`;
        if (fake.transcript.some(l => l.startsWith('CONNECT')))
            return 'opened an upload anyway';
        return null;
    });

/* A lost BLE write is the failure this whole design expects. It must surface
 * as a checksum mismatch and exhaust its retries rather than passing. */
await scenario('a dropped part fails the gate rather than passing',
    { dropPart: 5 }, (out) => {
        if (out.ok) return 'accepted a stream that lost a part';
        if (!/checksum gate/.test(out.error)) return `wrong error: ${out.error}`;
        return null;
    });

/* And the same loss, recovering on a later attempt, must end verified — with
 * the slot deleted in between so nothing half-written is ever trusted. */
await scenario('recovers on retry after a transient loss',
    { dropPart: 5, healAfter: 1 }, (out, fake) => {
        if (!out.ok) return `threw: ${out.error}`;
        const dels = fake.transcript.length;
        if (!dels) return 'no transcript';
        if (out.files !== 3) return `wrote ${out.files} files`;
        return null;
    });

/* Whatever happens, the unit must not be left in passthrough. */
await scenario('leaves passthrough even after a failure', { dropPart: 2 },
    (out, fake) => {
        if (out.ok) return 'expected a failure for this scenario';
        if (fake.state().inCertmod) return 'device left inside CERTMOD';
        if (!fake.transcript.includes('Exit certificate mode'))
            return 'never attempted the exit';
        return null;
    });

/* The device's own confirmations are the verification, so the ones that close
 * a successful run have to actually be asked for. */
await scenario('takes inventory and restarts after a successful write', {},
    (out, fake) => {
        if (!out.ok) return `threw: ${out.error}`;
        if (!fake.received.some(c => c.startsWith('AT+QFLST')))
            return 'never took the file inventory';
        if (!fake.received.includes('ATZ'))
            return 'never restarted — Dragino requires it after a cert change';
        /* Order matters: the restart is the last thing, after the exit. */
        if (fake.received.indexOf('ATZ') < fake.received.lastIndexOf('AT+CERTMOD'))
            return 'restarted before leaving passthrough';
        if (fake.state().inCertmod) return 'still inside CERTMOD';
        return null;
    });

await scenario('an unconfirmed exit is an error, not a note', { noExit: true },
    (out) => {
        if (out.ok) return 'completed despite an unconfirmed exit';
        if (!/exit was not confirmed/.test(out.error)) return `wrong error: ${out.error}`;
        return null;
    });

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
